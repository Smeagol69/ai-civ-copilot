import test from "node:test";
import assert from "node:assert/strict";
import { TunerClient, FrameDecoder, encodeFrame, parseOutput, parseStateList, LuaError, STATE_TTL_MS } from "../lib/tuner.mjs";
import { startFakeTuner, STATES } from "./fixtures/fake-tuner.mjs";

test("frames round-trip, including split and coalesced chunks", () => {
  const a = encodeFrame(3, "CMD:7:print(1)");
  const b = encodeFrame(4, "LSQ:");
  const dec = new FrameDecoder();
  const both = Buffer.concat([a, b]);
  assert.deepEqual(dec.push(both.subarray(0, 5)), []);
  const got = dec.push(both.subarray(5));
  assert.deepEqual(got, [{ tag: 3, payload: "CMD:7:print(1)" }, { tag: 4, payload: "LSQ:" }]);
});

test("print output and state list parse", () => {
  assert.deepEqual(parseOutput("O\0InGame: hello: world"), { state: "InGame", text: "hello: world" });
  assert.equal(parseOutput("ERR:boom"), null);
  assert.deepEqual(parseStateList("0\0Tuner\x003\0GameCore_Tuner"), [
    { index: 0, name: "Tuner" },
    { index: 3, name: "GameCore_Tuner" },
  ]);
});

test("an explicit state refresh rejects silence without reporting cached states as fresh, then retries", async () => {
  let silent = false;
  let acquired = 0, released = 0;
  const lock = { async acquire() { acquired++; }, async release() { released++; } };
  const fake = await startFakeTuner((ctx) => ctx.emit("ok"), { noisyHandshake: true, silentLsq: () => silent });
  const t = new TunerClient({ port: fake.port, lock });
  try {
    await t.connect();
    const cached = t.states;
    const cachedAt = t.statesAt = Date.now() - STATE_TTL_MS - 1;
    silent = true;
    let fresh = false;
    await assert.rejects(t.refreshStates().then((states) => { fresh = true; return states; }),
      (e) => e instanceof LuaError && e.code === "invalid-state" && /did not answer/.test(e.message));
    assert.equal(fresh, false, "the caller must not reach its successful-refresh path");
    assert.equal(t.states, cached, "keep the last observed list as historical data");
    assert.equal(t.statesAt, cachedAt, "a silent query cannot renew its age");
    assert.equal(fake.received.filter((f) => f.tag === 3).length, 0, "refresh never sends a CMD");
    assert.equal(released, acquired, "a failed refresh releases the mutex");

    silent = false;
    assert.deepEqual(await t.refreshStates(), STATES, "the next real answer is still accepted");
    assert.ok(t.statesAt > cachedAt);
    assert.deepEqual(await t.exec("InGame", "emit('ok')"), ["ok"], "the queue still works after a refused refresh");
    assert.equal(released, acquired);
  } finally {
    t.close();
    await fake.close();
  }
});

test("an explicit state refresh accepts a confirmed empty list and later replaces it", async () => {
  let states = STATES;
  const fake = await startFakeTuner(() => {}, { states: () => states });
  const t = new TunerClient({ port: fake.port, lock: false });
  try {
    await t.connect();
    const cachedAt = t.statesAt = Date.now() - STATE_TTL_MS - 1;
    states = [];
    assert.deepEqual(await t.refreshStates(), [], "an answered empty list is different from silence");
    assert.equal(t.stateIndex("InGame"), null, "old state indices are removed");
    assert.ok(t.statesAt > cachedAt, "a real answer establishes a fresh observation");
    states = STATES;
    assert.deepEqual(await t.refreshStates(), STATES);
    assert.equal(t.stateIndex("InGame"), 7);
    assert.equal(fake.received.filter((f) => f.tag === 3).length, 0);
  } finally {
    t.close();
    await fake.close();
  }
});

test("a connection lost during an explicit state refresh rejects instead of returning cached states", async () => {
  let drop = false;
  const fake = await startFakeTuner(() => {}, { silentLsq: () => {
    if (!drop) return false;
    fake.dropAll();
    return true;
  } });
  const t = new TunerClient({ port: fake.port, lock: false });
  try {
    await t.connect();
    const cached = t.states, cachedAt = t.statesAt;
    drop = true;
    await assert.rejects(t.refreshStates(), (e) => e instanceof LuaError && e.code === "lost");
    assert.equal(t.connected, false);
    assert.equal(t.states, cached);
    assert.equal(t.statesAt, cachedAt);
  } finally {
    t.close();
    await fake.close();
  }
});

test("exec collects only this call's lines and ignores print noise", async () => {
  const fake = await startFakeTuner((ctx) => {
    ctx.noise("some other mod printing");
    ctx.emit("one");
    ctx.noise("more noise");
    ctx.emit("two");
  });
  const t = new TunerClient({ port: fake.port });
  await t.connect();
  assert.equal(t.app, "Civ6 fake");
  assert.equal(t.stateIndex("InGame"), 7);
  const lines = await t.exec("InGame", "emit('one') emit('two')");
  assert.deepEqual(lines, ["one", "two"]);
  const cmd = fake.received.find((f) => f.tag === 3);
  assert.match(cmd.payload, /^CMD:7:/);
  assert.match(cmd.payload, /pcall\(function\(\) emit\('one'\)/);
  t.close();
  await fake.close();
});

test("runtime and compile errors surface as LuaError", async () => {
  let mode = "runtime";
  const fake = await startFakeTuner((ctx) => {
    if (mode === "runtime") ctx.runtimeError("attempt to index a nil value");
    else {
      ctx.compileError("[string]:1: unexpected symbol");
      return "no-end";
    }
  });
  const t = new TunerClient({ port: fake.port });
  await t.connect();
  await assert.rejects(t.exec("GameCore_Tuner", "x.y = 1"), (e) => e instanceof LuaError && e.code === "runtime" && /nil value/.test(e.message));
  mode = "compile";
  await assert.rejects(t.exec("GameCore_Tuner", "x ="), (e) => e instanceof LuaError && e.code === "compile");
  t.close();
  await fake.close();
});

test("unknown state is a clear error, and calls are serialized", async () => {
  let n = 0;
  const fake = await startFakeTuner(async (ctx) => {
    const mine = ++n;
    await new Promise((r) => setTimeout(r, 20));
    ctx.emit(`call${mine}`);
  });
  const t = new TunerClient({ port: fake.port });
  await t.connect();
  await assert.rejects(t.exec("NoSuchState", "emit(1)"), /not found/);
  const [a, b, c] = await Promise.all([t.exec("InGame", "1"), t.exec("InGame", "2"), t.exec("InGame", "3")]);
  assert.deepEqual([a, b, c], [["call1"], ["call2"], ["call3"]]);
  t.close();
  await fake.close();
});

test("connect scans past a dead preferred port (live: tuner re-bound on 4319 after a load)", async () => {
  const fake = await startFakeTuner((ctx) => ctx.emit("hi"));
  // Nothing listens one port below the fake; the client must move on.
  const t = new TunerClient({ port: fake.port - 1 });
  await t.connect(800);
  assert.equal(t.port, fake.port);
  assert.deepEqual(await t.exec("InGame", "emit('hi')"), ["hi"]);
  t.close();
  await fake.close();
});

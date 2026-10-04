import test from "node:test";
import assert from "node:assert/strict";
import { TunerClient, FrameDecoder, encodeFrame, parseOutput, parseStateList, LuaError } from "../lib/tuner.mjs";
import { startFakeTuner } from "./fixtures/fake-tuner.mjs";

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

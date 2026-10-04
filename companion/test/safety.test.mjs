// Regression tests for what the 2026-10-04 crash and the review that followed
// taught us: one caller at a time (with a lock the OS releases), calls that
// settle honestly when the connection dies or the game is slow, handshakes
// that ignore print noise, and a write-ahead record that names the culprit.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { TunerMutex, TunerClient, LuaError } from "../lib/tuner.mjs";
import { inflightTracer, suspects, unfinished } from "../lib/inflight.mjs";
import { startFakeTuner } from "./fixtures/fake-tuner.mjs";

const tmp = (name) => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "aiciv-")), name);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TUNER = fileURLToPath(new URL("../lib/tuner.mjs", import.meta.url));

async function freePort() {
  const s = net.createServer();
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  const { port } = s.address();
  await new Promise((r) => s.close(r));
  return port;
}

test("the mutex admits one holder at a time", async () => {
  const port = await freePort();
  const a = new TunerMutex({ port });
  const b = new TunerMutex({ port });
  await a.acquire();
  let bHas = false;
  const waiting = b.acquire().then(() => (bHas = true));
  await sleep(120);
  assert.equal(bHas, false, "second holder must wait");
  await a.release();
  await waiting;
  assert.equal(bHas, true);
  await b.release();
});

test("the OS frees the mutex the moment a holder process is killed", async () => {
  const port = await freePort();
  const child = spawn(process.execPath, [
    "--input-type=module",
    "-e",
    `import { TunerMutex } from ${JSON.stringify("file:///" + TUNER.replace(/\\/g, "/"))};
     const m = new TunerMutex({ port: ${port} }); await m.acquire(); console.log("held"); setInterval(() => {}, 1000);`,
  ], { stdio: ["ignore", "pipe", "inherit"] });
  await new Promise((r) => child.stdout.once("data", r));
  const m = new TunerMutex({ port });
  let got = false;
  const waiting = m.acquire().then(() => (got = true));
  await sleep(150);
  assert.equal(got, false, "held by the live child");
  child.kill("SIGKILL");
  const t0 = Date.now();
  await waiting;
  assert.ok(Date.now() - t0 < 2000, "no stale-holder timeout needed");
  await m.release();
});

test("concurrent clients never overlap inside the game", async () => {
  let inside = 0;
  let maxInside = 0;
  const fake = await startFakeTuner(async (ctx) => {
    inside++;
    maxInside = Math.max(maxInside, inside);
    await sleep(25);
    ctx.emit("x");
    inside--;
  });
  const port = await freePort();
  const clients = Array.from({ length: 4 }, () => new TunerClient({ port: fake.port, lock: new TunerMutex({ port }) }));
  for (const c of clients) await c.connect();
  await Promise.all(clients.flatMap((c) => [c.exec("InGame", "1"), c.exec("GameCore_Tuner", "2")]));
  assert.equal(maxInside, 1, "the game saw at most one command at a time");
  for (const c of clients) c.close();
  await fake.close();
});

test("a dropped connection fails the running call at once and records it as lost", async () => {
  const file = tmp("inflight.jsonl");
  const fake = await startFakeTuner(() => "no-end");
  const t = new TunerClient({ port: fake.port, lock: false, trace: inflightTracer(file) });
  await t.connect();
  const call = t.exec("GameCore_Tuner", "local P = {}\nRiverManager.GetRiverByIndex(99, 'plots')", { label: "culprit", timeoutMs: 60000 });
  await sleep(50);
  const t0 = Date.now();
  fake.dropAll();
  await assert.rejects(call, (e) => e instanceof LuaError && e.code === "lost");
  assert.ok(Date.now() - t0 < 1000, "woken by the close, not by the 60 s timeout");
  const s = suspects(file);
  assert.equal(s.length, 1);
  assert.equal(s[0].status, "lost");
  assert.equal(s[0].label, "culprit");
  assert.match(s[0].body, /GetRiverByIndex/);
  assert.equal(s[0].pidAlive, true);
  await fake.close();
});

test("a slow call that finishes inside the grace period succeeds; one that never finishes resets the connection", async () => {
  const file = tmp("inflight.jsonl");
  let mode = "slow";
  const fake = await startFakeTuner(async (ctx) => {
    if (mode === "slow") {
      await sleep(250);
      ctx.emit("done");
      return;
    }
    return "no-end";
  });
  const t = new TunerClient({ port: fake.port, lock: false, trace: inflightTracer(file), lateGraceMs: 400 });
  await t.connect();
  assert.deepEqual(await t.exec("InGame", "slow()", { timeoutMs: 100 }), ["done"]);
  mode = "hang";
  await assert.rejects(t.exec("InGame", "hang()", { timeoutMs: 100, label: "hang" }), (e) => e.code === "timeout" && e.outcome === "unknown");
  assert.equal(t.connected, false, "an unsettled connection is not reused");
  assert.equal(suspects(file).at(-1).status, "unknown");
  assert.deepEqual(unfinished(file), []);
  await fake.close();
});

test("print output before a handshake reply does not empty the state list", async () => {
  const fake = await startFakeTuner((ctx) => ctx.emit("ok"), { noisyHandshake: true });
  const t = new TunerClient({ port: fake.port, lock: false });
  await t.connect();
  assert.equal(t.app, "Civ6 fake");
  assert.equal(t.stateIndex("InGame"), 7);
  assert.equal((await t.refreshStates()).length, 3);
  assert.deepEqual(await t.exec("InGame", "emit('ok')"), ["ok"]);
  t.close();
  await fake.close();
});

test("the port scan skips a port that accepts but never answers", async () => {
  const silentSockets = new Set();
  const silent = net.createServer((s) => silentSockets.add(s));
  await new Promise((r) => silent.listen(0, "127.0.0.1", r));
  const fake = await startFakeTuner((ctx) => ctx.emit("hi"));
  // Preferred port is the silent one; the fake is reachable through the scan
  // only if it sits in range, so point basePort at it and port at the silent.
  const t = new TunerClient({ port: silent.address().port, lock: false });
  t.basePort = fake.port;
  await t.connect(1000);
  assert.equal(t.port, fake.port);
  assert.deepEqual(await t.exec("InGame", "x"), ["hi"]);
  t.close();
  for (const s of silentSockets) s.destroy();
  silent.close();
  await fake.close();
});

test("concurrent connect() calls share one connection", async () => {
  const fake = await startFakeTuner((ctx) => ctx.emit("x"));
  const t = new TunerClient({ port: fake.port, lock: false });
  await Promise.all([t.connect(), t.connect(), t.connect()]);
  assert.equal(fake.connections, 1);
  t.close();
  await fake.close();
});

test("traces are paired by pid and id, and the prelude is not stored", () => {
  const file = tmp("inflight.jsonl");
  const trace = inflightTracer(file);
  trace({ phase: "start", id: "a", pid: 1, state: "InGame", body: "PRELUDE\nlocal P = {}\nemit(1)" });
  trace({ phase: "end", id: "a", pid: 1 });
  trace({ phase: "start", id: "b", pid: 4242424, state: "GameCore_Tuner", label: "lua", body: "PRELUDE\nlocal P = {}\nUnitManager.Kill(x)" });
  const s = suspects(file);
  assert.equal(s.length, 1);
  assert.equal(s[0].status, "in-flight");
  assert.equal(s[0].body, "local P = {}\nUnitManager.Kill(x)");
  assert.equal(s[0].pidAlive, false);
});

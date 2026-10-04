// Regression tests for what the 2026-10-04 crash taught us: one caller at a
// time, a write-ahead record of every call, and actions that do not wipe the
// player's plans.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TunerLock, TunerClient } from "../lib/tuner.mjs";
import { inflightTracer, unfinished } from "../lib/inflight.mjs";
import { performAction, validateAction, ACTIONS } from "../lib/actions.mjs";
import { Game, loadLua } from "../lib/game.mjs";
import { startFakeTuner } from "./fixtures/fake-tuner.mjs";

const tmp = (name) => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "aiciv-")), name);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("the tuner lock admits one holder at a time", async () => {
  const file = tmp("t.lock");
  const a = new TunerLock(file);
  const b = new TunerLock(file);
  await a.acquire(10000);
  let bHas = false;
  const waiting = b.acquire(10000).then(() => (bHas = true));
  await sleep(80);
  assert.equal(bHas, false, "second holder must wait");
  a.release();
  await waiting;
  assert.equal(bHas, true);
  b.release();
  assert.equal(fs.existsSync(file), false);
});

test("a lock left by a dead process or past its hold time is evicted", async () => {
  const file = tmp("t.lock");
  fs.writeFileSync(file, JSON.stringify({ pid: 999999, until: Date.now() + 60000 }));
  const t0 = Date.now();
  await new TunerLock(file).acquire(1000);
  assert.ok(Date.now() - t0 < 1000, "dead pid evicted at once");
  fs.writeFileSync(file, JSON.stringify({ pid: process.pid, until: Date.now() - 1 }));
  await new TunerLock(file).acquire(1000);
  assert.ok(true, "expired hold evicted");
});

test("concurrent clients on one port never overlap inside the game", async () => {
  let inside = 0;
  let maxInside = 0;
  const fake = await startFakeTuner(async (ctx) => {
    inside++;
    maxInside = Math.max(maxInside, inside);
    await sleep(30);
    ctx.emit("x");
    inside--;
  });
  const lock = new TunerLock(tmp("c.lock"));
  const clients = Array.from({ length: 4 }, () => new TunerClient({ port: fake.port, lock }));
  for (const c of clients) await c.connect();
  await Promise.all(clients.flatMap((c) => [c.exec("InGame", "1"), c.exec("GameCore_Tuner", "2")]));
  assert.equal(maxInside, 1, "the game saw at most one command at a time");
  for (const c of clients) c.close();
  await fake.close();
});

test("every call is traced before it is sent, and finished calls close out", async () => {
  const file = tmp("inflight.jsonl");
  const trace = inflightTracer(file);
  let mode = "ok";
  const fake = await startFakeTuner((ctx) => {
    if (mode === "ok") ctx.emit("done");
    else if (mode === "hang") return "no-end";
  });
  const t = new TunerClient({ port: fake.port, lock: false, trace });
  await t.connect();
  await t.exec("InGame", "local P = {}\nemit('done')", { label: "probe-ok" });
  assert.deepEqual(unfinished(file), []);
  mode = "hang";
  await assert.rejects(t.exec("GameCore_Tuner", "local P = {}\nRiverManager.GetRiverByIndex(99, 'plots')", { label: "probe-hang", timeoutMs: 200 }));
  // A timeout is recorded as an error, so it is not "in flight"...
  assert.deepEqual(unfinished(file), []);
  // ...but a start with no finish (the process died mid-call) is.
  trace({ phase: "start", id: "zz", pid: 4242, state: "GameCore_Tuner", label: "lua", body: "PRELUDE\nlocal P = {}\nUnitManager.Kill(x)" });
  const open = unfinished(file);
  assert.equal(open.length, 1);
  assert.equal(open[0].body, "local P = {}\nUnitManager.Kill(x)", "the prelude is not stored");
  t.close();
  await fake.close();
});

test("a play action's read-back is retried before it is called a failure", async () => {
  let reads = 0;
  const fake = await startFakeTuner((ctx) => {
    const action = /action="([a-z_]+)"/.exec(ctx.lua)?.[1];
    if (action === "set_civic") ctx.emitJson({ ok: true, requested: true, queueBefore: ["CIVIC_A", "CIVIC_B"] });
    else ctx.emitJson(++reads < 2 ? { ok: false } : { ok: true, queueKept: true });
  });
  const game = new Game({ port: fake.port, trace: false });
  const r = await performAction(game, "set_civic", { civic: "CIVIC_HUMANISM" });
  assert.equal(r.ok, true);
  assert.equal(r.verified.attempts, 2);
  assert.match(fake.received.filter((f) => f.tag === 3).at(-1).payload, /queueBefore=\{"CIVIC_A","CIVIC_B"\}/, "the old queue is passed to the read-back");
  game.tuner.close();
  await fake.close();
});

test("research and civics keep the player's queue by default and accept far targets", () => {
  const lua = loadLua("actions");
  assert.match(lua, /GetResearchPath\(h\)/);
  assert.match(lua, /GetCivicPath\(h\)/);
  assert.match(lua, /local mode = P\.mode or 'front'/);
  assert.doesNotMatch(lua, /CanResearch\(row\.Index\)\) then return fail\('prerequisites not met'\)/, "far targets are not refused");
  assert.deepEqual(ACTIONS.set_research.properties.mode.enum, ["front", "replace", "append"]);
  assert.equal(validateAction("set_research", { tech: "TECH_X", mode: "front" }).ok, true);
  assert.match(validateAction("set_civic", { civic: "CIVIC_X", mode: "wipe" }).reason, /mode must be string/);
});

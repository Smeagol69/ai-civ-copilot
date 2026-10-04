// Every engine call an action makes must exist in the Lua state that action
// runs in. Checked against the API catalogs scanned from the live game
// (companion/data/api-catalog, written by scan_api; skipped if absent).
// This is the class of bug that shipped once already: finish_production
// called BuildQueue:GetSize, which exists in InGame but not in GameCore.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { ACTIONS, ACTION_QUERIES, validateAction, performAction } from "../lib/actions.mjs";
import { loadLua, Game } from "../lib/game.mjs";
import { startFakeTuner } from "./fixtures/fake-tuner.mjs";

const CATALOG_DIR = new URL("../data/api-catalog/", import.meta.url);
const catalogs = {};
for (const state of ["InGame", "GameCore_Tuner"]) {
  const f = new URL(`${state}.json`, CATALOG_DIR);
  if (fs.existsSync(f)) catalogs[state] = JSON.parse(fs.readFileSync(f, "utf8"));
}

// Split actions.lua into `function A.<name>(P) ... end` bodies.
function actionBodies() {
  const src = loadLua("actions");
  const out = {};
  const re = /^function A\.([a-z_]+)\(P\)([\s\S]*?)(?=^function A\.|^local fn = A\[)/gm;
  for (const m of src.matchAll(re)) out[m[1]] = m[2];
  return out;
}

// Lua methods and globals that are not engine API.
const NOT_ENGINE = new Set(["string", "table", "math", "pairs", "ipairs", "type", "tostring", "tonumber", "pcall", "next", "select"]);
const LOCAL_TABLES = new Set(["GameInfo", "Players", "PlayersVisibility", "PlayerConfigurations", "spec", "P", "o", "results", "res"]);

test("every engine call in an action exists in that action's Lua state", { skip: !catalogs.InGame || !catalogs.GameCore_Tuner ? "no live API catalog" : false }, () => {
  const bodies = actionBodies();
  const problems = [];
  for (const [name, body] of Object.entries(bodies)) {
    const base = name.replace(/^verify_/, "");
    const def = ACTIONS[base] || ACTION_QUERIES[base];
    if (!def) continue;
    const cat = catalogs[def.state];
    const methods = new Set(Object.values(cat.objects || {}).flat());
    const code = body.replace(/--[^\n]*/g, "").replace(/'[^'\n]*'|"[^"\n]*"/g, "''");
    for (const m of code.matchAll(/:([A-Z][A-Za-z0-9_]*)\(/g)) {
      if (!methods.has(m[1])) problems.push(`${name} [${def.state}] :${m[1]}()`);
    }
    for (const m of code.matchAll(/\b([A-Z][A-Za-z0-9_]*)\.([A-Za-z][A-Za-z0-9_]*)\b/g)) {
      const [, holder, member] = m;
      if (NOT_ENGINE.has(holder) || LOCAL_TABLES.has(holder)) continue;
      const g = cat.globals?.[holder];
      const e = cat.enums?.[holder];
      if (Array.isArray(g) ? g.includes(member) : false) continue;
      if (e && member in e) continue;
      if (g === "table") continue; // a table of non-functions the scan did not list
      problems.push(`${name} [${def.state}] ${holder}.${member}`);
    }
  }
  assert.deepEqual(problems, [], `calls missing from the live catalog:\n${problems.join("\n")}`);
});

test("production keeps the city's queue unless exclusive is asked for", () => {
  const body = actionBodies().set_production;
  assert.match(body, /VALUE_REPLACE_AT/);
  assert.match(body, /PARAM_QUEUE_DESTINATION_LOCATION\] = 0/);
  assert.match(body, /mode == 'exclusive'/);
  assert.equal(validateAction("set_production", { cityId: 1, item: "UNIT_SCOUT", mode: "append" }).ok, true);
  assert.match(validateAction("set_production", { cityId: 1, item: "UNIT_SCOUT", mode: "wipe" }).reason, /mode must be string/);
});

test("risky edits copy Firaxis' call shapes", () => {
  const b = actionBodies();
  assert.match(b.declare_war, /CanDeclareWarOn\(other, warType, true\)/);
  assert.match(b.declare_war, /DeclareWarOn\(other, warType, true\)/);
  assert.match(b.unit_command, /PARAM_PROMOTION_TYPE\] = pr\.Index/);
  assert.match(b.spawn_unit, /InitUnitValidAdjacentHex\(pid, P\.unitType, P\.x, P\.y, radius\)/);
  assert.doesNotMatch(b.spawn_unit, /UnitManager\.InitUnit\(/, "no blind fallback that can double-spawn");
  assert.match(b.restore_moves, /RestoreMovementToFormation/);
  assert.match(b.grant_tech, /SetResearchProgress/);
  assert.match(b.make_peace, /experimental ~= true/);
  assert.match(b.unit_operation, /startsWar/);
});

test("verify gets the action's verifyArgs; they are not shown to the caller", async () => {
  const seen = [];
  const fake = await startFakeTuner((ctx) => {
    const action = /action="([a-z_]+)"/.exec(ctx.lua)?.[1];
    seen.push(ctx.lua);
    if (action === "end_turn") ctx.emitJson({ ok: true, requested: true, turn: 271, verifyArgs: { turn: 271 } });
    else ctx.emitJson({ ok: true, turnNow: 272 });
  });
  const game = new Game({ port: fake.port, trace: false });
  const r = await performAction(game, "end_turn", {}, { verifyDelayMs: 1 });
  assert.equal(r.ok, true);
  assert.equal(r.verifyArgs, undefined);
  assert.match(seen.at(-1), /turn=271/);
  game.tuner.close();
  await fake.close();
});

test("a dead connection during read-back stops the retries", async () => {
  let calls = 0;
  const fake = await startFakeTuner((ctx) => {
    calls++;
    if (calls === 1) {
      ctx.emitJson({ ok: true, requested: true, verifyArgs: { mode: "front" } });
      return;
    }
    fake.dropAll();
    return "no-end";
  });
  const game = new Game({ port: fake.port, trace: false });
  const r = await performAction(game, "set_civic", { civic: "CIVIC_HUMANISM" });
  assert.equal(r.ok, false);
  assert.equal(r.verified.transportError, true);
  assert.equal(r.verified.attempts, 1, "no further calls on a dead link");
  game.tuner.close();
  await fake.close();
});

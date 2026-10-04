import test from "node:test";
import assert from "node:assert/strict";
import { ACTIONS, validateAction, performAction } from "../lib/actions.mjs";
import { Game, loadLua } from "../lib/game.mjs";
import { startFakeTuner } from "./fixtures/fake-tuner.mjs";

test("every catalog action has a Lua implementation, and every play action a read-back", () => {
  const lua = loadLua("actions");
  for (const [name, def] of Object.entries(ACTIONS)) {
    assert.match(lua, new RegExp(`function A\\.${name}\\(P\\)`), `missing A.${name}`);
    if (def.kind === "play" && !def.noVerify) assert.match(lua, new RegExp(`function A\\.verify_${name}\\(P\\)`), `missing verify_${name}`);
    assert.ok(["play", "edit"].includes(def.kind));
    assert.ok(def.state === "InGame" || def.state === "GameCore_Tuner");
    for (const r of def.required) assert.ok(def.properties[r], `${name}: required ${r} not declared`);
  }
});

test("play actions run in InGame, edits in GameCore", () => {
  assert.equal(ACTIONS.set_production.state, "InGame");
  assert.equal(ACTIONS.move_unit.state, "InGame");
  assert.equal(ACTIONS.change_gold.state, "GameCore_Tuner");
  assert.equal(ACTIONS.spawn_unit.state, "GameCore_Tuner");
});

test("validation refuses the whole action on any bad field", () => {
  assert.equal(validateAction("change_gold", { amount: 100 }).ok, true);
  assert.match(validateAction("change_gold", {}).reason, /missing amount/);
  assert.match(validateAction("move_unit", { unitId: 1, x: 3 }).reason, /missing y/);
  assert.match(validateAction("move_unit", { unitId: 1.5, x: 3, y: 4 }).reason, /unitId must be integer/);
  assert.match(validateAction("change_gold", { amount: 1, sneaky: true }).reason, /unknown parameter sneaky/);
  assert.match(validateAction("purchase", { cityId: 1, item: "UNIT_SETTLER", yield: "YIELD_SCIENCE" }).reason, /yield must be string/);
  assert.match(validateAction("teleport", {}).reason, /unknown action/);
});

test("a play action is only ok once the game's read-back confirms it", async () => {
  let readback = { ok: false, researching: "TECH_POTTERY" };
  const fake = await startFakeTuner((ctx) => {
    const action = /local P = \{[^\n]*action="([a-z_]+)"/.exec(ctx.lua)?.[1];
    if (action === "set_research") ctx.emitJson({ ok: true, requested: true, turns: 4 });
    else if (action === "verify_set_research") ctx.emitJson(readback);
  });
  const game = new Game({ port: fake.port });
  const journal = { entries: [], record(e) { this.entries.push(e); } };

  const failed = await performAction(game, "set_research", { tech: "TECH_PRINTING" }, { journal, verifyDelayMs: 1 });
  assert.equal(failed.ok, false);
  assert.match(failed.reason, /does not show it took effect/);

  readback = { ok: true, researching: "TECH_PRINTING" };
  const done = await performAction(game, "set_research", { tech: "TECH_PRINTING" }, { journal, verifyDelayMs: 1 });
  assert.equal(done.ok, true);
  assert.equal(done.verified.researching, "TECH_PRINTING");
  assert.equal(journal.entries.length, 2);

  game.tuner.close();
  await fake.close();
});

test("edit actions run in GameCore and report the game's before/after", async () => {
  const fake = await startFakeTuner((ctx) => {
    assert.equal(ctx.state, "GameCore_Tuner");
    ctx.emitJson({ ok: true, before: 100, after: 600 });
  });
  const game = new Game({ port: fake.port });
  const r = await performAction(game, "change_gold", { amount: 500 }, { verifyDelayMs: 1 });
  assert.deepEqual([r.ok, r.before, r.after, r.kind], [true, 100, 600, "edit"]);
  assert.equal(r.verified, undefined, "edits are synchronous: no separate read-back");
  game.tuner.close();
  await fake.close();
});

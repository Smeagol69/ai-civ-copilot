// The in-game panel's buttons and the bridge's handlers must agree: every
// button the panel can send has a handler, every handler that changes the
// game sends a typed action that passes validation, and selection-based
// buttons refuse cleanly without a selection.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HANDLERS, AI_PROMPTS, handlePanelRequest, formatAction, abilityButtons } from "../lib/panel.mjs";
import { Game } from "../lib/game.mjs";
import { Memory } from "../lib/memory.mjs";
import { ACTIONS, ACTION_QUERIES, validateAction } from "../lib/actions.mjs";
import { startFakeTuner } from "./fixtures/fake-tuner.mjs";
import { SNAP } from "./fixtures/snapshot.mjs";

const PANEL_LUA = fs.readFileSync(new URL("../../mod/AICivCopilot/UI/AICivCopilotPanel.lua", import.meta.url), "utf8");

// Button entries look like { key = "x", label = "...", ... tip = "..." }.
function panelButtonKeys() {
  const keys = [];
  for (const line of PANEL_LUA.split("\n")) {
    const m = /\{\s*key\s*=\s*"([a-z0-9_]+)",\s*label\s*=/.exec(line);
    if (m && !/buttons\s*=/.test(line) && !/localToggle/.test(line)) keys.push(m[1]);
  }
  return keys;
}

const SEL = { cityId: 65536, cityOwner: 0, cityName: "Rome", unitId: 3, unitOwner: 0, unitType: "UNIT_KNIGHT", unitName: "Knight", x: 15, y: 12 };

test("every panel button has a bridge handler", () => {
  const keys = panelButtonKeys();
  assert.ok(keys.length >= 40, `found only ${keys.length} buttons in the panel`);
  const missing = keys.filter((k) => !HANDLERS[k] && !AI_PROMPTS[k]);
  assert.deepEqual(missing, [], `buttons with no handler: ${missing.join(", ")}`);
});

test("selection buttons refuse cleanly with nothing selected", async () => {
  for (const [key, h] of Object.entries(HANDLERS)) {
    if (!h.needs) continue;
    const r = await handlePanelRequest({}, { key, sel: {} });
    assert.equal(r.kind, "error", key);
    assert.match(r.text, new RegExp(`Select a ${h.needs}`), key);
  }
  assert.equal((await handlePanelRequest({}, { key: "city_ai", sel: {} }, { ask: async () => ({}) })).kind, "error");
});

test("AI buttons send a preset question that carries the selection", async () => {
  const asked = [];
  const ask = async (q) => (asked.push(q), { answer: "ok" });
  for (const key of Object.keys(AI_PROMPTS)) {
    const r = await handlePanelRequest({}, { key, sel: SEL }, { ask });
    assert.equal(r.text, "ok", key);
  }
  assert.match(asked.find((q) => /What should this city build/.test(q)), /city Rome \(id 65536/);
  assert.match(asked.find((q) => /best use of this unit/.test(q)), /unit Knight UNIT_KNIGHT \(id 3/);
});

test("instant info buttons answer from the snapshot without touching the game", async () => {
  const memory = new Memory(fs.mkdtempSync(path.join(os.tmpdir(), "aiciv-")));
  const ctx = { memory, snapshot: async () => SNAP, markStale() {}, game: { lua: async () => ({ value: { techs: ["TECH_PRINTING", "TECH_BANKING"], civics: [] } }) } };
  for (const key of ["overview", "production", "threats", "idle", "rivals", "turnbrief", "resources", "researchqueue", "recent", "city_details"]) {
    const r = await handlePanelRequest(ctx, { key, sel: SEL });
    assert.ok(r.text && !r.kind, `${key}: ${JSON.stringify(r)}`);
  }
  assert.match((await handlePanelRequest(ctx, { key: "overview" })).text, /Rome \(Trajan\), turn 120/);
  assert.match((await handlePanelRequest(ctx, { key: "production" })).text, /Antium: IDLE/);
  assert.match((await handlePanelRequest(ctx, { key: "turnbrief" })).text, /Idle cities: Antium/);
  assert.match((await handlePanelRequest(ctx, { key: "researchqueue" })).text, /then Banking/);
});

test("every action button sends a typed action that passes validation", async () => {
  const seen = [];
  const fake = await startFakeTuner((ctx) => {
    const action = /action="([a-z_]+)"/.exec(ctx.lua)?.[1];
    seen.push({ action, lua: ctx.lua });
    if (action === "unit_actions") ctx.emitJson({ ok: true, operations: ["UNITOPERATION_FORTIFY"], commands: ["UNITCOMMAND_DELETE"] });
    else if (action?.startsWith("verify_")) ctx.emitJson({ ok: true });
    else ctx.emitJson({ ok: true, requested: true, before: 1, after: 2 });
  });
  const game = new Game({ port: fake.port, trace: false });
  const memory = new Memory(fs.mkdtempSync(path.join(os.tmpdir(), "aiciv-")));
  const ctx = { game, memory, snapshot: async () => SNAP, markStale() {}, onProgress() {} };
  const actionKeys = Object.keys(HANDLERS).filter((k) => !["overview", "production", "threats", "idle", "rivals", "turnbrief", "resources", "researchqueue", "recent", "city_details", "city_tiles", "tile_info", "abilities_list", "standing", "events", "situation", "game_advisor", "city_advice", "settle_spots", "builder_advice", "attack_odds", "eurekas", "great_people", "city_states", "district_spots", "dig_map", "dig_probe", "dig_frontier", "dig_status"].includes(k));
  for (const key of actionKeys) {
    const before = seen.length;
    const r = await handlePanelRequest(ctx, { key, sel: SEL });
    assert.ok(!r.kind, `${key}: ${r.text}`);
    assert.doesNotMatch(r.text, /not done/, `${key}: ${r.text}`);
    const sent = seen.slice(before).map((s) => s.action).filter((a) => a && !a.startsWith("verify_"));
    assert.ok(sent.length, `${key} sent nothing to the game`);
    for (const a of sent) assert.ok(ACTIONS[a] || ACTION_QUERIES[a], `${key} sent unknown action ${a}`);
  }
  const ops = await handlePanelRequest(ctx, { key: "unit_ops", sel: SEL });
  assert.deepEqual(ops.buttons.items.map((i) => i.key), ["unitop:UNITOPERATION_FORTIFY", "unitcmd:UNITCOMMAND_DELETE"]);
  assert.equal(ops.buttons.items[1].confirm, true, "deleting asks to confirm");
  const r = await handlePanelRequest(ctx, { key: "unitop:UNITOPERATION_FORTIFY", sel: SEL });
  assert.match(r.text, /Fortify: done/);
  game.tuner.close();
  await fake.close();
});

test("the arguments each action button builds are valid for its action", () => {
  // Same shapes the handlers build, checked against the action schemas.
  assert.equal(validateAction("unit_operation", { unitId: 3, operation: "UNITOPERATION_SLEEP" }).ok, true);
  assert.equal(validateAction("unit_actions", { unitId: 3 }).ok, true);
  assert.equal(validateAction("heal_unit", { unitId: 3, playerId: 0, damage: 0 }).ok, true);
  assert.equal(validateAction("change_population", { cityId: 65536, playerId: 0, delta: -1 }).ok, true);
  assert.equal(validateAction("spawn_unit", { unitType: "UNIT_SETTLER", x: 15, y: 12 }).ok, true);
  assert.equal(validateAction("look_at", { x: 15, y: 12 }).ok, true);
});

test("abilities become buttons, and their parameters come from the selection", async () => {
  const memory = new Memory(fs.mkdtempSync(path.join(os.tmpdir(), "aiciv-")));
  memory.saveAbility({ name: "city_report", description: "A report about one city.", state: "InGame", lua: "emitJson({ok=true,id=P.cityId})", properties: { cityId: { type: "integer" } }, required: ["cityId"] });
  memory.saveAbility({ name: "double_gold", description: "Doubles the treasury.", state: "GameCore_Tuner", lua: "emitJson({ok=true})", kind: "edit" });
  const items = abilityButtons(memory);
  assert.deepEqual(items.map((i) => i.key), ["ability:city_report", "ability:double_gold"]);
  assert.equal(items[1].confirm, true, "abilities that change the game ask to confirm");
  const calls = [];
  const ctx = { memory, markStale() {}, onProgress() {}, game: { lua: async (state, code, opts) => (calls.push(opts.params), { value: { ok: true, id: opts.params.cityId }, text: [] }) } };
  const r = await handlePanelRequest(ctx, { key: "ability:city_report", sel: SEL });
  assert.match(r.text, /"id": 65536/);
  const missing = await handlePanelRequest(ctx, { key: "ability:city_report", sel: {} });
  assert.equal(missing.kind, "error");
  assert.match(missing.text, /needs: cityId/);
});

test("action results read as one plain line", () => {
  assert.equal(formatAction("+100 Gold", { ok: true, before: 32.51, after: 132.51 }), "+100 Gold: done (32.5 -> 132.5).");
  assert.equal(formatAction("Finish build", { ok: false, reason: "city is not producing anything" }), "Finish build: not done - city is not producing anything.");
  assert.match(formatAction("End turn", { ok: true, verified: { ok: true, turnNow: 272 } }), /now turn 272/);
});

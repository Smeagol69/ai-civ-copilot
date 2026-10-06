import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Memory } from "../lib/memory.mjs";
import { allTools, runTool, STATIC_TOOLS } from "../lib/tools.mjs";
import { SNAP } from "./fixtures/snapshot.mjs";

function tmpMemory() {
  return new Memory(fs.mkdtempSync(path.join(os.tmpdir(), "aiciv-")));
}

function fakeCtx(memory, luaImpl = async () => ({ value: { ok: true }, text: [] })) {
  const calls = [];
  let stale = 0;
  return {
    calls,
    get staleCount() { return stale; },
    memory,
    files: { search: () => ({ hits: [] }), read: () => ({}) },
    game: {
      lua: async (state, code, opts) => (calls.push({ state, code, params: opts?.params }), luaImpl(state, code, opts)),
      states: async () => [{ index: 7, name: "InGame" }],
    },
    markStale() { stale++; },
    async snapshot() { return SNAP; },
  };
}

test("tool names are unique and schemas are objects", () => {
  const names = STATIC_TOOLS.map((t) => t.name);
  assert.equal(new Set(names).size, names.length);
  for (const t of STATIC_TOOLS) assert.equal(t.input_schema.type, "object", t.name);
});

test("save_ability test-runs first, then becomes a callable tool", async () => {
  const memory = tmpMemory();
  const ctx = fakeCtx(memory, async (state, code, opts) => ({ value: { ok: true, amenities: 3, cityId: opts.params.cityId }, text: [] }));

  const saved = JSON.parse((await runTool(ctx, "save_ability", {
    name: "city_amenity_breakdown",
    description: "Where a city's amenities come from, by source.",
    state: "InGame",
    lua: "emitJson({ok=true, cityId=P.cityId})",
    parameters: { cityId: { type: "integer" } },
    required: ["cityId"],
    test_params: { cityId: 65536 },
  })).content);
  assert.equal(saved.saved, true);
  assert.equal(saved.tool, "ability__city_amenity_breakdown");
  assert.equal(ctx.calls[0].params.cityId, 65536, "test run happened before save");

  const tool = allTools(memory).find((t) => t.name === "ability__city_amenity_breakdown");
  assert.ok(tool, "saved ability is offered as a tool");
  assert.deepEqual(tool.input_schema.required, ["cityId"]);

  const used = JSON.parse((await runTool(ctx, "ability__city_amenity_breakdown", { cityId: 131073 })).content);
  assert.equal(used.ok, true);
  assert.equal(used.value.cityId, 131073);
  assert.equal(memory.getAbility("city_amenity_breakdown").uses, 1);
});

test("an ability whose test run fails is not saved", async () => {
  const memory = tmpMemory();
  const ctx = fakeCtx(memory, async () => { throw new Error("attempt to call a nil value (method 'GetNope')"); });
  const r = JSON.parse((await runTool(ctx, "save_ability", {
    name: "broken_probe", description: "This one does not work at all.", state: "InGame", lua: "x:GetNope()", test_params: {},
  })).content);
  assert.equal(r.saved, false);
  assert.match(r.reason, /GetNope/);
  assert.equal(memory.listAbilities().length, 0);
});

test("re-saving an ability keeps the previous version", () => {
  const memory = tmpMemory();
  memory.saveAbility({ name: "probe_one", description: "first version of the probe", state: "InGame", lua: "emit(1)" });
  const r = memory.saveAbility({ name: "probe_one", description: "second version of the probe", state: "InGame", lua: "emit(2)" });
  assert.equal(r.history.length, 1);
  assert.equal(r.history[0].lua, "emit(1)");
  assert.throws(() => memory.saveAbility({ name: "Bad Name", description: "xxxxxxxxxxxx", state: "InGame", lua: "x" }), /lower_snake_case/);
});

test("knowledge and journal persist", () => {
  const memory = tmpMemory();
  memory.remember("SetCivic works in GameCore_Tuner", { topic: "culture" });
  assert.match(memory.knowledgeForPrompt(), /\(culture\) SetCivic works/);
  memory.record({ type: "action", action: "change_gold", ok: true });
  assert.equal(memory.recentJournal(5)[0].action, "change_gold");
});

test("catalog search finds methods, enums and tables", () => {
  const memory = tmpMemory();
  memory.saveCatalog("GameCore_Tuner", {
    globals: { UnitManager: ["InitUnit", "Kill"], Map: ["GetPlot"] },
    objects: { "Player:GetTreasury": ["ChangeGoldBalance", "GetGoldBalance"] },
    enums: { DefenseTypes: { DISTRICT_GARRISON: 0 } },
    gameInfoTables: ["Units", "UnitPromotions"],
  });
  const r = memory.searchCatalog("gold");
  assert.ok(r.hits.some((h) => h.includes("<Player:GetTreasury>:ChangeGoldBalance")));
  assert.ok(memory.searchCatalog("/^Init/").hits.some((h) => h.includes("UnitManager.InitUnit")));
  assert.ok(memory.searchCatalog("garrison").hits.some((h) => h.includes("DefenseTypes.DISTRICT_GARRISON = 0")));
  assert.ok(memory.searchCatalog("promotion").hits.some((h) => h.includes("GameInfo.UnitPromotions")));
});

test("run_lua journals the code and marks the snapshot stale", async () => {
  const memory = tmpMemory();
  const ctx = fakeCtx(memory, async () => ({ value: { gold: 9000 }, text: ["hi"] }));
  const r = JSON.parse((await runTool(ctx, "run_lua", { state: "GameCore_Tuner", code: "Players[0]:GetTreasury():ChangeGoldBalance(1)" })).content);
  assert.equal(r.ok, true);
  assert.equal(ctx.staleCount, 1);
  assert.match(memory.recentJournal(1)[0].code, /ChangeGoldBalance/);
});

test("run_lua also marks the snapshot stale when the reply is lost after it may have run", async () => {
  const memory = tmpMemory();
  const ctx = fakeCtx(memory, async () => { throw Object.assign(new Error("Lua in InGame did not finish within 15000 ms"), { code: "timeout" }); });
  const r = JSON.parse((await runTool(ctx, "run_lua", { state: "GameCore_Tuner", code: "Players[0]:GetTreasury():ChangeGoldBalance(1)" })).content);
  assert.equal(r.ok, false);
  assert.equal(ctx.staleCount, 1, "a timeout may mean the write landed - the cache must not be trusted");
});

test("run_lua does not mark the snapshot stale when the call never reached the game", async () => {
  const memory = tmpMemory();
  const ctx = fakeCtx(memory, async () => { throw Object.assign(new Error('Lua state "InGame" not found. Is a game loaded?'), { code: "not-found" }); });
  const r = JSON.parse((await runTool(ctx, "run_lua", { state: "InGame", code: "emit(1)" })).content);
  assert.equal(r.ok, false);
  assert.equal(ctx.staleCount, 0, "a call that definitely never reached the game leaves the cache valid");
});

test("save_ability's own test run marks the snapshot stale when a write's reply is lost", async () => {
  const memory = tmpMemory();
  const ctx = fakeCtx(memory, async () => { throw Object.assign(new Error("tuner reset mid-call"), { code: "timeout" }); });
  const r = JSON.parse((await runTool(ctx, "save_ability", {
    name: "risky_test_run", description: "Writes something.", state: "GameCore_Tuner", lua: "Players[0]:GetTreasury():ChangeGoldBalance(P.amount)",
    parameters: { amount: { type: "integer" } }, required: ["amount"], kind: "play", test_params: { amount: 1 },
  })).content);
  assert.equal(r.saved, false);
  assert.equal(ctx.staleCount, 1, "the test run's own write may have landed before the timeout");
});

test("a saved ability also marks the snapshot stale when its reply is lost after it may have run", async () => {
  const memory = tmpMemory();
  let calls = 0;
  const ctx = fakeCtx(memory, async () => {
    calls++;
    if (calls === 1) return { value: { ok: true }, text: [] }; // the test run, while saving
    throw Object.assign(new Error("a reply from the wrong Lua state"), { code: "wrong-state" });
  });
  await runTool(ctx, "save_ability", {
    name: "risky_write", description: "Writes something.", state: "GameCore_Tuner", lua: "Players[0]:GetTreasury():ChangeGoldBalance(P.amount)",
    parameters: { amount: { type: "integer" } }, required: ["amount"], kind: "play", test_params: { amount: 1 },
  });
  const staleAfterSave = ctx.staleCount;
  const r = JSON.parse((await runTool(ctx, "ability__risky_write", { amount: 5 })).content);
  assert.equal(r.ok, false);
  assert.equal(ctx.staleCount - staleAfterSave, 1, "wrong-state on a play ability may mean it ran before the reply was misrouted");
});

test("run_lua marks the snapshot stale on a Lua runtime error too, not just a transport error", async () => {
  const memory = tmpMemory();
  // pcall() inside the wrapper only catches the error - it does not undo
  // whatever the body already did before the line that threw.
  const ctx = fakeCtx(memory, async () => { throw Object.assign(new Error("attempt to call a nil value (method 'Nope')"), { code: "runtime" }); });
  const r = JSON.parse((await runTool(ctx, "run_lua", { state: "GameCore_Tuner", code: "Players[0]:GetTreasury():ChangeGoldBalance(1) P.x:Nope()" })).content);
  assert.equal(r.ok, false);
  assert.equal(ctx.staleCount, 1, "a runtime error can still follow real effects from earlier in the same script");
});

test("save_ability's test run marks the snapshot stale even when it only reports ok=false (no exception)", async () => {
  const memory = tmpMemory();
  // The call round-trips normally - its body ran in full - the ability's own
  // logic is what decided to report ok=false, after whatever it already did.
  const ctx = fakeCtx(memory, async () => ({ value: { ok: false, reason: "wrong city" }, text: [] }));
  const r = JSON.parse((await runTool(ctx, "save_ability", {
    name: "writes_then_fails", description: "Writes something, then reports failure.", state: "GameCore_Tuner",
    lua: "Players[0]:GetTreasury():ChangeGoldBalance(P.amount) emitJson({ok=false, reason='wrong city'})",
    parameters: { amount: { type: "integer" } }, required: ["amount"], kind: "play", test_params: { amount: 1 },
  })).content);
  assert.equal(r.saved, false, "ok=false from the test run refuses the save");
  assert.equal(ctx.staleCount, 1, "the write before the ok=false report still happened");
});

test("perform_action refuses bad args before touching the game", async () => {
  const memory = tmpMemory();
  const ctx = fakeCtx(memory);
  const r = JSON.parse((await runTool(ctx, "perform_action", { action: "spawn_unit", args: { unitType: "UNIT_WARRIOR" } })).content);
  assert.equal(r.ok, false);
  assert.equal(r.stage, "validate");
  assert.equal(ctx.calls.length, 0);
});

test("solver tools read the snapshot", async () => {
  const ctx = fakeCtx(tmpMemory());
  const r = JSON.parse((await runTool(ctx, "production_overview", {})).content);
  assert.deepEqual(r.idle, ["Antium"]);
  const city = JSON.parse((await runTool(ctx, "get_city", { cityId: 999 })).content);
  assert.match(city.error, /no city 999/);
});

test("a result's own `at` never overwrites the journal timestamp", () => {
  const memory = tmpMemory();
  memory.record({ type: "action", action: "spawn_unit", at: [10, 31] });
  const e = memory.recentJournal(1)[0];
  assert.match(e.at, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(e.position, [10, 31]);
});

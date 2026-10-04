// The digger and the strategy layer.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as dig from "../lib/discovery.mjs";
import { analyzeStanding, formatStanding, History } from "../lib/strategy.mjs";
import { Memory } from "../lib/memory.mjs";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "aiciv-"));

// A tiny fake game install: one UI script and one Firaxis tuner panel.
function fakeFiles() {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, "Base", "Assets", "UI"), { recursive: true });
  fs.mkdirSync(path.join(dir, "Debug"), { recursive: true });
  fs.writeFileSync(path.join(dir, "Base", "Assets", "UI", "Panel.lua"), [
    "local n = pCity:GetPopulation()",
    "local y = plot:GetYield(0)",
    "local t = pTreasury:GetGoldBalance()",
    "local g = ResourceGenerator.Create(args)",
  ].join("\n"));
  fs.writeFileSync(path.join(dir, "Debug", "City.ltp"), "pCity:ChangeLoyalty(10);\npCityBuildQueue:AddProgress(20);\n");
  const files = { gameDir: dir, list: () => [path.join(dir, "Base", "Assets", "UI", "Panel.lua"), path.join(dir, "Debug", "City.ltp")], lines: (f) => fs.readFileSync(f, "utf8").split("\n") };
  return files;
}

function fakeMemory() {
  const m = new Memory(tmp());
  m.saveCatalog("GameCore_Tuner", {
    globals: {},
    objects: {
      City: ["GetPopulation", "ChangeLoyalty", "SetName"],
      "City:GetBuildQueue": ["AddProgress", "GetSize"],
      Plot: ["GetYield"],
      "Player:GetTreasury": ["GetGoldBalance"],
      "Player:GetUnits": ["Create"],
    },
  });
  return m;
}

test("the mapper classifies, scores and finds evidence on the right kind of object", () => {
  const memory = fakeMemory();
  const dmap = memory.discovery;
  const run = dig.mapApi(memory, fakeFiles(), dmap);
  assert.equal(run.total, 8);
  const loyalty = dmap.get("GameCore_Tuner", "City", "ChangeLoyalty");
  assert.equal(loyalty.kind, "write");
  assert.deepEqual(loyalty.evidence.contexts, ["tuner"], "found in Firaxis' cheat panel");
  const create = dmap.get("GameCore_Tuner", "Player:GetUnits", "Create");
  assert.equal(create.evidence, null, "ResourceGenerator.Create is not evidence for Player:GetUnits:Create");
  assert.ok(create.nameOnlyEvidence.length);
  const top = dig.frontier(dmap, { limit: 3 });
  assert.equal(top[0].method, "ChangeLoyalty", "cheat-panel writes on core objects rank first");
  assert.ok(top.every((e) => e.sites.length));
});

test("only zero-argument getters with same-object zero-argument evidence are probed", () => {
  const memory = fakeMemory();
  dig.mapApi(memory, fakeFiles(), memory.discovery);
  const keys = dig.probeCandidates(memory.discovery, { limit: 50 }).map((e) => `${e.holder}:${e.method}`);
  assert.ok(keys.includes("City:GetPopulation"));
  assert.ok(!keys.includes("Plot:GetYield"), "GetYield is called with an argument");
  assert.ok(!keys.includes("City:ChangeLoyalty"), "never a write");
  assert.ok(keys.includes("Player:GetTreasury:GetGoldBalance"), "pTreasury:GetGoldBalance() is zero-argument evidence on a treasury");
});

test("dig status only moves forward, blocked is recorded, and notes accumulate", () => {
  const memory = fakeMemory();
  const dmap = memory.discovery;
  dig.mapApi(memory, fakeFiles(), dmap);
  dmap.update("GameCore_Tuner", "City", "ChangeLoyalty", { status: "ability", note: "saved as city_loyalty" });
  dmap.update("GameCore_Tuner", "City", "ChangeLoyalty", { status: "evidenced" });
  assert.equal(dmap.get("GameCore_Tuner", "City", "ChangeLoyalty").status, "ability");
  dmap.update("GameCore_Tuner", "City", "SetName", { status: "blocked", note: "needs a localized string" });
  assert.equal(dmap.get("GameCore_Tuner", "City", "SetName").status, "blocked");
  dmap.save();
  const again = new dig.DiscoveryMap(memory.dir);
  assert.equal(again.get("GameCore_Tuner", "City", "ChangeLoyalty").notes.length, 1);
  assert.ok(!dig.frontier(again).some((e) => e.method === "ChangeLoyalty"), "done items leave the frontier");
});

const STANDING = {
  turn: 271, me: 0, victories: ["VICTORY_TECHNOLOGY", "VICTORY_CULTURE", "VICTORY_CONQUEST", "VICTORY_SCORE"],
  players: [
    { id: 0, me: true, known: true, civ: "Hungary", score: 176, techs: 13, touristsTo: 2, capitalsHeld: 0, military: 254 },
    { id: 1, known: true, civ: "Georgia", score: 753, techs: 41, touristsTo: 40, capitalsHeld: 1, military: 175 },
    { id: 2, known: true, civ: "China", score: 477, techs: 40, touristsTo: 9, capitalsHeld: 0, military: 300 },
    { id: 9, known: false },
  ],
  gaps: [],
};

test("standing ranks every road and names the strongest road and the biggest threat", () => {
  const a = analyzeStanding(STANDING);
  const sci = a.roads.find((r) => r.victory === "VICTORY_TECHNOLOGY");
  assert.deepEqual([sci.mine, sci.rank, sci.of, sci.leader, sci.share], [13, 3, 3, "Georgia", 32]);
  assert.equal(a.biggestThreat.civ, "Georgia");
  assert.ok(a.bestRoad);
  assert.match(a.note, /^calculated/);
  assert.match(formatStanding(a), /Science: you 13 \(#3 of 3\), leader Georgia 41/);
  assert.ok(!a.roads.some((r) => r.of > 3), "unknown civs are left out");
});

test("history records one row per turn and gives per-turn trends", () => {
  const h = new History(tmp());
  assert.equal(h.record(STANDING), true);
  assert.equal(h.record(STANDING), false, "same turn twice is not recorded");
  h.record({ ...STANDING, turn: 281, players: STANDING.players.map((p) => (p.known ? { ...p, score: p.score + 50, techs: p.techs + 5 } : p)) });
  const t = h.trends();
  assert.equal(t.perTurn.Hungary.score, 5);
  assert.equal(t.perTurn.Georgia.techs, 0.5);
});

test("a road where everyone is at zero reads as 'nobody has any yet'", () => {
  const s = { ...STANDING, players: STANDING.players.map((p) => (p.known ? { ...p, capitalsHeld: 0 } : p)) };
  assert.match(formatStanding(analyzeStanding(s)), /Domination: nobody has any yet/);
});

test("the event log keeps the current game's recent turns and formats them", async () => {
  const { EventLog, formatEvents, formatSituation } = await import("../lib/events.mjs");
  const log = new EventLog(tmp());
  log.add([{ kind: "turn", text: "Turn 271 began.", turn: 271 }, { kind: "research", text: "Researched Banking.", turn: 271 }]);
  // A new game: turn numbers restart, so the old game's events drop out.
  log.add([{ kind: "turn", text: "Turn 1 began.", turn: 1, blocking: "ENDTURN_BLOCKING_UNITS" }, { kind: "notification", text: "Meet Mongolia", turn: 1 }]);
  log.add([{ kind: "war", text: "Mongolia declared war on you!", turn: 2 }, { kind: "notification", text: "Meet Mongolia", turn: 2 }, { kind: "notification", text: "Meet Mongolia", turn: 2 }, { bad: true }]);
  const recent = log.recent({ turns: 2 });
  assert.ok(recent.every((e) => e.turn <= 2), "only the current game");
  const text = formatEvents(recent);
  assert.match(text, /Turn 1:\n- waiting on: units/);
  assert.match(text, /! Mongolia declared war on you!/);
  assert.match(text, /Meet Mongolia \(x2\)/);
  assert.deepEqual(log.recent({ kinds: ["war"] }).map((e) => e.kind), ["war"]);

  const s = formatSituation({
    turn: 40, wars: ["Mongolia"], blocking: "ENDTURN_BLOCKING_PRODUCTION",
    deals: [{ civ: "France", gives: ["peace"], asks: ["100 gold"] }],
    civs: [
      { civ: "England", mood: "DIPLO_STATE_FRIENDLY", moodLevel: 70, military: 90, reasons: [{ score: 6, text: "Trading partners" }] },
      { civ: "Mongolia", mood: "DIPLO_STATE_WAR", moodLevel: 0, atWar: true, military: 300, reasons: [] },
    ],
  });
  assert.match(s, /! At war with: Mongolia/);
  assert.match(s, /! Deal from France: they give peace; they ask 100 gold/);
  assert.match(s, /worst first\):\n- Mongolia: AT WAR/);
  assert.match(s, /England: friendly, military 90 \(\+6 Trading partners\)/);
  assert.match(s, /Before ending the turn: production/);
});

test("history starts a new file when a different game begins", () => {
  const dir = tmp();
  const h = new History(dir);
  h.record(STANDING);
  h.record({ ...STANDING, turn: 1 });
  assert.equal(h.rows().length, 1, "the new game's history starts fresh");
  assert.equal(fs.readdirSync(dir).filter((f) => /^history-\d+\.jsonl$/.test(f)).length, 1, "the old game's history is kept");
});

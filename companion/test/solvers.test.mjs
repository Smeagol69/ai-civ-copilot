import test from "node:test";
import assert from "node:assert/strict";
import * as solve from "../lib/solvers.mjs";
import { SNAP } from "./fixtures/snapshot.mjs";

test("empire summary totals come from city yields", () => {
  const s = solve.empireSummary(SNAP);
  assert.equal(s.cityCount, 2);
  assert.equal(s.population, 17);
  assert.equal(s.cityYieldTotals.PRODUCTION, 38);
  assert.equal(s.unitTypes.UNIT_KNIGHT, 1);
  assert.deepEqual(s.gaps, SNAP.gaps, "gaps are surfaced, never hidden");
});

test("production overview flags idle, capped and unhappy cities", () => {
  const p = solve.productionOverview(SNAP);
  assert.deepEqual(p.idle, ["Antium"]);
  assert.deepEqual(p.housingCapped, ["Rome"]);
  assert.deepEqual(p.unhappy, ["Rome"]);
});

test("threat report ranks hostile units first and skips civilians", () => {
  const t = solve.threatReport(SNAP);
  assert.equal(t.hostileCount, 2);
  assert.deepEqual(t.threats.slice(0, 2).map((u) => u.id).sort(), [77, 99]);
  assert.ok(!t.threats.some((u) => u.type === "UNIT_TRADER"));
  assert.deepEqual(t.atWarWith, ["Greece"]);
});

test("rival comparison includes us and ranks by score", () => {
  const r = solve.rivalComparison(SNAP);
  assert.equal(r.ranking[0].civ, "Egypt");
  assert.ok(r.ranking.some((x) => x.me));
  assert.ok(!r.ranking.some((x) => x.civ === "Geneva"));
});

test("research path orders prerequisites and labels its estimate", () => {
  const prereqs = { TECH_BANKING: ["TECH_PRINTING", "TECH_ASTRONOMY"], TECH_PRINTING: ["TECH_EDUCATION"], TECH_ASTRONOMY: ["TECH_EDUCATION"] };
  const r = solve.researchPath(SNAP, prereqs, "TECH_BANKING", { TECH_BANKING: 700 });
  assert.deepEqual(r.steps.map((s) => s.tech), ["TECH_PRINTING", "TECH_ASTRONOMY", "TECH_BANKING"]);
  assert.equal(r.totalScienceRemaining, 240 + 480 + 700);
  assert.equal(r.estimatedTurns, Math.ceil(1420 / 62.4));
  assert.match(r.estimate, /^calculated/);
  assert.equal(solve.researchPath(SNAP, prereqs, "TECH_WRITING").alreadyResearched, true);
});

test("find units filters by type, idleness and distance", () => {
  assert.equal(solve.findUnits(SNAP, { type: "knight" }).count, 1);
  assert.deepEqual(solve.findUnits(SNAP, { idleOnly: true }).units.map((u) => u.id), [1, 3]);
  assert.deepEqual(solve.findUnits(SNAP, { near: { x: 10, y: 10 }, radius: 1 }).units.map((u) => u.id).sort(), [1, 2]);
});

test("hex distance", () => {
  assert.equal(solve.hexDistance(0, 0, 0, 0), 0);
  assert.equal(solve.hexDistance(0, 0, 3, 0), 3);
  assert.equal(solve.hexDistance(5, 5, 5, 8), 3);
});

test("lean payload is small and drops the bulky lists", () => {
  const lean = solve.leanPayload(SNAP);
  const json = JSON.stringify(lean);
  assert.ok(!json.includes("canProduce"));
  assert.equal(lean.cities[0].yields.Production, 30);
  assert.equal(lean.threats.length, 2);
  assert.deepEqual(solve.leanPayload({ error: "no local player" }), { error: "no local player" });
});

import { LIVE_DISTANCES, LIVE_MAP } from "./fixtures/live-distances.mjs";

test("hex distance matches the game's Map.GetPlotDistance on every live pair, across the seam too", () => {
  for (const [x1, y1, x2, y2, d] of LIVE_DISTANCES) {
    assert.equal(solve.hexDistance(x1, y1, x2, y2, LIVE_MAP.width), d, `(${x1},${y1})-(${x2},${y2})`);
  }
});

test("units across the east-west seam are found, and threats ranked, by wrapped distance", () => {
  const snap = { ...SNAP, meta: { ...SNAP.meta, mapWidth: 74, wrapX: true }, units: [{ id: 9, type: "UNIT_SETTLER", x: 1, y: 34, moves: 2 }] };
  assert.equal(solve.findUnits(snap, { near: { x: 73, y: 34 }, radius: 3 }).count, 1);
  assert.equal(solve.findUnits({ ...snap, meta: { ...snap.meta, wrapX: false } }, { near: { x: 73, y: 34 }, radius: 3 }).count, 0);
});

test("idle means the game's ready-to-select, not merely 'has moves'", () => {
  const snap = { ...SNAP, units: [
    { id: 1, type: "UNIT_TRADER", moves: 2, activity: "ACTIVITY_OPERATION", ready: false },
    { id: 2, type: "UNIT_QUADRIREME", moves: 4, activity: "ACTIVITY_AWAKE", ready: true },
    { id: 3, type: "UNIT_GALLEY", moves: 4, activity: "ACTIVITY_OPERATION" },
    { id: 4, type: "UNIT_WARRIOR", moves: 2, activity: "ACTIVITY_AWAKE" },
  ] };
  assert.deepEqual(solve.findUnits(snap, { idleOnly: true }).units.map((u) => u.id), [2, 4]);
});

test("research path counts progress on locked techs and refuses unknown targets", () => {
  const prereqs = { TECH_COMBINED_ARMS: ["TECH_MILITARY_SCIENCE"], TECH_MILITARY_SCIENCE: ["TECH_EDUCATION"] };
  const costs = { TECH_COMBINED_ARMS: 1400, TECH_MILITARY_SCIENCE: 930 };
  const progress = { TECH_COMBINED_ARMS: 707, TECH_MILITARY_SCIENCE: 370 };
  const r = solve.researchPath(SNAP, prereqs, "TECH_COMBINED_ARMS", costs, progress);
  assert.equal(r.totalScienceRemaining, (930 - 370) + (1400 - 707));
  assert.match(r.estimate, /after progress already made/);
  const bad = solve.researchPath(SNAP, prereqs, "TECH_FOO", costs, progress);
  assert.equal(bad.error, "unknown tech type");
  assert.equal(bad.estimatedTurns, undefined);
});

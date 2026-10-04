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

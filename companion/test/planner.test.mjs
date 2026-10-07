// The free turn plan, from fake game reads.
import test from "node:test";
import assert from "node:assert/strict";
import { planTurn } from "../lib/planner.mjs";

const SNAP = {
  meta: { turn: 12, wrapX: false, mapWidth: 60 },
  me: { id: 0, civName: "Poland", goldPerTurn: -2, civic: { type: "CIVIC_CODE_OF_LAWS", turns: 3 } },
  players: [{ id: 1, civName: "Mongolia", major: true, atWar: false }],
  cities: [
    { id: 1, name: "Krakow", x: 13, y: 14, population: 3, production: { item: "UNIT_SLINGER", turnsLeft: 2 }, housing: 6, amenities: 1, amenitiesNeeded: 1 },
    { id: 2, name: "Gdansk", x: 18, y: 12, population: 1, production: { item: null, queueSize: 0 }, housing: 4, amenities: 1, amenitiesNeeded: 0 },
  ],
  units: [
    { id: 10, type: "UNIT_SETTLER", x: 15, y: 13, moves: 2, combat: 0, ranged: 0, ready: true },
    { id: 11, type: "UNIT_WARRIOR", x: 14, y: 15, moves: 2, combat: 20, ranged: 0, ready: true },
    { id: 12, type: "UNIT_SCOUT", x: 20, y: 20, moves: 3, combat: 10, ranged: 0, ready: true },
  ],
  visibleForeignUnits: [{ owner: 63, id: 99, type: "UNIT_WARRIOR", x: 15, y: 15, hp: 60, combat: 20, barbarian: true }],
};

const fakeGame = {
  situation: async () => ({ turn: 12, wars: [], deals: [{ civ: "Mongolia", gives: ["50 gold"], asks: ["Open Borders"] }], blocking: "ENDTURN_BLOCKING_UNITS" }),
  advisor: async () => ({
    techs: [{ name: "Archery", score: 140 }], civics: [{ name: "Craftsmanship" }],
    cities: [{ id: 2, name: "Gdansk", recommended: [{ name: "Monument", score: 90 }] }],
    settle: [{ x: 15, y: 13, pros: ["FRESH WATER: This site has fresh water"], cons: [] }, { x: 9, y: 9, pros: [], cons: [] }],
    builders: [],
  }),
  planning: async () => ({ boosts: { techs: [{ type: "TECH_ARCHERY", name: "Archery", how: "Kill a unit with a [ICON_Slinger] Slinger.", available: true }], civics: [] }, greatPeople: [], envoys: { toGive: 1 } }),
  combat: async (id, { targets }) => {
    assert.equal(id, 11, "only the warrior is near the barbarian");
    assert.deepEqual(targets, [{ player: 63, id: 99 }]);
    return { results: [{ type: "UNIT_WARRIOR", x: 15, y: 15, damageToDefender: 40, damageToAttacker: 20, canAttackNow: true, kills: false, dies: false }] };
  },
};

test("the turn plan puts forced decisions first and turns game reads into moves", async () => {
  const plan = await planTurn(fakeGame, SNAP);
  assert.match(plan.text, /Urgent:\n! Deal from Mongolia: they give 50 gold, ask Open Borders/);
  assert.match(plan.text, /Barbarians\) at \(15,15\)/);
  assert.match(plan.text, /Attack with Warrior \(14,15\) -> Warrior at \(15,15\): deal 40, take 20/);
  assert.match(plan.text, /Choose research: the game suggests Archery/);
  assert.match(plan.text, /Gdansk is idle: the game suggests Monument/);
  assert.match(plan.text, /Settler at \(15,13\): settle here - it is the game's #1 site/);
  assert.match(plan.text, /Eureka within reach - Archery: Kill a unit with a Slinger/);
  assert.match(plan.text, /Send 1 envoy/);
  assert.match(plan.text, /Gold per turn is -2/);
  assert.match(plan.text, /waiting on: Units/);
  assert.match(plan.text, /other unit\(s\) waiting for orders: .*Scout \(20,20\)/, "idle units the plan has no specific job for are listed");
  assert.doesNotMatch(plan.text, /waiting for orders: .*Settler/, "the settler already has its own line");
});

test("a failed read is named, not fatal", async () => {
  const broken = { ...fakeGame, advisor: async () => { throw new Error("advisor down"); } };
  const plan = await planTurn(broken, { ...SNAP, visibleForeignUnits: [] });
  assert.match(plan.text, /Could not read: advisor down/);
  assert.match(plan.text, /Deal from Mongolia/);
});

test("a city whose production could not be read gets a task, and withholds the all-clear", async () => {
  // Otherwise quiet turn: active research/civic, no units/deals/wars/
  // blocker, one city whose whole production read failed. Nothing else
  // should produce a todo/urgent item, so this isolates the signal.
  const quietGame = {
    situation: async () => ({ turn: 20, wars: [], deals: [] }),
    advisor: async () => ({ techs: [], civics: [], cities: [], settle: [], builders: [] }),
    planning: async () => ({ boosts: { techs: [], civics: [] }, greatPeople: [], envoys: { toGive: 0 } }),
  };
  const quietSnap = {
    meta: { turn: 20, wrapX: false, mapWidth: 60 },
    me: { id: 0, civName: "Poland", goldPerTurn: 5, researching: { type: "TECH_PRINTING", turns: 4 }, civic: { type: "CIVIC_HUMANISM", turns: 3 } },
    players: [],
    cities: [{ id: 5, name: "Lublin", x: 1, y: 1, population: 2, production: undefined, housing: 4, amenities: 1, amenitiesNeeded: 1 }],
    units: [],
    visibleForeignUnits: [],
    gaps: ["city.production: lookup failed"],
  };
  const plan = await planTurn(quietGame, quietSnap);
  assert.match(plan.text, /Lublin.*production.*could not be/i);
  assert.doesNotMatch(plan.text, /Nothing needs you right now - end the turn\./, "an unknown production status must withhold the all-clear");
});

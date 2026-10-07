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

// situation.lua resolves the engine's end-turn-blocking enum to its NAME
// string, including the no-blocker case itself: NO_ENDTURN_BLOCKING. An
// otherwise fully quiet turn (confirmed named production, active
// research/civic, no units/deals/wars) isolates just the blocking signal.
const quietBlockerGame = (blocking) => ({
  situation: async () => ({ turn: 20, wars: [], deals: [], blocking }),
  advisor: async () => ({ techs: [], civics: [], cities: [], settle: [], builders: [] }),
  planning: async () => ({ boosts: { techs: [], civics: [] }, greatPeople: [], envoys: { toGive: 0 } }),
});
const quietBlockerSnap = {
  meta: { turn: 20, wrapX: false, mapWidth: 60 },
  me: { id: 0, civName: "Poland", goldPerTurn: 5, researching: { type: "TECH_PRINTING", turns: 4 }, civic: { type: "CIVIC_HUMANISM", turns: 3 } },
  players: [],
  cities: [{ id: 5, name: "Lublin", x: 1, y: 1, population: 2, production: { item: "UNIT_WARRIOR", turnsLeft: 2, queueSize: 1 }, housing: 4, amenities: 1, amenitiesNeeded: 1 }],
  units: [],
  visibleForeignUnits: [],
};

test("an active end-turn blocker is shown and suppresses the all-clear, even with nothing else pending", async () => {
  const plan = await planTurn(quietBlockerGame("ENDTURN_BLOCKING_PANTHEON"), quietBlockerSnap);
  assert.match(plan.text, /waiting on: Pantheon\./);
  assert.doesNotMatch(plan.text, /Nothing needs you right now - end the turn\./, "the game will not actually let the turn end while a real blocker is active");
});

test("the engine's own no-blocker enum name permits a quiet end-turn, not a false 'waiting on' warning", async () => {
  const plan = await planTurn(quietBlockerGame("NO_ENDTURN_BLOCKING"), quietBlockerSnap);
  assert.doesNotMatch(plan.text, /waiting on/i, "NO_ENDTURN_BLOCKING is a truthy string, but it means there is no blocker");
  assert.match(plan.text, /Nothing needs you right now - end the turn\./);
});

// advisor.lua genuinely emits a builder entry with an empty, missing or
// null recommended list whenever the builder is outside a city's borders,
// has no improvement recommendations, or its own lookup fails.
test("a ready builder with no advisor recommendation still gets a task via the ordinary fallback", async () => {
  for (const recommended of [[], undefined, null]) {
    const game = {
      situation: async () => ({ turn: 20, wars: [], deals: [] }),
      advisor: async () => ({ techs: [], civics: [], cities: [], settle: [], builders: [{ id: 77, x: 4, y: 5, recommended }] }),
      planning: async () => ({ boosts: { techs: [], civics: [] }, greatPeople: [], envoys: { toGive: 0 } }),
    };
    const snap = {
      meta: { turn: 20, wrapX: false, mapWidth: 60 },
      me: { id: 0, civName: "Poland", goldPerTurn: 5, researching: { type: "TECH_PRINTING", turns: 4 }, civic: { type: "CIVIC_HUMANISM", turns: 3 } },
      players: [],
      cities: [],
      units: [{ id: 77, type: "UNIT_BUILDER", x: 4, y: 5, ready: true }],
      visibleForeignUnits: [],
    };
    const plan = await planTurn(game, snap);
    assert.match(plan.text, /waiting for orders: Builder \(4,5\)/, JSON.stringify(recommended));
    assert.doesNotMatch(plan.text, /Nothing needs you right now - end the turn\./, JSON.stringify(recommended));
  }
});

test("a builder with a real recommendation still gets exactly one specific task, not a duplicate generic one", async () => {
  const game = {
    situation: async () => ({ turn: 20, wars: [], deals: [] }),
    advisor: async () => ({ techs: [], civics: [], cities: [], settle: [], builders: [{ id: 78, x: 6, y: 7, recommended: [{ type: "IMPROVEMENT_FARM", name: "Farm", x: 6, y: 8 }] }] }),
    planning: async () => ({ boosts: { techs: [], civics: [] }, greatPeople: [], envoys: { toGive: 0 } }),
  };
  const snap = {
    meta: { turn: 20, wrapX: false, mapWidth: 60 },
    me: { id: 0, civName: "Poland", goldPerTurn: 5, researching: { type: "TECH_PRINTING", turns: 4 }, civic: { type: "CIVIC_HUMANISM", turns: 3 } },
    players: [],
    cities: [],
    units: [{ id: 78, type: "UNIT_BUILDER", x: 6, y: 7, ready: true }],
    visibleForeignUnits: [],
  };
  const plan = await planTurn(game, snap);
  assert.match(plan.text, /Builder at \(6,7\): Farm at \(6,8\)\./);
  assert.doesNotMatch(plan.text, /waiting for orders/);
});

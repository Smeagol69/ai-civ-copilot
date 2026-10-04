// Synthetic snapshot shaped exactly like lua/snapshot.lua's output.
export const SNAP = {
  gaps: ["me.favor: attempt to call a nil value"],
  meta: { turn: 120, localPlayer: 0, mapWidth: 84, mapHeight: 54, plotCount: 4536, gameSpeed: "GAMESPEED_STANDARD", era: "ERA_RENAISSANCE" },
  me: {
    id: 0, civ: "CIVILIZATION_ROME", civName: "Rome", leader: "LEADER_TRAJAN", leaderName: "Trajan", score: 410,
    gold: 523.5, goldYield: 41, goldMaintenance: 18, goldPerTurn: 23, science: 62.4, culture: 38.2, faith: 140, faithYield: 9,
    government: "GOVERNMENT_MONARCHY", eraScore: 40, darkAgeThreshold: 36, goldenAgeThreshold: 48,
    researching: { type: "TECH_PRINTING", turns: 4, progress: 300, cost: 540 },
    civic: { type: "CIVIC_HUMANISM", turns: 6, progress: 200, cost: 420 },
  },
  techs: {
    researched: ["TECH_POTTERY", "TECH_WRITING", "TECH_EDUCATION"],
    available: [
      { type: "TECH_PRINTING", era: "ERA_RENAISSANCE", cost: 540, progress: 300, turns: 4, boosted: false },
      { type: "TECH_ASTRONOMY", era: "ERA_MEDIEVAL", cost: 480, progress: 0, turns: 8, boosted: true },
    ],
  },
  civics: { completed: ["CIVIC_CODE_OF_LAWS"], available: [{ type: "CIVIC_HUMANISM", cost: 420, progress: 200 }] },
  cities: [
    {
      id: 65536, name: "Rome", x: 10, y: 10, population: 12, capital: true,
      yields: { FOOD: 4, PRODUCTION: 30, GOLD: 20, SCIENCE: 25, CULTURE: 12, FAITH: 3 },
      housing: 12, amenities: 3, amenitiesNeeded: 4, turnsToGrow: -1, foodSurplus: 0,
      production: { item: "BUILDING_UNIVERSITY", turnsLeft: 5, queueSize: 1 },
      districts: [{ type: "DISTRICT_CITY_CENTER", x: 10, y: 10 }, { type: "DISTRICT_CAMPUS", x: 11, y: 10 }],
      buildings: ["BUILDING_LIBRARY"],
      canProduce: [{ type: "UNIT_SETTLER", turns: 6 }],
    },
    {
      id: 131073, name: "Antium", x: 16, y: 12, population: 5,
      yields: { FOOD: 6, PRODUCTION: 8, GOLD: 4, SCIENCE: 3, CULTURE: 2, FAITH: 1 },
      housing: 8, amenities: 1, amenitiesNeeded: 1, turnsToGrow: 7, foodSurplus: 3,
      production: { item: null, queueSize: 0 },
      districts: [{ type: "DISTRICT_CITY_CENTER", x: 16, y: 12 }],
      buildings: [],
    },
  ],
  units: [
    { id: 1, type: "UNIT_BUILDER", x: 11, y: 10, hp: 100, maxHp: 100, moves: 2, maxMoves: 2, charges: 3, activity: "ACTIVITY_AWAKE" },
    { id: 2, type: "UNIT_CROSSBOWMAN", x: 10, y: 10, hp: 80, maxHp: 100, moves: 0, maxMoves: 2, activity: "ACTIVITY_FORTIFIED" },
    { id: 3, type: "UNIT_KNIGHT", x: 15, y: 12, hp: 100, maxHp: 100, moves: 4, maxMoves: 4, activity: "ACTIVITY_AWAKE" },
  ],
  players: [
    { id: 1, major: true, civ: "CIVILIZATION_GREECE", civName: "Greece", atWar: true, score: 380, cities: 6, militaryStrength: 900, techs: 30, diplomaticState: "DIPLO_STATE_WAR" },
    { id: 2, major: true, civ: "CIVILIZATION_EGYPT", civName: "Egypt", atWar: false, score: 450, cities: 9, militaryStrength: 700, techs: 34, diplomaticState: "DIPLO_STATE_FRIENDLY" },
    { id: 20, major: false, civ: "CIVILIZATION_GENEVA", civName: "Geneva", atWar: false, score: 50, suzerain: 0, myEnvoys: 3 },
  ],
  visibleForeignUnits: [
    { owner: 1, id: 77, type: "UNIT_HOPLITE", x: 18, y: 12, hp: 100, combat: 25, distanceToNearestOwned: 2, barbarian: false },
    { owner: 2, id: 88, type: "UNIT_ARCHER", x: 12, y: 8, hp: 100, combat: 15, ranged: 25, distanceToNearestOwned: 2, barbarian: false },
    { owner: 63, id: 99, type: "UNIT_BARBARIAN_HORSE_ARCHER", x: 9, y: 14, hp: 60, combat: 10, ranged: 20, distanceToNearestOwned: 4, barbarian: true },
    { owner: 2, id: 89, type: "UNIT_TRADER", x: 13, y: 10, hp: 100, combat: 0, distanceToNearestOwned: 1, barbarian: false },
  ],
  resources: [{ type: "RESOURCE_IRON", class: "RESOURCECLASS_STRATEGIC", amount: 12, cap: 50 }],
  exploration: { landPlots: 2000, revealedLand: 900 },
};

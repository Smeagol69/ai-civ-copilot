// Deterministic answers computed from the game's own numbers. The model must
// call these instead of doing arithmetic on the snapshot itself. Every value
// is either read from the game or labelled with how it was calculated.

const YIELDS = ["FOOD", "PRODUCTION", "GOLD", "SCIENCE", "CULTURE", "FAITH"];
const round = (n, d = 1) => (typeof n === "number" ? Math.round(n * 10 ** d) / 10 ** d : n);

export function empireSummary(snap) {
  const cities = snap.cities || [];
  const units = snap.units || [];
  const totals = Object.fromEntries(YIELDS.map((y) => [y, 0]));
  for (const c of cities) for (const y of YIELDS) totals[y] += c.yields?.[y] || 0;
  const unitTypes = {};
  for (const u of units) unitTypes[u.type] = (unitTypes[u.type] || 0) + 1;
  const me = snap.me || {};
  return {
    turn: snap.meta?.turn,
    era: snap.meta?.era,
    civ: me.civName,
    leader: me.leaderName,
    score: me.score,
    gold: round(me.gold),
    goldPerTurn: round(me.goldPerTurn),
    sciencePerTurn: round(me.science),
    culturePerTurn: round(me.culture),
    faith: round(me.faith),
    faithPerTurn: round(me.faithYield),
    favor: me.favor,
    government: me.government,
    researching: me.researching,
    civic: me.civic,
    cityCount: cities.length,
    population: cities.reduce((a, c) => a + (c.population || 0), 0),
    cityYieldTotals: Object.fromEntries(Object.entries(totals).map(([k, v]) => [k, round(v)])),
    unitCount: units.length,
    unitTypes,
    techsResearched: snap.techs?.researched?.length,
    civicsCompleted: snap.civics?.completed?.length,
    eraScore: me.eraScore,
    goldenAgeThreshold: me.goldenAgeThreshold,
    darkAgeThreshold: me.darkAgeThreshold,
    gaps: snap.gaps?.length ? snap.gaps : undefined,
  };
}

export function productionOverview(snap) {
  const rows = (snap.cities || []).map((c) => ({
    cityId: c.id,
    name: c.name,
    population: c.population,
    production: round(c.yields?.PRODUCTION),
    building: c.production?.item || null,
    turnsLeft: c.production?.turnsLeft ?? null,
    queueSize: c.production?.queueSize ?? 0,
    turnsToGrow: c.turnsToGrow,
    housingRoom: typeof c.housing === "number" ? round(c.housing - c.population) : null,
    amenityBalance: typeof c.amenities === "number" && typeof c.amenitiesNeeded === "number" ? c.amenities - c.amenitiesNeeded : null,
  }));
  return {
    idle: rows.filter((r) => !r.building).map((r) => r.name),
    housingCapped: rows.filter((r) => r.housingRoom !== null && r.housingRoom <= 0).map((r) => r.name),
    unhappy: rows.filter((r) => r.amenityBalance !== null && r.amenityBalance < 0).map((r) => r.name),
    cities: rows,
  };
}

// Wrap width for distance maths: the map width when it wraps east-west.
const wrapOf = (snap) => (snap.meta?.wrapX ? snap.meta.mapWidth || 0 : 0);

export function threatReport(snap) {
  const wrap = wrapOf(snap);
  const players = new Map((snap.players || []).map((p) => [p.id, p]));
  const threats = (snap.visibleForeignUnits || [])
    .filter((u) => (u.combat || 0) > 0 || (u.ranged || 0) > 0)
    .map((u) => {
      const p = players.get(u.owner);
      const hostile = u.barbarian || p?.atWar || false;
      let nearestCity = null;
      for (const c of snap.cities || []) {
        const d = hexDistance(u.x, u.y, c.x, c.y, wrap);
        if (!nearestCity || d < nearestCity.distance) nearestCity = { name: c.name, cityId: c.id, distance: d };
      }
      return { ...u, ownerName: u.barbarian ? "Barbarians" : p?.civName ?? `player ${u.owner}`, hostile, nearestCity };
    })
    .sort((a, b) => Number(b.hostile) - Number(a.hostile) || (a.nearestCity?.distance ?? 99) - (b.nearestCity?.distance ?? 99));
  return {
    hostileCount: threats.filter((t) => t.hostile).length,
    atWarWith: (snap.players || []).filter((p) => p.atWar).map((p) => p.civName),
    threats,
    note: "only units the local player can currently see; fogged units are unknown, not absent",
  };
}

export function rivalComparison(snap) {
  const me = snap.me || {};
  const rows = [
    { id: me.id, civ: me.civName, me: true, score: me.score, cities: snap.cities?.length, militaryStrength: me.militaryStrength, techs: snap.techs?.researched?.length },
    ...(snap.players || []).filter((p) => p.major).map((p) => ({
      id: p.id, civ: p.civName, score: p.score, cities: p.cities, militaryStrength: p.militaryStrength, techs: p.techs,
      atWar: p.atWar, diplomaticState: p.diplomaticState,
    })),
  ];
  rows.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  return { ranking: rows, note: "only civilizations the local player has met" };
}

export function findUnits(snap, { type, idleOnly, near, radius = 3 } = {}) {
  let us = snap.units || [];
  if (type) us = us.filter((u) => (u.type || "").toLowerCase().includes(type.toLowerCase()));
  // The game's IsReadyToSelect when the snapshot has it; otherwise an awake
  // unit with moves (units on trade routes or orders are ACTIVITY_OPERATION).
  if (idleOnly) us = us.filter((u) => (u.ready != null ? u.ready === true : u.moves > 0 && u.activity === "ACTIVITY_AWAKE"));
  const wrap = wrapOf(snap);
  if (near) us = us.filter((u) => hexDistance(u.x, u.y, near.x, near.y, wrap) <= radius);
  return { count: us.length, units: us };
}

// Remaining research to reach a target tech, in prerequisite order.
// prereqs: { TECH_X: ["TECH_Y", ...] } from the game database; costs and
// progress for every tech (progress matters: boosts apply to techs that are
// not researchable yet - live, Military Science had 370/930 while locked).
export function researchPath(snap, prereqs, target, costs = {}, progress = {}) {
  const have = new Set(snap.techs?.researched || []);
  if (have.has(target)) return { target, alreadyResearched: true };
  const avail0 = new Set((snap.techs?.available || []).map((t) => t.type));
  if (!(target in costs) && !avail0.has(target) && !(target in prereqs)) {
    return { target, error: "unknown tech type", hint: "use the TECH_* name exactly as in GameInfo.Technologies (upper case)" };
  }
  const order = [];
  const seen = new Set();
  const visit = (t) => {
    if (have.has(t) || seen.has(t)) return;
    seen.add(t);
    for (const p of prereqs[t] || []) visit(p);
    order.push(t);
  };
  visit(target);
  const avail = new Map((snap.techs?.available || []).map((t) => [t.type, t]));
  let remaining = 0;
  const steps = order.map((t) => {
    const a = avail.get(t);
    const cost = a?.cost ?? costs[t] ?? null;
    const done = a?.progress ?? progress[t] ?? 0;
    const left = cost === null ? null : Math.max(0, cost - done);
    if (left !== null) remaining += left;
    return { tech: t, cost, progress: done, remaining: left, researchableNow: !!a };
  });
  const unknownCosts = steps.filter((s) => s.cost === null).map((s) => s.tech);
  const spt = snap.me?.science;
  return {
    target,
    steps,
    totalScienceRemaining: Math.round(remaining),
    sciencePerTurn: spt,
    estimatedTurns: spt > 0 && !unknownCosts.length ? Math.ceil(remaining / spt) : null,
    unknownCosts: unknownCosts.length ? unknownCosts : undefined,
    estimate: "calculated: remaining cost (after progress already made, including boosts) / current science per turn; ignores future boosts, overflow and science growth",
  };
}

// Hex distance on Civ VI's grid: odd-r offset (odd rows shifted right, y
// grows north), wrapping east-west when wrapWidth is the map width. Matched
// Map.GetPlotDistance on 35/35 live pairs, including across the seam
// ((73,35)-(2,35) = 3), on 2026-10-04.
export function hexDistance(x1, y1, x2, y2, wrapWidth = 0) {
  const toCube = (x, y) => {
    const q = x - (y - (y & 1)) / 2;
    return [q, y, -q - y];
  };
  const a = toCube(x1, y1);
  const d = (xb) => {
    const b = toCube(xb, y2);
    return Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]));
  };
  return wrapWidth > 0 ? Math.min(d(x2), d(x2 + wrapWidth), d(x2 - wrapWidth)) : d(x2);
}

// What the model sees up front: enough to orient, small enough to be cheap.
// Everything else is one tool call away, and the prompt says so.
export function leanPayload(snap) {
  if (!snap || snap.error) return { error: snap?.error || "no snapshot" };
  return {
    summary: empireSummary(snap),
    cities: (snap.cities || []).map((c) => ({
      id: c.id, name: c.name, x: c.x, y: c.y, pop: c.population, capital: c.capital || undefined,
      yields: Object.fromEntries(YIELDS.map((y) => [y[0] + y.slice(1).toLowerCase(), round(c.yields?.[y])])),
      building: c.production?.item || null, turnsLeft: c.production?.turnsLeft,
      grow: c.turnsToGrow, housing: c.housing, amenities: c.amenities, amenitiesNeeded: c.amenitiesNeeded,
      districts: (c.districts || []).filter((d) => d.type !== "DISTRICT_CITY_CENTER").map((d) => d.type),
    })),
    units: (snap.units || []).map((u) => ({ id: u.id, type: u.type, x: u.x, y: u.y, hp: u.hp, moves: u.moves, activity: u.activity })),
    players: (snap.players || []).map((p) => ({ id: p.id, civ: p.civName, major: p.major, atWar: p.atWar, score: p.score, state: p.diplomaticState })),
    threats: threatReport(snap).threats.filter((t) => t.hostile).slice(0, 12),
    availableTechs: (snap.techs?.available || []).map((t) => t.type),
    availableCivics: (snap.civics?.available || []).map((c) => c.type),
    gaps: snap.gaps,
  };
}

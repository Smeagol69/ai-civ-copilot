// Strategic standing: where the player stands on each road to victory,
// who is closest to winning, and how the race is moving turn by turn.
// Every number is read from the game (lua/standing.lua); everything derived
// here is labelled as calculated.

import fs from "node:fs";
import path from "node:path";

// The measure that best tracks each victory, highest = closer to winning.
export const VICTORY_MEASURES = {
  VICTORY_TECHNOLOGY: { label: "Science", key: "techs", also: "science" },
  VICTORY_CULTURE: { label: "Culture", key: "touristsTo", also: "tourism" },
  VICTORY_DIPLOMATIC: { label: "Diplomacy", key: "diploPoints" },
  VICTORY_RELIGIOUS: { label: "Religion", key: "faith" },
  VICTORY_CONQUEST: { label: "Domination", key: "capitalsHeld", also: "military" },
  VICTORY_SCORE: { label: "Score", key: "score" },
};

const known = (s) => (s.players || []).filter((p) => p.known);

// Per victory: my value, the leader, my rank, and the game's own progress.
export function analyzeStanding(s) {
  const players = known(s);
  const me = players.find((p) => p.me);
  if (!me) return { error: "no data for the local player", gaps: s.gaps };
  const roads = [];
  for (const v of s.victories || []) {
    const m = VICTORY_MEASURES[v];
    if (!m) continue;
    const ranked = players.filter((p) => typeof p[m.key] === "number").sort((a, b) => b[m.key] - a[m.key]);
    if (!ranked.length) continue;
    const leader = ranked[0];
    const rank = ranked.findIndex((p) => p.me) + 1;
    const mine = me[m.key];
    roads.push({
      victory: v,
      label: m.label,
      measure: m.key,
      mine,
      rank: rank || null,
      of: ranked.length,
      leader: leader.civ,
      leaderValue: leader[m.key],
      share: leader[m.key] > 0 && typeof mine === "number" ? Math.round((mine / leader[m.key]) * 100) : null,
      secondary: m.also ? { measure: m.also, mine: me[m.also], best: Math.max(...players.map((p) => p[m.also] ?? -Infinity)) } : undefined,
      gameProgress: me.progress?.[v],
    });
  }
  // Calculated: the road where the player is relatively strongest.
  const best = roads.filter((r) => r.share !== null).sort((a, b) => (a.rank - b.rank) || (b.share - a.share))[0];
  // Calculated: the rival leading the most roads is the biggest threat.
  const leads = {};
  for (const r of roads) if (r.leader !== me.civ) leads[r.leader] = (leads[r.leader] || []).concat(r.label);
  const threat = Object.entries(leads).sort((a, b) => b[1].length - a[1].length)[0];
  return {
    turn: s.turn,
    civ: me.civ,
    roads,
    bestRoad: best ? { victory: best.victory, label: best.label, rank: best.rank, share: best.share } : null,
    biggestThreat: threat ? { civ: threat[0], leads: threat[1] } : null,
    note: "calculated from the game's numbers: rank and share of the leader per measure; bestRoad = best rank, then share",
    gaps: s.gaps?.length ? s.gaps : undefined,
  };
}

export function formatStanding(a) {
  if (a.error) return `Standing unavailable: ${a.error}`;
  const lines = [`Victory standing, turn ${a.turn} (${a.civ}):`];
  for (const r of a.roads) {
    lines.push(`- ${r.label}: you ${r.mine ?? "?"} (${r.rank ? `#${r.rank} of ${r.of}` : "unranked"}), leader ${r.leader} ${r.leaderValue}${r.share !== null ? `, you have ${r.share}% of the leader` : ""}`);
  }
  if (a.bestRoad) lines.push(`Strongest road (calculated): ${a.bestRoad.label}, rank ${a.bestRoad.rank}.`);
  if (a.biggestThreat) lines.push(`Biggest threat (calculated): ${a.biggestThreat.civ}, leading ${a.biggestThreat.leads.join(", ")}.`);
  return lines.join("\n");
}

// Per-turn history of everyone's standing, for trends.
export class History {
  constructor(dataDir) {
    this.file = path.join(dataDir, "history.jsonl");
  }
  record(standing) {
    const last = this.rows(1)[0];
    if (last && last.turn === standing.turn) return false;
    const row = {
      turn: standing.turn,
      at: new Date().toISOString(),
      players: known(standing).map((p) => ({ id: p.id, civ: p.civ, me: p.me || undefined, score: p.score, techs: p.techs, civics: p.civics, science: p.science, culture: p.culture, tourism: p.tourism, touristsTo: p.touristsTo, diploPoints: p.diploPoints, military: p.military, cities: p.cities, faith: p.faith })),
    };
    fs.appendFileSync(this.file, JSON.stringify(row) + "\n");
    return true;
  }
  rows(n = 50) {
    if (!fs.existsSync(this.file)) return [];
    return fs.readFileSync(this.file, "utf8").trim().split("\n").filter(Boolean).slice(-n).map((l) => JSON.parse(l));
  }
  // Calculated: change per turn of each measure over the recorded window.
  trends(n = 20) {
    const rows = this.rows(n);
    if (rows.length < 2) return { turns: rows.length, note: "need at least two recorded turns for trends" };
    const first = rows[0];
    const last = rows[rows.length - 1];
    const span = Math.max(1, last.turn - first.turn);
    const out = {};
    for (const p of last.players) {
      const p0 = first.players.find((x) => x.id === p.id);
      if (!p0) continue;
      out[p.civ] = Object.fromEntries(["score", "techs", "civics", "tourism", "military", "cities"].filter((k) => typeof p[k] === "number" && typeof p0[k] === "number").map((k) => [k, Math.round(((p[k] - p0[k]) / span) * 100) / 100]));
    }
    return { fromTurn: first.turn, toTurn: last.turn, perTurn: out, note: "calculated: (last - first) / turns" };
  }
}

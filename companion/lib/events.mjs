// What is going on in the game, turn by turn.
//
// The in-game panel records game events (wars, deals, research, cities,
// notifications, turn starts) into ExposedMembers.AICivCopilot.events; the
// bridge drains them every poll into data/events.jsonl. situation.lua reads
// the live picture: wars, how each known civ feels about the player and why,
// deals on the table, and what blocks ending the turn.

import fs from "node:fs";
import path from "node:path";

const pretty = (t) =>
  String(t || "?")
    .replace(/^(DIPLO_STATE|ENDTURN_BLOCKING)_/, "")
    .toLowerCase()
    .replace(/_/g, " ");

export class EventLog {
  constructor(dataDir) {
    this.file = path.join(dataDir, "events.jsonl");
  }

  // events: [{ kind, text, turn, ... }] from the panel.
  add(events) {
    const list = (Array.isArray(events) ? events : []).filter((e) => e && e.kind && e.text);
    if (!list.length) return 0;
    const at = new Date().toISOString();
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.appendFileSync(this.file, list.map((e) => JSON.stringify({ at, ...e })).join("\n") + "\n");
    return list.length;
  }

  rows(n = 400) {
    if (!fs.existsSync(this.file)) return [];
    const out = [];
    for (const line of fs.readFileSync(this.file, "utf8").split("\n").slice(-n)) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line));
      } catch {
        // A torn last line from a crash: skip it.
      }
    }
    return out;
  }

  // The events of the last `turns` turns (by game turn), newest last. A new
  // game restarts turn numbers, so only rows after the last turn-number drop
  // count.
  recent({ turns = 2, limit = 60, kinds } = {}) {
    let rows = this.rows();
    for (let i = rows.length - 1; i > 0; i--) {
      if (typeof rows[i].turn === "number" && typeof rows[i - 1].turn === "number" && rows[i].turn < rows[i - 1].turn) {
        rows = rows.slice(i);
        break;
      }
    }
    const last = rows.reduce((m, e) => (typeof e.turn === "number" && e.turn > m ? e.turn : m), -Infinity);
    let out = rows.filter((e) => typeof e.turn !== "number" || e.turn > last - turns);
    if (kinds?.length) out = out.filter((e) => kinds.includes(e.kind));
    return out.slice(-limit);
  }
}

// Events grouped by turn, one line each, repeats folded.
export function formatEvents(events) {
  if (!events?.length) return "No events recorded yet. Events are recorded while the panel is loaded (version 4 or later).";
  const byTurn = new Map();
  for (const e of events) {
    const t = e.turn ?? "?";
    if (!byTurn.has(t)) byTurn.set(t, []);
    const list = byTurn.get(t);
    const prev = list.find((x) => x.text === e.text);
    if (prev) prev.n++;
    else list.push({ kind: e.kind, text: e.text, n: 1, blocking: e.blocking });
  }
  const lines = [];
  for (const [turn, list] of byTurn) {
    lines.push(`Turn ${turn}:`);
    for (const e of list) {
      if (e.kind === "turn") {
        if (e.blocking) lines.push(`- waiting on: ${pretty(e.blocking)}`);
        continue;
      }
      const mark = e.kind === "war" || e.kind === "deal" ? "! " : "";
      lines.push(`- ${mark}${e.text}${e.n > 1 ? ` (x${e.n})` : ""}`);
    }
  }
  return lines.join("\n");
}

// The live situation (situation.lua) in a few lines.
export function formatSituation(s) {
  if (!s || s.error) return `Cannot read the situation: ${s?.error || "no data"}`;
  const lines = [`Turn ${s.turn}.`];
  lines.push(s.wars?.length ? `! At war with: ${s.wars.join(", ")}.` : "At peace with everyone you have met.");
  for (const d of s.deals || []) {
    lines.push(`! Deal from ${d.civ}: they give ${d.gives?.length ? d.gives.join(", ") : "nothing"}; they ask ${d.asks?.length ? d.asks.join(", ") : "nothing"}.`);
  }
  const civs = (s.civs || []).slice().sort((a, b) => (a.moodLevel ?? 50) - (b.moodLevel ?? 50));
  if (civs.length) {
    lines.push("How they feel about you (worst first):");
    for (const c of civs) {
      const why = (c.reasons || []).slice(0, 3).map((r) => `${r.score > 0 ? "+" : ""}${r.score} ${r.text}`).join("; ");
      lines.push(`- ${c.civ}: ${c.atWar ? "AT WAR" : pretty(c.mood)}${c.military != null ? `, military ${c.military}` : ""}${why ? ` (${why})` : ""}`);
    }
  } else {
    lines.push("You have not met any other civilization yet.");
  }
  if (s.blocking) lines.push(`Before ending the turn: ${pretty(s.blocking)}.`);
  return lines.join("\n");
}

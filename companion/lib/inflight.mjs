// Write-ahead record of every Lua call sent to the game.
//
// Each call is logged BEFORE it is sent ("start") and again when it settles:
//   end    the game finished it
//   error  compile/runtime error, or a timeout whose outcome is unknown
//   lost   the connection closed while it was running
// If the game crashes, the suspects are the calls that never settled, were
// lost, or timed out with an unknown outcome - which is how a crash gets
// traced to its cause instead of guessed at. Added after the 2026-10-04 crash,
// whose culprit had to be reconstructed from agent transcripts.

import fs from "node:fs";
import path from "node:path";
import { DEFAULT_DATA_DIR } from "./memory.mjs";

export const INFLIGHT_FILE = path.join(DEFAULT_DATA_DIR, "inflight.jsonl");
const MAX_BYTES = 4 * 1024 * 1024;
const MAX_BODY = 6000;

// The bridge prepends the prelude to every body; keep only what follows it.
function trimBody(body) {
  if (typeof body !== "string") return body;
  const i = body.indexOf("\nlocal P = ");
  let b = i >= 0 ? body.slice(i + 1) : body;
  if (b.length > MAX_BODY) b = `${b.slice(0, MAX_BODY)}...[${b.length} chars]`;
  return b;
}

export function inflightTracer(file = INFLIGHT_FILE) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  } catch {}
  return (ev) => {
    try {
      const e = { at: new Date().toISOString(), ...ev };
      if ("body" in e) e.body = trimBody(e.body);
      fs.appendFileSync(file, JSON.stringify(e) + "\n");
      if (ev.phase === "start" && fs.statSync(file).size > MAX_BYTES) fs.renameSync(file, `${file}.1`);
    } catch {
      // Tracing must never break a call.
    }
  };
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

// Calls that may have hurt the game, newest last:
//   status "in-flight"  started, never settled (the process may have died)
//   status "lost"       the connection closed under it
//   status "unknown"    timed out; the game may still have run it
// Each carries ageSec and whether its process is still alive.
export function suspects(file = INFLIGHT_FILE, { limit = 10, sinceMs } = {}) {
  const starts = new Map();
  const flagged = new Map();
  for (const f of [`${file}.1`, file]) {
    if (!fs.existsSync(f)) continue;
    for (const line of fs.readFileSync(f, "utf8").split("\n")) {
      if (!line) continue;
      let e;
      try {
        e = JSON.parse(line);
      } catch {
        continue;
      }
      const key = `${e.pid}:${e.id}`;
      if (e.phase === "start") {
        starts.set(key, e);
        continue;
      }
      const s = starts.get(key);
      starts.delete(key);
      if (!s) continue;
      if (e.phase === "lost") flagged.set(key, { ...s, status: "lost", settledAt: e.at });
      else if (e.phase === "error" && e.outcome === "unknown") flagged.set(key, { ...s, status: "unknown", settledAt: e.at });
    }
  }
  let list = [...flagged.values(), ...[...starts.values()].map((s) => ({ ...s, status: "in-flight" }))];
  list.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  if (sinceMs) list = list.filter((e) => Date.parse(e.at) >= Date.now() - sinceMs);
  const now = Date.now();
  return list.slice(-limit).map((e) => ({ ...e, ageSec: Math.round((now - Date.parse(e.at)) / 1000), pidAlive: pidAlive(e.pid) }));
}

// Calls that started and never settled at all.
export function unfinished(file = INFLIGHT_FILE, opts = {}) {
  return suspects(file, { ...opts, limit: 1e9 }).filter((e) => e.status === "in-flight").slice(-(opts.limit ?? 10));
}

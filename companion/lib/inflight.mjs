// Write-ahead record of every Lua call sent to the game.
//
// Each call is logged BEFORE it is sent ("start") and again when it finishes
// ("end" / "error"). If the game crashes, the calls with a start and no finish
// are exactly the ones that were running - which is how a crash gets traced
// to its cause instead of guessed at. Added after the 2026-10-04 crash, where
// the culprit had to be reconstructed from agent transcripts.

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

// Calls that started and never finished, newest last.
export function unfinished(file = INFLIGHT_FILE, { limit = 10, sinceMs } = {}) {
  const open = new Map();
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
      if (e.phase === "start") open.set(`${e.pid}:${e.id}`, e);
      else open.delete(`${e.pid}:${e.id}`);
    }
  }
  let list = [...open.values()];
  if (sinceMs) list = list.filter((e) => Date.parse(e.at) >= Date.now() - sinceMs);
  return list.slice(-limit);
}

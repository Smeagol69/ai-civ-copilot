// High-level access to a running Civ VI game over the tuner.
//
// Two Lua states matter:
//   InGame          the UI root. Full read view of the local player, and the
//                   only place player requests (CityManager/UnitManager/UI
//                   .Request*) can be issued - the same path a click takes.
//   GameCore_Tuner  the simulation itself. Direct edits (gold, techs, units,
//                   terrain, visibility) only work here.
// Any other state the game lists can be targeted by name too.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TunerClient } from "./tuner.mjs";
import { inflightTracer } from "./inflight.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const LUA_DIR = path.join(HERE, "..", "lua");

export const UI_STATE = "InGame";
export const CORE_STATE = "GameCore_Tuner";

const luaCache = new Map();
export function loadLua(name) {
  if (!luaCache.has(name)) luaCache.set(name, fs.readFileSync(path.join(LUA_DIR, `${name}.lua`), "utf8"));
  return luaCache.get(name);
}

// JS value -> Lua literal. Strings use decimal escapes for control bytes,
// which Lua 5.1 / Havok Script both accept.
export function toLua(v) {
  if (v === null || v === undefined) return "nil";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") {
    if (!Number.isFinite(v)) return "nil";
    return String(v);
  }
  if (typeof v === "string") {
    // Non-ASCII stays as-is: the frame is UTF-8, so Lua sees UTF-8 bytes.
    let s = '"';
    for (const ch of v) {
      const c = ch.codePointAt(0);
      if (ch === '"') s += '\\"';
      else if (ch === "\\") s += "\\\\";
      else if (c < 0x20 || c === 0x7f) s += `\\${String(c).padStart(3, "0")}`;
      else s += ch;
    }
    return s + '"';
  }
  if (Array.isArray(v)) return `{${v.map(toLua).join(",")}}`;
  if (typeof v === "object") {
    const parts = Object.entries(v).map(([k, val]) =>
      /^[A-Za-z_][A-Za-z0-9_]*$/.test(k) ? `${k}=${toLua(val)}` : `[${toLua(k)}]=${toLua(val)}`,
    );
    return `{${parts.join(",")}}`;
  }
  return "nil";
}

// Joins "J" chunk lines into one JSON value; other lines pass through.
export function decodeLines(lines) {
  const json = [];
  const text = [];
  for (const l of lines) {
    if (l.startsWith("J")) json.push(l.slice(1));
    else text.push(l);
  }
  let value;
  if (json.length) {
    const raw = json.join("");
    try {
      value = JSON.parse(raw);
    } catch (err) {
      throw new Error(`could not parse JSON from game (${raw.length} chars): ${err.message}`);
    }
  }
  return { value, text };
}

export function buildScript(body, params = {}) {
  return `${loadLua("prelude")}\nlocal P = ${toLua(params)}\n${body}`;
}

export class Game {
  // trace: false disables the in-flight log (tests do, via NODE_TEST_CONTEXT).
  constructor({ tuner, host, port, log = () => {}, trace } = {}) {
    const tracer = trace === false || (trace === undefined && process.env.NODE_TEST_CONTEXT) ? undefined : trace || inflightTracer();
    this.tuner = tuner || new TunerClient({ host, port, log, trace: tracer });
    this.log = log;
  }

  get connected() {
    return this.tuner.connected;
  }

  async ensureConnected() {
    if (!this.tuner.connected) await this.tuner.connect();
  }

  async states() {
    await this.ensureConnected();
    return this.tuner.refreshStates();
  }

  // Run a named script from lua/ with params; returns decoded JSON.
  async script(name, params = {}, { state = UI_STATE, timeoutMs } = {}) {
    await this.ensureConnected();
    const lines = await this.tuner.exec(state, buildScript(loadLua(name), params), { timeoutMs, label: `script:${name}` });
    return decodeLines(lines).value;
  }

  // Run arbitrary Lua. The prelude is available (emit, emitJson, try, L,
  // J.encode), so callers can return structured data with emitJson(...).
  async lua(state, code, { params = {}, timeoutMs } = {}) {
    await this.ensureConnected();
    const lines = await this.tuner.exec(state, buildScript(code, params), { timeoutMs, label: "lua" });
    return decodeLines(lines);
  }

  async snapshot({ includeBuildable = true, foreignRadius = 6 } = {}) {
    return this.script("snapshot", { includeBuildable, foreignRadius }, { timeoutMs: 60000 });
  }

  async tiles(x, y, radius = 2, revealAll = false) {
    return this.script("plots", { x, y, radius, revealAll });
  }

  async inspect(state, expression, { maxKeys = 2000, walkMeta = true } = {}) {
    const body = `local __target = function() return (${expression}) end\n${loadLua("inspect")}`;
    const { value } = await this.lua(state, body, { params: { maxKeys, walkMeta } });
    return value;
  }

  async apiScan(state, candidates = [], gameInfoCandidates = []) {
    return this.script("apiscan", { candidates, gameInfoCandidates }, { state, timeoutMs: 120000 });
  }
}

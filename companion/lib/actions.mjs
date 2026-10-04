// Typed action catalog. Each entry names the Lua state it runs in, its
// parameter schema, and whether it is a PLAY request (asynchronous, read back
// afterwards) or a direct EDIT (synchronous, returns before/after itself).
//
// Validation happens twice: here against the schema, and in the game, which
// has the final word (CanStart* for play, the API's own result for edits).
// Nothing is reported as done until the game's own state says so.

import { UI_STATE, CORE_STATE, loadLua, buildScript, decodeLines } from "./game.mjs";

const int = { type: "integer" };
const str = { type: "string" };
const player = { type: "integer", description: "Player id; defaults to the local player" };
const treeMode = { type: "string", enum: ["front", "replace", "append"] };

export const ACTIONS = {
  // ---------------------------------------------------------------- PLAY
  set_production: {
    kind: "play", state: UI_STATE,
    description: "Set what a city builds (replaces current production unless append=true). item is a database type: UNIT_*, BUILDING_*, DISTRICT_*, PROJECT_*. Districts and wonders need x,y.",
    properties: { cityId: int, item: str, x: int, y: int, append: { type: "boolean" } },
    required: ["cityId", "item"],
  },
  purchase: {
    kind: "play", state: UI_STATE,
    description: "Buy an item in a city with gold or faith. yield is YIELD_GOLD (default) or YIELD_FAITH.",
    properties: { cityId: int, item: str, yield: { type: "string", enum: ["YIELD_GOLD", "YIELD_FAITH"] } },
    required: ["cityId", "item"],
  },
  set_research: {
    kind: "play", state: UI_STATE,
    description: "Research a tech (TECH_*), including far ones (the game's own path is queued). mode: front (default: research it now, then continue the existing queue), replace (queue becomes just this path, like a click in the tech tree), append (after the existing queue, like shift-click).",
    properties: { tech: str, mode: treeMode }, required: ["tech"],
  },
  set_civic: {
    kind: "play", state: UI_STATE,
    description: "Progress a civic (CIVIC_*), including far ones. mode: front (default), replace, or append - same meaning as set_research.",
    properties: { civic: str, mode: treeMode }, required: ["civic"],
  },
  move_unit: {
    kind: "play", state: UI_STATE,
    description: "Order a unit to move to a tile (pathfinds; may take several turns).",
    properties: { unitId: int, x: int, y: int }, required: ["unitId", "x", "y"],
  },
  unit_operation: {
    kind: "play", state: UI_STATE,
    description: "Run any unit operation by database name (UNITOPERATION_FORTIFY, _SLEEP, _SKIP_TURN, _HEAL, _FOUND_CITY, _BUILD_IMPROVEMENT with improvement, _RANGE_ATTACK with x,y, ...). Use unit_actions first to see what is allowed.",
    properties: { unitId: int, operation: str, x: int, y: int, improvement: str }, required: ["unitId", "operation"],
  },
  unit_command: {
    kind: "play", state: UI_STATE,
    description: "Run any unit command by database name (UNITCOMMAND_UPGRADE, _PROMOTE with promotion, _DELETE, _AUTOMATE, ...).",
    properties: { unitId: int, command: str, x: int, y: int, promotion: str }, required: ["unitId", "command"],
  },
  end_turn: {
    kind: "play", state: UI_STATE,
    description: "End the turn (same as pressing the end-turn button).",
    properties: {}, required: [],
  },
  look_at: {
    kind: "play", state: UI_STATE, noVerify: true,
    description: "Move the player's camera to a tile.",
    properties: { x: int, y: int }, required: ["x", "y"],
  },
  // ---------------------------------------------------------------- EDIT
  change_gold: {
    kind: "edit", state: CORE_STATE,
    description: "Add (or subtract, if negative) gold.",
    properties: { amount: { type: "number" }, playerId: player }, required: ["amount"],
  },
  change_faith: {
    kind: "edit", state: CORE_STATE,
    description: "Add (or subtract) faith.",
    properties: { amount: { type: "number" }, playerId: player }, required: ["amount"],
  },
  grant_tech: {
    kind: "edit", state: CORE_STATE,
    description: "Instantly grant a technology.",
    properties: { tech: str, playerId: player }, required: ["tech"],
  },
  grant_civic: {
    kind: "edit", state: CORE_STATE,
    description: "Instantly grant a civic.",
    properties: { civic: str, playerId: player }, required: ["civic"],
  },
  finish_production: {
    kind: "edit", state: CORE_STATE,
    description: "Instantly complete a city's current production.",
    properties: { cityId: int, playerId: player }, required: ["cityId"],
  },
  change_population: {
    kind: "edit", state: CORE_STATE,
    description: "Add or remove citizens in a city.",
    properties: { cityId: int, delta: int, playerId: player }, required: ["cityId", "delta"],
  },
  spawn_unit: {
    kind: "edit", state: CORE_STATE,
    description: "Create a unit (UNIT_*) at or next to a tile.",
    properties: { unitType: str, x: int, y: int, playerId: player }, required: ["unitType", "x", "y"],
  },
  kill_unit: {
    kind: "edit", state: CORE_STATE,
    description: "Remove a unit immediately (any player's).",
    properties: { unitId: int, playerId: player }, required: ["unitId"],
  },
  heal_unit: {
    kind: "edit", state: CORE_STATE,
    description: "Set a unit's damage (0 = full health).",
    properties: { unitId: int, damage: int, playerId: player }, required: ["unitId"],
  },
  restore_moves: {
    kind: "edit", state: CORE_STATE,
    description: "Give a unit its full movement back this turn.",
    properties: { unitId: int, playerId: player }, required: ["unitId"],
  },
  add_experience: {
    kind: "edit", state: CORE_STATE,
    description: "Give a unit experience points.",
    properties: { unitId: int, amount: int, playerId: player }, required: ["unitId", "amount"],
  },
  set_terrain: {
    kind: "edit", state: CORE_STATE,
    description: "Change a tile's terrain (TERRAIN_*).",
    properties: { x: int, y: int, terrain: str }, required: ["x", "y", "terrain"],
  },
  set_feature: {
    kind: "edit", state: CORE_STATE,
    description: "Set or clear (omit feature) a tile's feature (FEATURE_*).",
    properties: { x: int, y: int, feature: str }, required: ["x", "y"],
  },
  set_resource: {
    kind: "edit", state: CORE_STATE,
    description: "Set or clear (omit resource) a tile's resource (RESOURCE_*).",
    properties: { x: int, y: int, resource: str, amount: int }, required: ["x", "y"],
  },
  set_improvement: {
    kind: "edit", state: CORE_STATE,
    description: "Set or clear (omit improvement) a tile's improvement (IMPROVEMENT_*).",
    properties: { x: int, y: int, improvement: str, owner: int }, required: ["x", "y"],
  },
  reveal_map: {
    kind: "edit", state: CORE_STATE,
    description: "Reveal the whole map for a player.",
    properties: { playerId: player }, required: [],
  },
  meet_player: {
    kind: "edit", state: CORE_STATE,
    description: "Make a player meet another player.",
    properties: { otherId: int, playerId: player }, required: ["otherId"],
  },
  declare_war: {
    kind: "edit", state: CORE_STATE,
    description: "Declare war on another player (bypasses the usual diplomacy flow).",
    properties: { otherId: int, playerId: player }, required: ["otherId"],
  },
  make_peace: {
    kind: "edit", state: CORE_STATE,
    description: "Make peace with another player.",
    properties: { otherId: int, playerId: player }, required: ["otherId"],
  },
};

// Read-only helpers that live in actions.lua but are not writes.
export const ACTION_QUERIES = {
  unit_actions: { state: UI_STATE, properties: { unitId: int }, required: ["unitId"] },
};

function checkType(v, schema) {
  if (schema.type === "integer") return Number.isInteger(v);
  if (schema.type === "number") return typeof v === "number" && Number.isFinite(v);
  if (schema.type === "string") return typeof v === "string" && (!schema.enum || schema.enum.includes(v));
  if (schema.type === "boolean") return typeof v === "boolean";
  return true;
}

// Schema check. Refuses the whole action rather than half-running it.
export function validateAction(name, args = {}) {
  const def = ACTIONS[name] || ACTION_QUERIES[name];
  if (!def) return { ok: false, reason: `unknown action "${name}". Known: ${Object.keys(ACTIONS).join(", ")}` };
  const errors = [];
  for (const r of def.required) if (args[r] === undefined || args[r] === null) errors.push(`missing ${r}`);
  for (const [k, v] of Object.entries(args)) {
    const schema = def.properties[k];
    if (!schema) errors.push(`unknown parameter ${k}`);
    else if (v !== undefined && v !== null && !checkType(v, schema)) errors.push(`${k} must be ${schema.type}`);
  }
  if (["x", "y"].some((k) => k in args) && !(Number.isInteger(args.x) && Number.isInteger(args.y))) {
    errors.push("x and y go together");
  }
  return errors.length ? { ok: false, reason: errors.join("; ") } : { ok: true };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function runActionLua(game, state, P) {
  await game.ensureConnected();
  const lines = await game.tuner.exec(state, buildScript(loadLua("actions"), P), { timeoutMs: 20000, label: `action:${P.action}` });
  return decodeLines(lines).value;
}

// Execute one action and return the game's own account of what happened.
// Requests are asynchronous; read back a few times before calling it failed.
const VERIFY_DELAYS_MS = [350, 500, 800, 1200];

export async function performAction(game, name, args = {}, { journal, verifyDelayMs } = {}) {
  const v = validateAction(name, args);
  if (!v.ok) return { action: name, ok: false, stage: "validate", reason: v.reason };
  const def = ACTIONS[name] || ACTION_QUERIES[name];
  const started = Date.now();
  let result;
  try {
    result = await runActionLua(game, def.state, { ...args, action: name });
  } catch (err) {
    result = { ok: false, reason: err.message };
  }
  const out = { action: name, kind: def.kind || "query", args, ...result };
  if (def.kind === "play" && result?.ok && result.requested && !def.noVerify) {
    // Requests are processed by the game asynchronously. Read the world back,
    // retrying briefly: an early read was observed live to miss a change that
    // landed a moment later.
    const delays = verifyDelayMs !== undefined ? [verifyDelayMs] : VERIFY_DELAYS_MS;
    const extra = { before: result.before, queueBefore: result.queueBefore };
    for (let i = 0; i < delays.length; i++) {
      await sleep(delays[i]);
      try {
        out.verified = await runActionLua(game, def.state, { ...args, ...extra, action: `verify_${name}` });
      } catch (err) {
        out.verified = { ok: false, reason: `read-back failed: ${err.message}` };
      }
      out.verified = out.verified || { ok: false, reason: "read-back returned no data" };
      out.verified.attempts = i + 1;
      if (out.verified.ok) break;
    }
    out.ok = !!out.verified?.ok;
    if (!out.ok) out.reason = out.reason || "requested, but the game's state does not show it took effect";
  }
  out.ms = Date.now() - started;
  if (journal && def.kind) journal.record({ type: "action", ...out });
  return out;
}

// Typed action catalog. Each entry names the Lua state it runs in, its
// parameter schema, and whether it is a PLAY request (asynchronous, read back
// afterwards) or a direct EDIT (synchronous, returns before/after itself).
//
// Validation happens twice: here against the schema, and in the game, which
// has the final word (CanStart* for play, the API's own result for edits).
// Nothing is reported as done until the game's own state says so.

import { UI_STATE, CORE_STATE, loadLua, decodeLines } from "./game.mjs";

const int = { type: "integer" };
const str = { type: "string" };
const player = { type: "integer", description: "Player id; defaults to the local player" };
const treeMode = { type: "string", enum: ["front", "replace", "append"] };

export const ACTIONS = {
  // ---------------------------------------------------------------- PLAY
  set_production: {
    kind: "play", state: UI_STATE,
    description: "Set what a city builds. item is a database type: UNIT_*, BUILDING_*, DISTRICT_*, PROJECT_*; districts and wonders need x,y. mode: current (default: replace the current item, keep the rest of the queue - a click in the production panel), append (add to the end of the queue), exclusive (the queue becomes just this item). append=true is the same as mode append.",
    properties: { cityId: int, item: str, x: int, y: int, mode: { type: "string", enum: ["current", "append", "exclusive"] }, append: { type: "boolean" } },
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
    description: "Run any unit operation by database name (UNITOPERATION_FORTIFY, _SLEEP, _SKIP_TURN, _HEAL, _FOUND_CITY, _BUILD_IMPROVEMENT with improvement (defaults to the unit's tile), _RANGE_ATTACK with x,y, ...). Use unit_actions first to see what is allowed. An attack that would start a war is refused unless allowWar=true - only set that when the player asked for war.",
    properties: { unitId: int, operation: str, x: int, y: int, improvement: str, allowWar: { type: "boolean" } }, required: ["unitId", "operation"],
  },
  unit_command: {
    kind: "play", state: UI_STATE,
    description: "Run any unit command by database name (UNITCOMMAND_UPGRADE, _PROMOTE with promotion (must be one the game offers now), _DELETE, _AUTOMATE, ...).",
    properties: { unitId: int, command: str, x: int, y: int, promotion: str }, required: ["unitId", "command"],
  },
  end_turn: {
    kind: "play", state: UI_STATE,
    // AI turns can take a while; the read-back waits for the turn number to move.
    verifyDelays: [1500, 3000, 6000, 10000],
    description: "End the turn (same as pressing the end-turn button). Confirmed only when the turn number advances.",
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
    description: "Grant a technology through the research-progress interface (as Firaxis' tuner does, so all completion events fire); it may complete when the game next processes research.",
    properties: { tech: str, playerId: player }, required: ["tech"],
  },
  grant_civic: {
    kind: "edit", state: CORE_STATE,
    description: "Grant a civic through the culture-progress interface; it may complete when the game next processes culture.",
    properties: { civic: str, playerId: player }, required: ["civic"],
  },
  finish_production: {
    kind: "edit", state: CORE_STATE,
    description: "Instantly complete a city's current production.",
    properties: { cityId: int, playerId: player }, required: ["cityId"],
  },
  change_population: {
    kind: "edit", state: CORE_STATE,
    description: "Add or remove citizens in a city (|delta| up to 30; never below 1 citizen).",
    properties: { cityId: int, delta: int, playerId: player }, required: ["cityId", "delta"],
  },
  spawn_unit: {
    kind: "edit", state: CORE_STATE,
    description: "Create a unit (UNIT_*) on a valid tile at or near x,y (radius 0-3, default 1). Reports the new unit's id.",
    properties: { unitType: str, x: int, y: int, radius: int, playerId: player }, required: ["unitType", "x", "y"],
  },
  kill_unit: {
    kind: "edit", state: CORE_STATE,
    description: "Remove a unit immediately (any player's).",
    properties: { unitId: int, playerId: player }, required: ["unitId"],
  },
  heal_unit: {
    kind: "edit", state: CORE_STATE,
    description: "Set a unit's damage (0 = full health, up to max-1; use kill_unit to remove).",
    properties: { unitId: int, damage: int, playerId: player }, required: ["unitId"],
  },
  restore_moves: {
    kind: "edit", state: CORE_STATE,
    description: "Restore a unit's movement and attacks this turn (as Firaxis' tuner does).",
    properties: { unitId: int, playerId: player }, required: ["unitId"],
  },
  add_experience: {
    kind: "edit", state: CORE_STATE,
    description: "Give a unit experience points.",
    properties: { unitId: int, amount: int, playerId: player }, required: ["unitId", "amount"],
  },
  set_terrain: {
    kind: "edit", state: CORE_STATE,
    description: "Change a tile's terrain (TERRAIN_*). Land/water changes are refused on tiles with a city, district or units.",
    properties: { x: int, y: int, terrain: str }, required: ["x", "y", "terrain"],
  },
  set_feature: {
    kind: "edit", state: CORE_STATE,
    description: "Set or clear (omit feature) a tile's feature (FEATURE_*). Natural wonders are refused.",
    properties: { x: int, y: int, feature: str }, required: ["x", "y"],
  },
  set_resource: {
    kind: "edit", state: CORE_STATE,
    description: "Set or clear (omit resource) a tile's resource (RESOURCE_*).",
    properties: { x: int, y: int, resource: str, amount: int }, required: ["x", "y"],
  },
  set_improvement: {
    kind: "edit", state: CORE_STATE,
    description: "Set or clear (omit improvement) a tile's improvement (IMPROVEMENT_*). Refused where the game says the tile cannot have it, unless force=true. owner -1 = no owner.",
    properties: { x: int, y: int, improvement: str, owner: int, force: { type: "boolean" } }, required: ["x", "y"],
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
    description: "Declare war on another player (bypasses the usual diplomacy flow). warType is a WarTypes name (default FORMAL_WAR). Refused when the game says it cannot be declared.",
    properties: { otherId: int, warType: str, playerId: player }, required: ["otherId"],
  },
  make_peace: {
    kind: "edit", state: CORE_STATE,
    description: "Make peace with another player. Its engine call has no Firaxis example to copy, so it only runs with experimental=true; save the game first.",
    properties: { otherId: int, experimental: { type: "boolean" }, playerId: player }, required: ["otherId"],
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
  // Through Game.exec, so the pause and multiplayer locks apply to actions too.
  const lines = await game.exec(state, loadLua("actions"), { params: P, timeoutMs: 20000, label: `action:${P.action}` });
  return decodeLines(lines).value || { ok: false, reason: "the game returned no data" };
}

// A lost connection or a call with an unknown outcome means the game may be
// gone or still busy: never pile more calls on it.
const isTransportError = (err) => !!err && (err.code === "lost" || err.code === "timeout" || err.code === "wrong-state" || /not connected|no Civ VI tuner/.test(err.message));

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
    if (isTransportError(err)) {
      result.outcome = err.outcome || "unknown";
      result.reason = `${err.message} - the action may or may not have been applied; read the game before retrying`;
    }
  }
  const { verifyArgs, ...shown } = result;
  const out = { action: name, kind: def.kind || "query", args, ...shown };
  if (def.kind === "play" && result?.ok && result.requested && !def.noVerify) {
    // Requests are processed by the game asynchronously. Read the world back,
    // retrying briefly: an early read was observed live to miss a change that
    // landed a moment later.
    const delays = verifyDelayMs !== undefined ? [verifyDelayMs] : def.verifyDelays || VERIFY_DELAYS_MS;
    const extra = verifyArgs || {};
    for (let i = 0; i < delays.length; i++) {
      await sleep(delays[i]);
      try {
        out.verified = await runActionLua(game, def.state, { ...args, ...extra, action: `verify_${name}` });
      } catch (err) {
        out.verified = { ok: false, reason: `read-back failed: ${err.message}` };
        if (isTransportError(err)) {
          // Only retry when the game answered "not yet"; never on a dead link.
          out.verified.transportError = true;
          out.verified.attempts = i + 1;
          break;
        }
      }
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

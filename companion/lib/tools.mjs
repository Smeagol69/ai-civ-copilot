// Tool definitions (Anthropic Messages shape) and dispatch.
//
// Four families:
//   read      snapshot sections, cities, tiles, database rows
//   solve     deterministic answers - the model calls these for any number
//   write     typed actions (play + edit) and raw Lua in any Lua state
//   expand    discover the API (inspect, scan, search catalog + game
//             scripts), save working Lua as a new named ability, record
//             verified facts. Saved abilities come back as tools.

import { ACTIONS, performAction, validateAction } from "./actions.mjs";
import { UI_STATE, CORE_STATE } from "./game.mjs";
import * as solve from "./solvers.mjs";
import * as dig from "./discovery.mjs";
import { analyzeStanding } from "./strategy.mjs";

const MAX_RESULT_CHARS = 60000;
const SECTIONS = ["meta", "me", "techs", "civics", "cities", "units", "players", "visibleForeignUnits", "resources", "exploration", "gaps"];

const obj = (properties = {}, required = []) => ({ type: "object", properties, required, additionalProperties: false });
const S = (description) => ({ type: "string", description });
const I = (description) => ({ type: "integer", description });
const B = (description) => ({ type: "boolean", description });

const actionList = Object.entries(ACTIONS)
  .map(([n, d]) => `- ${n} [${d.kind}] (${Object.keys(d.properties).join(", ") || "no args"}): ${d.description}`)
  .join("\n");

export const STATIC_TOOLS = [
  // ------------------------------------------------------------------ read
  {
    name: "get_state",
    description: `Read one section of the live game snapshot (the full data, not the lean view). Sections: ${SECTIONS.join(", ")}. Re-reads the game if anything was written since the last read.`,
    input_schema: obj({ section: { type: "string", enum: SECTIONS } }, ["section"]),
  },
  {
    name: "get_city",
    description: "Full record for one city, including everything it can produce right now with turn counts.",
    input_schema: obj({ cityId: I("city id from the snapshot") }, ["cityId"]),
  },
  {
    name: "get_tiles",
    description: "Tiles around a point: terrain, feature, resource, improvement, district, owner, yields, appeal, visible units. Fogged tiles are omitted unless revealAll is true.",
    input_schema: obj({ x: I("x"), y: I("y"), radius: I("0-6, default 2"), revealAll: B("include unrevealed tiles (reads through fog)") }, ["x", "y"]),
  },
  {
    name: "query_gameinfo",
    description: "Read rows of any game database table (GameInfo.<table>): Units, Buildings, Districts, Technologies, Civics, Policies, Improvements, Resources, Features, Terrains, UnitPromotions, Modifiers, Leaders, ... match filters rows by substring on any text column.",
    input_schema: obj({ table: S("GameInfo table name"), match: S("optional substring filter"), columns: { type: "array", items: { type: "string" }, description: "optional columns to keep" }, limit: I("max rows, default 40") }, ["table"]),
  },
  {
    name: "unit_actions",
    description: "List the unit operations and commands the game says a unit can perform right now.",
    input_schema: obj({ unitId: I("unit id") }, ["unitId"]),
  },
  {
    name: "refresh_snapshot",
    description: "Force a fresh read of the whole game state.",
    input_schema: obj(),
  },
  {
    name: "recent_changes",
    description: "The write journal: recent actions and Lua runs with the game's before/after.",
    input_schema: obj({ n: I("how many, default 15") }),
  },
  // ----------------------------------------------------------------- solve
  { name: "empire_summary", description: "Totals and headline numbers for the local empire, computed from the game's values.", input_schema: obj() },
  { name: "production_overview", description: "Every city's production, ETA, growth, housing room and amenity balance; lists idle, housing-capped and unhappy cities.", input_schema: obj() },
  { name: "threat_report", description: "Visible foreign military units near our territory, hostile ones first, with nearest city.", input_schema: obj() },
  { name: "rival_comparison", description: "Score, cities, military strength and tech count for every met civilization, ranked.", input_schema: obj() },
  {
    name: "find_units",
    description: "Filter our units by type substring, idleness, and/or distance from a tile.",
    input_schema: obj({ type: S("substring of UNIT_ type"), idleOnly: B("only units with moves left and no standing order"), x: I("near x"), y: I("near y"), radius: I("radius, default 3") }),
  },
  {
    name: "research_path",
    description: "Prerequisite-ordered list of techs still needed to reach a target tech, with remaining science and an estimated turn count.",
    input_schema: obj({ target: S("TECH_* type") }, ["target"]),
  },
  // ----------------------------------------------------------------- write
  {
    name: "perform_action",
    description: `Change the game. PLAY actions go through the game's own request path and are checked by the game like a click, then read back. EDIT actions change the simulation directly and return before/after. Available:\n${actionList}\nIf what you need is not here, use run_lua (and then save_ability).`,
    input_schema: obj({ action: { type: "string", enum: Object.keys(ACTIONS) }, args: { type: "object", description: "parameters for the action" } }, ["action"]),
  },
  {
    name: "run_lua",
    description: `Run arbitrary Lua inside the running game. state: "${UI_STATE}" (UI root: full read view of the local player, and player requests via CityManager/UnitManager/UI.Request*) or "${CORE_STATE}" (the simulation: direct edits to any player, city, unit, plot), or any other state from list_lua_states. Helpers in scope: emit(s) prints a line back to you; emitJson(v) returns a value as JSON; try(name, fn) runs fn and records a failure instead of aborting; L(key) localizes; P holds params. Havok Script = Lua 5.1 (no goto, no //, no bit ops). Write small probes first, check results, then act.`,
    input_schema: obj({ state: S("Lua state name"), code: S("Lua source"), params: { type: "object", description: "values available as P.<name>" }, timeoutMs: I("default 20000") }, ["state", "code"]),
  },
  // ---------------------------------------------------------------- expand
  {
    name: "list_lua_states",
    description: "All Lua states the game currently exposes (UI contexts, GameCore_Tuner, mod scripts...). Any of them can be targeted by run_lua.",
    input_schema: obj(),
  },
  {
    name: "inspect_api",
    description: "List every method and field a live value exposes, walking its metatables. expression is any Lua expression valid in that state, e.g. Players[Game.GetLocalPlayer()]:GetCulture(), UnitManager, Map.GetPlot(10,10). (Havok Script has no _G, getfenv, rawget or debug; use search_api to find global names.)",
    input_schema: obj({ state: S("Lua state name"), expression: S("Lua expression") }, ["state", "expression"]),
  },
  {
    name: "scan_api",
    description: "Catalog the whole API surface of a Lua state (globals, enums, methods of player/city/unit/plot objects, GameInfo tables) and save it. Run once per state per game version; then use search_api.",
    input_schema: obj({ state: S("Lua state name") }, ["state"]),
  },
  {
    name: "search_api",
    description: "Search the saved API catalogs for functions, methods, enums or tables by name (substring or /regex/).",
    input_schema: obj({ query: S("name fragment or /regex/"), state: S("optional state filter") }, ["query"]),
  },
  {
    name: "search_game_scripts",
    description: "Search Firaxis' shipped Lua/XML/SQL in the game install for real usage of a function - the most reliable documentation of argument shapes and which context a call works in. pattern is text or /regex/.",
    input_schema: obj({ pattern: S("text or /regex/"), ext: S(".lua (default), .xml, .sql, or empty for all"), pathFilter: S("only files whose path contains this"), context: I("lines of context, default 0"), maxResults: I("default 40") }, ["pattern"]),
  },
  {
    name: "read_game_file",
    description: "Read lines from a file in the game install (path relative to the install, as search_game_scripts prints it).",
    input_schema: obj({ path: S("relative path"), from: I("first line, default 1"), count: I("lines, default 120") }, ["path"]),
  },
  {
    name: "save_ability",
    description: "Save Lua that worked as a permanent, named, parameterised ability. It becomes a tool named ability__<name> on every later request. Provide test_params to run it once before saving; it is saved only if that run succeeds. Re-saving a name keeps the old version in history.",
    input_schema: obj({
      name: S("lower_snake_case"),
      description: S("what it does and when to use it"),
      state: S("Lua state it runs in"),
      lua: S("Lua body; read params from P; return data with emitJson"),
      parameters: { type: "object", description: "JSON-schema properties for its params, e.g. {\"cityId\":{\"type\":\"integer\"}}" },
      required: { type: "array", items: { type: "string" } },
      kind: { type: "string", enum: ["query", "play", "edit"], description: "query reads only; play/edit change the game" },
      test_params: { type: "object", description: "params for a test run before saving" },
    }, ["name", "description", "state", "lua"]),
  },
  { name: "list_abilities", description: "All saved abilities with their descriptions, parameters and usage counts.", input_schema: obj() },
  // ------------------------------------------------------------------ dig
  {
    name: "dig_map",
    description: "Map the game's whole API (offline, about a second): every function from the live catalogs, matched against Firaxis' own scripts, classified read/write, scored by how much a new feature it could give. Writes used in Firaxis' cheat panels rank highest. Run after a game patch or a new scan_api.",
    input_schema: obj(),
  },
  {
    name: "dig_probe",
    description: "Live, read-only: call a batch of zero-argument getters on real game objects - only those Firaxis' scripts call with zero arguments on the same kind of object - and record what they return.",
    input_schema: obj({ limit: I("how many, default 120") }),
  },
  {
    name: "dig_frontier",
    description: "The next things worth turning into abilities: high-leverage functions (default: writes) with shipped call sites, not yet proven, blocked or saved. Each comes with its evidence (file, line, code).",
    input_schema: obj({ limit: I("default 10"), holder: S("filter by object, e.g. Unit, City:GetBuildQueue"), kind: { type: "string", enum: ["write", "read", "action", "other"] } }),
  },
  {
    name: "dig_mark",
    description: "Record what you learned about one function in the dig map: status proven (tested live with revert), ability (saved as an ability), or blocked (not usable - say why). Always mark what you tried.",
    input_schema: obj({ state: S("Lua state"), holder: S("holder as dig_frontier shows it"), method: S("method name"), status: { type: "string", enum: ["proven", "ability", "blocked"] }, note: S("what you found"), ability: S("ability name, if saved") }, ["state", "holder", "method", "status", "note"]),
  },
  { name: "dig_status", description: "How far the digging has got: counts by status and kind, writes with evidence, proven, blocked, recent runs.", input_schema: obj() },
  {
    name: "victory_standing",
    description: "Where every known civ stands on each enabled road to victory (science, culture, diplomacy, religion, domination, score) from the game's own numbers, the player's strongest road, and the biggest threat (calculated).",
    input_schema: obj(),
  },
  { name: "standing_trends", description: "Per-turn change of score, techs, civics, tourism, military and cities for every known civ, from the recorded history (calculated).", input_schema: obj({ turns: I("window, default 20") }) },
  {
    name: "remember_api_fact",
    description: "Record a verified fact about the game's API (e.g. 'Players[id]:GetCulture():SetCivic(idx,true) works in GameCore_Tuner, not InGame'). Facts are shown to you on every later request. Only record what a result proved.",
    input_schema: obj({ fact: S("the fact"), topic: S("short topic tag") }, ["fact"]),
  },
];

export function abilityTools(memory) {
  return memory.listAbilities().map((a) => ({
    name: `ability__${a.name}`,
    description: `[saved ability, ${a.kind}, runs in ${a.state}] ${a.description}`,
    input_schema: obj(a.properties || {}, a.required || []),
  }));
}

export function allTools(memory) {
  return [...STATIC_TOOLS, ...abilityTools(memory)];
}

function clip(value) {
  let s = typeof value === "string" ? value : JSON.stringify(value);
  if (s === undefined) s = "null";
  if (s.length > MAX_RESULT_CHARS) s = s.slice(0, MAX_RESULT_CHARS) + `\n...[truncated ${s.length - MAX_RESULT_CHARS} chars; narrow the request]`;
  return s;
}

// ctx: { game, memory, files, snapshot(), markStale(), onProgress(text) }
export async function dispatchTool(ctx, name, input = {}) {
  const { game, memory, files } = ctx;
  switch (name) {
    case "get_state": {
      const snap = await ctx.snapshot();
      return snap?.[input.section] ?? { unknown: `section ${input.section} is not in the snapshot`, gaps: snap?.gaps };
    }
    case "get_city": {
      const snap = await ctx.snapshot();
      const c = (snap.cities || []).find((x) => x.id === Number(input.cityId));
      return c || { error: `no city ${input.cityId}`, cities: (snap.cities || []).map((x) => ({ id: x.id, name: x.name })) };
    }
    case "get_tiles":
      return game.tiles(input.x, input.y, input.radius ?? 2, !!input.revealAll);
    case "query_gameinfo": {
      const { value } = await game.lua(UI_STATE, QUERY_GAMEINFO_LUA, { params: { table: input.table, match: input.match, limit: input.limit ?? 40 } });
      if (value?.rows && input.columns?.length) {
        const seen = new Set(value.rows.flatMap((r) => Object.keys(r)));
        const unknown = input.columns.filter((c) => !seen.has(c));
        value.rows = value.rows.map((r) => Object.fromEntries(input.columns.filter((c) => c in r).map((c) => [c, r[c]])));
        if (unknown.length) {
          value.unknownColumns = unknown;
          value.availableColumns = [...seen].sort();
        }
      }
      return value;
    }
    case "unit_actions":
      return performAction(game, "unit_actions", { unitId: input.unitId });
    case "refresh_snapshot": {
      ctx.markStale();
      return solve.empireSummary(await ctx.snapshot());
    }
    case "recent_changes":
      return memory.recentJournal(input.n ?? 15);

    case "empire_summary":
      return solve.empireSummary(await ctx.snapshot());
    case "production_overview":
      return solve.productionOverview(await ctx.snapshot());
    case "threat_report":
      return solve.threatReport(await ctx.snapshot());
    case "rival_comparison":
      return solve.rivalComparison(await ctx.snapshot());
    case "find_units":
      if ((input.x === undefined) !== (input.y === undefined) || (input.radius !== undefined && input.x === undefined)) {
        return { error: "the near filter needs both x and y (and radius only with them)" };
      }
      return solve.findUnits(await ctx.snapshot(), {
        type: input.type, idleOnly: input.idleOnly,
        near: Number.isInteger(input.x) && Number.isInteger(input.y) ? { x: input.x, y: input.y } : undefined,
        radius: input.radius,
      });
    case "research_path": {
      const snap = await ctx.snapshot();
      const { value } = await game.lua(UI_STATE, TECH_PREREQS_LUA);
      return solve.researchPath(snap, value?.prereqs || {}, String(input.target || "").toUpperCase(), value?.costs || {}, value?.progress || {});
    }

    case "perform_action": {
      const args = input.args || {};
      const v = validateAction(input.action, args);
      if (!v.ok) return { ok: false, stage: "validate", reason: v.reason, schema: ACTIONS[input.action]?.properties };
      ctx.onProgress?.(`Doing: ${input.action}`);
      const res = await performAction(game, input.action, args, { journal: memory });
      ctx.markStale();
      return res;
    }
    case "run_lua": {
      ctx.onProgress?.(`Running Lua in ${input.state}`);
      try {
        const { value, text } = await game.lua(input.state, input.code, { params: input.params || {}, timeoutMs: input.timeoutMs ?? 20000 });
        memory.record({ type: "lua", state: input.state, code: input.code.slice(0, 4000), ok: true, output: clip({ value, text }).slice(0, 2000) });
        ctx.markStale();
        return { ok: true, value, output: text };
      } catch (err) {
        memory.record({ type: "lua", state: input.state, code: input.code.slice(0, 4000), ok: false, error: err.message });
        return { ok: false, error: err.message, kind: err.code };
      }
    }

    case "list_lua_states":
      return game.states();
    case "inspect_api":
      return game.inspect(input.state, input.expression);
    case "scan_api": {
      ctx.onProgress?.(`Scanning the ${input.state} API`);
      const candidates = files?.available?.() ? files.globalCandidates() : [];
      const giCandidates = files?.available?.() ? files.gameInfoCandidates() : [];
      const cat = await game.apiScan(input.state, candidates, giCandidates);
      if (!cat) return { ok: false, error: "scan returned nothing" };
      const file = memory.saveCatalog(input.state, cat);
      return {
        ok: true, savedTo: file,
        candidatesChecked: candidates.length,
        globals: Object.keys(cat.globals || {}).length,
        globalFunctionTables: Object.values(cat.globals || {}).filter(Array.isArray).length,
        objects: Object.fromEntries(Object.entries(cat.objects || {}).map(([k, v]) => [k, v.length])),
        enums: Object.keys(cat.enums || {}).length,
        gameInfoTables: (cat.gameInfoTables || []).length,
      };
    }
    case "search_api":
      return memory.searchCatalog(input.query, { state: input.state });
    case "search_game_scripts":
      return files.search(input.pattern, {
        ext: input.ext ?? ".lua", pathFilter: input.pathFilter, context: input.context ?? 0, maxResults: input.maxResults ?? 40,
      });
    case "read_game_file":
      return files.read(input.path, { from: input.from ?? 1, count: input.count ?? 120 });

    case "save_ability": {
      let tested = null;
      if (input.test_params) {
        try {
          const { value, text } = await game.lua(input.state, input.lua, { params: input.test_params });
          if (value && value.ok === false) return { saved: false, reason: "test run reported ok=false", result: value };
          tested = { at: new Date().toISOString(), params: input.test_params, result: clip({ value, text }).slice(0, 1500) };
          if (input.kind && input.kind !== "query") ctx.markStale();
        } catch (err) {
          return { saved: false, reason: `test run failed: ${err.message}` };
        }
      }
      try {
        const rec = memory.saveAbility({
          name: input.name, description: input.description, state: input.state, lua: input.lua,
          properties: input.parameters || {}, required: input.required || [], kind: input.kind || "query", tested,
        });
        return { saved: true, tool: `ability__${rec.name}`, versions: rec.history.length + 1, tested: !!tested };
      } catch (err) {
        return { saved: false, reason: err.message };
      }
    }
    case "dig_map":
      return dig.summary((dig.mapApi(memory, files, memory.discovery), memory.discovery));
    case "dig_probe":
      return dig.probeBatch(game, memory.discovery, { limit: Math.min(input.limit ?? 120, 300), onProgress: ctx.onProgress });
    case "dig_frontier":
      return dig.frontier(memory.discovery, { limit: input.limit ?? 10, holder: input.holder, kind: input.kind || "write" });
    case "dig_mark": {
      const e = memory.discovery.update(input.state, input.holder, input.method, { status: input.status, note: input.note, ability: input.ability });
      memory.discovery.save();
      return { ok: true, entry: { state: e.state, holder: e.holder, method: e.method, status: e.status, notes: e.notes } };
    }
    case "dig_status":
      return dig.summary(memory.discovery);
    case "victory_standing": {
      const s = await game.standing();
      memory.history.record(s);
      return analyzeStanding(s);
    }
    case "standing_trends":
      return memory.history.trends(input.turns ?? 20);
    case "list_abilities":
      return memory.listAbilities().map((a) => ({
        name: a.name, kind: a.kind, state: a.state, description: a.description,
        parameters: a.properties, uses: a.uses, lastOk: a.lastOk, versions: (a.history?.length || 0) + 1,
      }));
    case "remember_api_fact":
      return { remembered: memory.remember(input.fact, { topic: input.topic }) };

    default: {
      if (name.startsWith("ability__")) {
        const a = memory.getAbility(name.slice("ability__".length));
        if (!a) return { ok: false, error: `no saved ability ${name}` };
        ctx.onProgress?.(`Using ability: ${a.name}`);
        try {
          const { value, text } = await game.lua(a.state, a.lua, { params: input });
          const ok = !(value && value.ok === false);
          memory.markAbilityUsed(a.name, ok);
          if (a.kind !== "query") {
            memory.record({ type: "ability", name: a.name, params: input, ok, result: clip(value).slice(0, 2000) });
            ctx.markStale();
          }
          return { ok, value, output: text };
        } catch (err) {
          memory.markAbilityUsed(a.name, false);
          return { ok: false, error: err.message };
        }
      }
      return { error: `unknown tool ${name}` };
    }
  }
}

export async function runTool(ctx, name, input) {
  try {
    return { content: clip(await dispatchTool(ctx, name, input)), isError: false };
  } catch (err) {
    return { content: clip({ error: err.message }), isError: true };
  }
}

const QUERY_GAMEINFO_LUA = `
local T = GameInfo[P.table]
if T == nil then emitJson({ error = 'no GameInfo table ' .. tostring(P.table) }) return end
local out, n = {}, 0
local needle = P.match and string.lower(P.match) or nil
for row in T() do
  local o = {}
  local matched = (needle == nil)
  try('row', function()
    for k, v in pairs(row) do
      local tv = type(v)
      if tv == 'string' or tv == 'number' or tv == 'boolean' then
        o[k] = v
        if not matched and tv == 'string' and string.find(string.lower(v), needle, 1, true) then matched = true end
      end
    end
  end)
  if matched then
    n = n + 1
    if #out < (P.limit or 40) then out[#out + 1] = o end
  end
end
emitJson({ table = P.table, total = n, rows = out, gaps = __gaps })
`;

const TECH_PREREQS_LUA = `
local pre, costs = {}, {}
for r in GameInfo.TechnologyPrereqs() do
  pre[r.Technology] = pre[r.Technology] or {}
  table.insert(pre[r.Technology], r.PrereqTech)
end
local te = Players[Game.GetLocalPlayer()]:GetTechs()
local prog = {}
for r in GameInfo.Technologies() do
  costs[r.TechnologyType] = te:GetResearchCost(r.Index)
  prog[r.TechnologyType] = te:GetResearchProgress(r.Index)
end
emitJson({ prereqs = pre, costs = costs, progress = prog })
`;

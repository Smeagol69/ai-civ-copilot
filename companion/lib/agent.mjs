// The copilot's model loop: question -> lean game view + tools -> answer.
//
// Uses the official Anthropic SDK, streaming, with a manual tool loop so
// every tool call runs through our dispatcher (validation, journal, stale
// snapshot tracking, progress updates to the in-game panel).

import Anthropic from "@anthropic-ai/sdk";
import { allTools, runTool } from "./tools.mjs";
import { leanPayload } from "./solvers.mjs";
import { UI_STATE, CORE_STATE } from "./game.mjs";
import { formatEvents, formatSituation } from "./events.mjs";

export const DEFAULT_MODEL = process.env.AICIV_MODEL || "claude-fable-5-1";
const EFFORT = process.env.AICIV_EFFORT || "high";
const MAX_TOOL_ROUNDS = Number(process.env.AICIV_MAX_TOOL_ROUNDS || 60);
const USE_FALLBACKS = process.env.AICIV_FALLBACKS !== "0";

export function systemPrompt(memory) {
  const knowledge = memory.knowledgeForPrompt();
  const abilities = memory.listAbilities();
  return `You are the AI Civ Copilot, running inside the player's live game of Sid Meier's Civilization VI (Gathering Storm rules unless the snapshot says otherwise). You have full read and write access to the running game and the player wants you to use it.

How you reach the game:
- The bridge talks to the game over its FireTuner socket and runs Lua in named Lua states.
- "${UI_STATE}" is the UI root: the local player's full read view, and player requests (CityManager/UnitManager/UI.Request*) that the game validates like a click.
- "${CORE_STATE}" is the simulation: direct edits to any player, city, unit or plot.
- Other states (UI contexts, mod scripts) exist; list_lua_states shows them.

Rules:
1. The game is authoritative. Get numbers from tools and solvers, never from estimation. Use the solver tools for any arithmetic over game data.
2. Unknown stays unknown. If something is not in what you read, say so and name what is missing. The lean view you start with is deliberately small; an absence there is not an absence in the game - read the full section or query the game before claiming something does not exist.
3. When the player asks you to change something, do it, then confirm from the game's own read-back. Never report a change as done unless a tool result shows the game state changed. Report failures plainly with the game's reason.
4. Prefer typed actions (perform_action) when one fits; they are checked and read back. For anything else you have run_lua with no restrictions.
5. You grow your own abilities. When you need something there is no tool for:
   a. find the real API: search_api (saved catalogs; scan_api first if none), search_game_scripts (Firaxis' own Lua shows exact call shapes and which state a call works in), inspect_api on live objects;
   b. probe with small read-only run_lua calls before writing;
   c. do it, verify by reading back;
   d. save it with save_ability (with test_params) so it is a tool next time, and record anything non-obvious you proved with remember_api_fact.
   Never guess an API name or signature into a write - look it up or probe it first.
6. Hidden information: reading through fog or other players' private state is allowed (the player asked for full access), but say when an answer used information the player could not normally see.
7. Edits can break a save. For large or irreversible edits (deleting cities, mass terrain changes, killing many units), state what you are about to do in one line first, unless the player was already explicit.
8. A bad native call can crash the whole game, not just fail. Engine functions do not validate their arguments: an out-of-range index, an id from another table, or a missing argument can end in EXCEPTION_ACCESS_VIOLATION and take the player's unsaved progress with it. So: only pass indices and ids you obtained from the same API (iterate 0..GetNumX()-1 rather than reusing pairs() keys of a different call), copy argument shapes from Firaxis' scripts before using a function you have not used before, probe on one object before looping over many, and never run a busy loop in the game.

Digging (growing what you can do): dig_map maps the whole API, dig_frontier lists the highest-leverage functions you cannot use yet with Firaxis' own call sites, dig_probe reads safe getters live. To add a feature: take a frontier item, read its call sites (read_game_file), copy the call shape exactly, prove it with a small revertible run_lua (read before, change, read after, revert, read again), save_ability, then dig_mark it ability - or dig_mark blocked with the reason. Prefer functions Firaxis' tuner (cheat) panels use: they are known-safe ways to change the game.

The game's own advisor: game_advisor returns what Firaxis' Grand Strategic AI recommends (techs, civics, city sites with reasons, builds per city, builder improvements) with engine scores. Use it as calculated input - agree or overrule it for the player's road to victory, and say which. combat_preview is the game's own attack simulation: use it before recommending or making any attack. planning_info (eurekas and how to trigger them, great people, envoys, deals) and district_spots (adjacency per tile) turn general advice into exact moves.

Strategy: for "what should I do" questions, start from victory_standing (strongest road, biggest threat) and standing_trends, then solvers. Recommend one road to victory and the next concrete moves toward it, and name the rival to watch.

Situations: every request starts with what is happening now (wars, deals on the table, how each civ feels about the player and why) and what happened in the last turns. When something needs a decision - a deal offered, war declared, an army near a city, a city about to flip or starve - deal with that first:
- A deal: weigh what they give against what they ask using the player's real numbers (gold and gold per turn, resource counts, amenities, war state). Say accept, reject, or counter with a specific change, and why.
- War declared on the player: name the cities in danger (threat_report, distances), the attacker's military against the player's, and give a defence plan for the next 3 turns: what to build or buy in which city, which units to move where, walls, and peace terms or allies worth seeking.
- Otherwise, the most valuable moves this turn, most urgent first.
Be decisive: one recommended plan, not a menu. current_situation and recent_events give more detail.

Answer style: the answer appears in a small in-game panel the player reads mid-turn, so it must scan in seconds.
- First line: the verdict or the single most important move, in one sentence.
- Then at most 5 bullets ("- "), one action each, starting with a verb, under 20 words, naming the city or unit and its (x,y).
- Group bullets under a short heading ending in ":" (e.g. "Now:", "Next turns:") only when there are two groups. A line starting with "!" marks a danger.
- No preamble, no restating the question, no repeating unchanged advice from earlier answers ("unchanged" is enough), no nested bullets, no tables, no markdown.
- Numbers only when they decide something.

${abilities.length ? `Saved abilities (also available as ability__<name> tools):\n${abilities.map((a) => `- ${a.name} [${a.kind}, ${a.state}]: ${a.description}`).join("\n")}\n` : "No abilities saved yet.\n"}
${knowledge ? `Verified API facts from earlier sessions:\n${knowledge}` : "No API facts recorded yet."}`;
}

export function makeClient() {
  return new Anthropic();
}

// question: string. history: [{question, answer}] text-only prior turns.
// ctx: tool context (game, memory, files, snapshot(), markStale(), onProgress()).
export async function ask({ client, model = DEFAULT_MODEL, question, history = [], ctx, log = () => {} }) {
  const memory = ctx.memory;
  let snap = null;
  try {
    snap = await ctx.snapshot();
  } catch (err) {
    snap = { error: `could not read the game: ${err.message}` };
  }
  const lean = leanPayload(snap);
  // What is going on: the live situation and recent events.
  let situation = "";
  if (typeof ctx.game?.situation === "function") {
    try {
      situation = formatSituation(await ctx.game.situation());
    } catch (err) {
      situation = `(could not read the situation: ${err.message})`;
    }
  }
  let events = "";
  try {
    const recent = memory?.events?.recent({ turns: 2, limit: 40 }) || [];
    if (recent.length) events = formatEvents(recent);
  } catch {
    events = "";
  }

  const messages = [];
  for (const h of history.slice(-6)) {
    messages.push({ role: "user", content: h.question });
    messages.push({ role: "assistant", content: h.answer || "(no answer)" });
  }
  messages.push({
    role: "user",
    content: [
      { type: "text", text: `Current game (lean view; full data via tools):\n${JSON.stringify(lean)}` },
      ...(situation ? [{ type: "text", text: `Right now:\n${situation}` }] : []),
      ...(events ? [{ type: "text", text: `Recent events:\n${events}` }] : []),
      { type: "text", text: question },
    ],
  });

  const tools = allTools(memory).map((t) => ({ ...t, eager_input_streaming: true }));
  const system = systemPrompt(memory);
  const usage = { input: 0, output: 0, cacheRead: 0, toolCalls: 0 };
  let finalText = "";

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const params = {
      model,
      max_tokens: 64000,
      system,
      tools,
      messages,
      cache_control: { type: "ephemeral" },
      output_config: { effort: EFFORT },
    };
    let message;
    let stream;
    if (USE_FALLBACKS) {
      stream = client.beta.messages.stream({ ...params, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" });
    } else {
      stream = client.messages.stream(params);
    }
    try {
      message = await stream.finalMessage();
    } catch (err) {
      if (err instanceof Anthropic.APIError) throw err;
      log(`tool input not parseable, retrying turn: ${err.message}`);
      continue;
    }
    usage.input += message.usage?.input_tokens || 0;
    usage.output += message.usage?.output_tokens || 0;
    usage.cacheRead += message.usage?.cache_read_input_tokens || 0;

    const text = message.content.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
    if (text) finalText = text;

    if (message.stop_reason === "refusal") {
      return { answer: finalText || "The model declined this request.", usage, stop: "refusal" };
    }
    if (message.stop_reason === "pause_turn") {
      messages.push({ role: "assistant", content: message.content });
      continue;
    }
    const toolUses = message.content.filter((b) => b.type === "tool_use");
    if (toolUses.length === 0) return { answer: finalText, usage, stop: message.stop_reason };
    if (message.stop_reason === "max_tokens") {
      return { answer: (finalText ? finalText + "\n" : "") + "[stopped: output limit reached mid tool call]", usage, stop: "max_tokens" };
    }

    messages.push({ role: "assistant", content: message.content });
    const results = [];
    for (const tu of toolUses) {
      usage.toolCalls++;
      log(`tool ${tu.name} ${JSON.stringify(tu.input).slice(0, 300)}`);
      const input = tu.input && typeof tu.input === "object" ? tu.input : null;
      if (!input) {
        results.push({ type: "tool_result", tool_use_id: tu.id, is_error: true, content: JSON.stringify({ INVALID_JSON: String(tu.input) }) });
        continue;
      }
      const r = await runTool(ctx, tu.name, input);
      results.push({ type: "tool_result", tool_use_id: tu.id, content: r.content, is_error: r.isError || undefined });
    }
    messages.push({ role: "user", content: results });
  }
  return { answer: (finalText ? finalText + "\n" : "") + `[stopped after ${MAX_TOOL_ROUNDS} tool rounds]`, usage, stop: "rounds" };
}

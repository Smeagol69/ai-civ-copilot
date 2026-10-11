// AI Civ Copilot bridge.
//
//   Civ VI (EnableTuner 1) <--FireTuner TCP 4318--> this process <--> Claude
//                                                        ^
//                       localhost HTTP 127.0.0.1:8737 ---+  (CLI, scripts, Claude Code)
//
// The in-game panel (mod/AICivCopilot) puts questions in
// ExposedMembers.AICivCopilot.outbox; we poll it through the InGame state and
// answer through LuaEvents.AICivCopilot_Reply.

import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Game, UI_STATE, PANEL_STATE } from "./lib/game.mjs";
import { Memory } from "./lib/memory.mjs";
import { GameFiles } from "./lib/gamefiles.mjs";
import { ask, makeClient, DEFAULT_MODEL, ADVISOR_MODEL, DIG_MODEL, tierFor, AiUnavailable } from "./lib/agent.mjs";
import { performAction } from "./lib/actions.mjs";
import { runTool, allTools } from "./lib/tools.mjs";
import { empireSummary } from "./lib/solvers.mjs";
import { suspects } from "./lib/inflight.mjs";
import { handlePanelRequest, abilityButtons, AI_PROMPTS } from "./lib/panel.mjs";
import { TABS } from "./lib/catalog.mjs";
import { UNKNOWN_LOCK, multiplayerLock } from "./lib/locks.mjs";
import { tidyAnswer, tidyReport } from "./lib/tidy.mjs";
import { POLL_LUA, REPLY_LUA, BUTTONS_LUA } from "./lib/panel-mailbox.mjs";

const PORT = Number(process.env.AICIV_PORT || 8737);
const POLL_MS = Number(process.env.AICIV_POLL_MS || 500);
const SNAPSHOT_TTL_MS = 20000;

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const game = new Game({ host: process.env.CIV6_TUNER_HOST, port: Number(process.env.CIV6_TUNER_PORT || 4318), log });
const memory = new Memory();
const files = new GameFiles();
let client = null;

const state = { connected: false, panel: false, busy: false, lastError: null, asked: 0, turn: null };
const histories = new Map(); // source -> [{question, answer}]

// ------------------------------------------------------------------ context
let snapCache = null;
let snapAt = 0;
let stale = true;
function makeCtx(onProgress) {
  return {
    game, memory, files, onProgress,
    markStale() { stale = true; },
    stopReason() { return game.paused; },
    async snapshot() {
      if (!stale && snapCache && Date.now() - snapAt < SNAPSHOT_TTL_MS) return snapCache;
      snapCache = await game.snapshot();
      snapAt = Date.now();
      stale = false;
      state.turn = snapCache?.meta?.turn ?? state.turn;
      return snapCache;
    },
  };
}

// ------------------------------------------------------------------ panel
// Each poll takes the panel's new requests (keeping them in m.taken until
// their final reply, so a bridge restart can pick them up again with
// P.recover) and drains the game events the panel recorded. POLL_LUA,
// REPLY_LUA and BUTTONS_LUA live in lib/panel-mailbox.mjs: every request
// carries the generation of the panel that queued it, and a reply/button
// update checks it there before touching taken or firing a LuaEvent, so a
// previous game's late AI work can never land in a newer one's UI.

async function sendButtons(group, items, generation) {
  try {
    await game.lua(UI_STATE, BUTTONS_LUA, { params: { group, items, generation } });
  } catch (err) {
    log(`panel buttons failed: ${err.message}`);
  }
}

// AI answers get the full tidy (markdown out, flat bullets); the free
// reports are already laid out and only get blank-line cleanup. generation
// is the panel generation this reply belongs to (undefined for a caller,
// like /say, with no specific request to inherit one from - REPLY_LUA lets
// an unstamped reply through rather than guessing it is stale).
async function reply(id, kind, text, { ai = false, generation } = {}) {
  const clean = kind === "answer" && ai ? tidyAnswer(text) : tidyReport(text);
  try {
    await game.lua(UI_STATE, REPLY_LUA, { params: { id, kind, text: clean.slice(0, 12000), generation } });
  } catch (err) {
    log(`panel reply failed: ${err.message}`);
  }
}

game.coreLocked = UNKNOWN_LOCK;
const DIG_KEYS = new Set(["explore_ai", "dig_ai", "dig3_ai"]);

// When the API says the account cannot be used (no credits, bad key), AI
// requests answer at once for a few minutes instead of failing one by one.
let aiBlock = null; // { until, lastTry, message }
const AI_BLOCK_MS = 5 * 60 * 1000;
const AI_PROBE_MS = 30 * 1000;

async function answer(source, question, onProgress, { tier = "advisor", freeText = false } = {}) {
  if (!client) client = makeClient();
  const history = histories.get(source) || [];
  if (/^\s*(new|reset|clear)\s*$/i.test(question)) {
    histories.set(source, []);
    return { answer: "Started a new conversation." };
  }
  state.busy = true;
  state.asked++;
  const started = Date.now();
  try {
    stale = true;
    log(`asking ${tier} (${tier === "dig" ? DIG_MODEL : ADVISOR_MODEL})`);
    const res = await ask({ client, tier, freeText, question, history, ctx: makeCtx(onProgress), log });
    history.push({ question, answer: res.answer });
    histories.set(source, history.slice(-12));
    memory.record({ type: "question", source, tier, question, answer: res.answer, usage: res.usage, ms: Date.now() - started });
    aiBlock = null; // the account works
    log(`answered by ${(res.usage.models?.length ? res.usage.models : [res.usage.model]).join(", ")} in ${((Date.now() - started) / 1000).toFixed(1)}s, ${res.usage.toolCalls} tool calls, ${res.usage.input} in + ${res.usage.cacheWrite} cache-write / ${res.usage.output} out (${res.usage.cacheRead} cached)`);
    return res;
  } finally {
    state.busy = false;
  }
}

// AI requests run one at a time in the background, so instant buttons and
// game actions answer right away even while the model is thinking.
const aiQueue = [];
let aiRunning = false;

async function runAiQueue() {
  if (aiRunning) return;
  aiRunning = true;
  try {
    while (aiQueue.length) {
      const job = aiQueue.shift();
      // While blocked, answer at once - but let one request through every
      // 30 s, so adding credits takes effect without waiting the full block.
      if (aiBlock && Date.now() < aiBlock.until && Date.now() - aiBlock.lastTry < AI_PROBE_MS) {
        await reply(job.id, "error", aiBlock.message, { generation: job.generation });
        continue;
      }
      if (aiBlock) aiBlock.lastTry = Date.now();
      await reply(job.id, "status", "Thinking...", { generation: job.generation });
      try {
        const text = await job.run((p) => reply(job.id, "status", p, { generation: job.generation }));
        await reply(job.id, "answer", text, { ai: true, generation: job.generation });
        if (job.refreshAbilities) await sendButtons("abilities", abilityButtons(memory), job.generation);
      } catch (err) {
        state.lastError = err.message;
        if (err instanceof AiUnavailable) {
          if (err.code === "no-credits" || err.code === "auth") aiBlock = { until: Date.now() + AI_BLOCK_MS, lastTry: Date.now(), message: err.message };
          await reply(job.id, "error", err.message, { generation: job.generation });
        } else {
          await reply(job.id, "error", `Copilot error: ${readableError(err)}`, { generation: job.generation });
        }
      }
    }
  } finally {
    aiRunning = false;
  }
}

const PER_TURN = new Set(["turnbrief", "turnadvice", "plan_turn"]);
const doneForTurn = new Map(); // key -> { turn, at } of the last run

const shortModel = (m) => String(m).replace(/^claude-/, "").replace(/-\d{8}$/, "");

// A raw API error is a JSON blob; the panel shows only its message.
function readableError(err) {
  const msg = String(err?.error?.error?.message || err?.message || err);
  const inner = /"message":"([^"]+)"/.exec(msg);
  return (inner ? inner[1] : msg).slice(0, 300);
}

async function handlePanel(q) {
  // Stamped by the panel's own Queue() when it was queued; threaded through
  // every reply/button update this request causes, including ones that
  // only fire later (the AI queue below) - REPLY_LUA/BUTTONS_LUA refuse a
  // confirmed-stale one rather than let it land in a newer panel's UI.
  const generation = q.generation;
  const kind = q.kind || "ask";
  if (kind === "new") {
    histories.set("panel", []);
    return;
  }
  if (kind === "ask") {
    const text = String(q.text || "").trim();
    if (!text) return;
    log(`panel question #${q.id}: ${text}`);
    const ahead = aiQueue.length + (aiRunning ? 1 : 0);
    if (ahead) await reply(q.id, "status", `Queued behind ${ahead} AI request(s)...`, { generation });
    // Digging edits the game, so with the core locked a dig-sounding question
    // is answered by the advisor instead (a wrong guess never costs an answer).
    let tier = tierFor(text);
    if (tier === "dig" && game.coreLocked) tier = "advisor";
    aiQueue.push({ id: q.id, key: `ask:${tier}`, generation, refreshAbilities: tier === "dig", run: async (onProgress) => (await answer("panel", text, onProgress, { tier, freeText: true })).answer });
    runAiQueue();
    return;
  }
  // A button.
  const key = String(q.key || "");
  log(`panel button #${q.id}: ${key}`);
  // The game can fire the start-of-turn event twice; the automatic per-turn
  // requests run once per game turn (the AI one costs).
  // (Only a repeat within 30 s: pressing the button again later still works.)
  if (PER_TURN.has(key) && q.turn != null) {
    const last = doneForTurn.get(key);
    if (last && last.turn === q.turn && Date.now() - last.at < 30000) {
      await reply(q.id, "answer", `(Turn ${q.turn} is already covered above.)`, { generation });
      return;
    }
    doneForTurn.set(key, { turn: q.turn, at: Date.now() });
  }
  if (AI_PROMPTS[key] && DIG_KEYS.has(key) && game.coreLocked) {
    await reply(q.id, "error", `${game.coreLocked} Digging proves functions by editing the game, so it is off in this game.`, { generation });
    return;
  }
  if (AI_PROMPTS[key]) {
    // The same AI button pressed again while the first is still waiting:
    // one answer is enough (and costs once).
    if (aiQueue.some((j) => j.key === key)) {
      await reply(q.id, "answer", "Already queued - the answer will appear with the first press.", { generation });
      return;
    }
    const ahead = aiQueue.length + (aiRunning ? 1 : 0);
    if (ahead) await reply(q.id, "status", `Queued behind ${ahead} AI request(s)...`, { generation });
    aiQueue.push({
      id: q.id,
      key,
      generation,
      refreshAbilities: ["explore_ai", "dig_ai", "dig3_ai"].includes(key),
      run: async (onProgress) => {
        const tier = DIG_KEYS.has(key) ? "dig" : "advisor";
        const res = await handlePanelRequest(makeCtx(onProgress), q, { ask: (question) => answer("panel", question, onProgress, { tier }) });
        return res.text;
      },
    });
    runAiQueue();
    return;
  }
  try {
    const res = await handlePanelRequest(makeCtx((p) => reply(q.id, "status", p, { generation })), q);
    if (res.buttons) await sendButtons(res.buttons.group, res.buttons.items, generation);
    await reply(q.id, res.kind || "answer", res.text, { generation });
  } catch (err) {
    state.lastError = err.message;
    await reply(q.id, "error", `${key}: ${err.message}`, { generation });
  }
}

// Requests taken by an earlier bridge process that never got a final reply.
// AI requests run again; game actions are not repeated (the earlier process
// may have done them) - the player is asked to press again. Each q already
// carries the generation it was queued under (preserved through m.taken).
async function recover(list) {
  for (const q of list || []) {
    const isAi = (q.kind || "ask") === "ask" || AI_PROMPTS[String(q.key || "")];
    if (isAi) {
      log(`picking up #${q.id} (${q.key || "question"}) after a bridge restart`);
      await reply(q.id, "status", "Picked up again after a bridge restart...", { generation: q.generation });
      await handlePanel(q);
    } else {
      await reply(q.id, "error", `The bridge restarted before [${q.text || q.key}] finished. Check the game, then press it again if it was not done.`, { generation: q.generation });
    }
  }
}

// Lock the game core in multiplayer with other people. A poll that could not
// read the facts (no fields, or no human count) keeps the previous lock.
function applyMultiplayer(res) {
  const locked = multiplayerLock(res, game.coreLocked);
  if (locked !== game.coreLocked) {
    if (locked) log(`multiplayer game with ${res.humans ?? "?"} people${res.cloud ? " (Play By Cloud)" : ""}: edits locked`);
    else if (game.coreLocked !== UNKNOWN_LOCK) log("not a multiplayer game with other people: edits allowed");
  }
  game.coreLocked = locked;
  if (res.mp !== undefined) state.multiplayer = res.mp || res.cloud ? { humans: res.humans, cloud: !!res.cloud } : null;
}

let recovered = false;
// POLL_LUA drains the mailbox before a later state refresh can discover the
// panel. Keep those batches until a fresh poll confirms their generation.
let deferredPanelPolls = [];
let lastStateRefresh = 0;
let lastInject = 0;

// A game started with the mod switched off (it is per game in the setup
// screen) has no panel. InGame.lua loads add-in UIs by absolute path with
// ContextPtr:LoadNewContext(path, Controls.AdditionalUserInterfaces, id,
// hidden), so the bridge can do the same from the installed mod folder.
const PANEL_PATH = (process.env.AICIV_PANEL_PATH || path.join(os.homedir(), "Documents", "My Games", "Sid Meier's Civilization VI", "Mods", "AICivCopilot", "UI", "AICivCopilotPanel")).replace(/\\/g, "/");
const INJECT_LUA = `
local ctx = ContextPtr:LoadNewContext(P.path, Controls.AdditionalUserInterfaces, P.id, true)
emitJson({ ok = ctx ~= nil })
`;
async function injectPanel() {
  if (Date.now() - lastInject < 60000) return false;
  lastInject = Date.now();
  if (!fs.existsSync(`${PANEL_PATH}.xml`)) {
    log(`cannot add the panel: ${PANEL_PATH}.xml is missing (run scripts\\install.ps1)`);
    return false;
  }
  try {
    const { value } = await game.lua(UI_STATE, INJECT_LUA, { params: { path: PANEL_PATH, id: PANEL_STATE }, timeoutMs: 20000 });
    await game.tuner.refreshStates();
    const ok = !!value?.ok && game.tuner.states.some((s) => s.name === PANEL_STATE);
    log(ok ? "added the copilot panel to this game (the mod was off for it)" : "tried to add the copilot panel, but it did not load");
    return ok;
  } catch (err) {
    log(`could not add the panel: ${err.message}`);
    return false;
  }
}

async function pollPanel() {
  if (!game.connected) return;
  let res;
  try {
    ({ value: res } = await game.lua(UI_STATE, POLL_LUA, { timeoutMs: 5000, params: { recover: !recovered }, force: true }));
  } catch (err) {
    state.panel = false;
    // Loading, leaving or rejoining: hold every other call until the game is
    // back (a call into a half-torn-down game can crash it).
    if (["invalid-state", "wrong-state", "not-found"].includes(err.code) || /not found|Invalid Lua State/i.test(err.message)) {
      if (!game.paused) log("the game is loading or between sessions - pausing all copilot calls");
      game.paused = "The game is loading or between sessions; the copilot waits until it is back. Stop here and do not retry.";
      // The next game may be a different kind (single player, multiplayer).
      game.coreLocked = UNKNOWN_LOCK;
      stale = true;
    } else {
      log(`poll: ${err.message}`);
    }
    return;
  }
  if (!res) return;
  applyMultiplayer(res);
  if (game.paused) {
    log("the game is back - copilot calls resume");
    game.paused = null;
    stale = true;
  }
  // A new turn makes any cached view of the game old.
  if (res.turn != null && snapCache?.meta?.turn != null && res.turn !== snapCache.meta.turn) stale = true;
  // The mailbox outlives a game (ExposedMembers is app-wide), so the panel is
  // only "loaded" when its own Lua state exists in this game.
  // Injecting happens only right after a fresh state list confirms the panel
  // is missing, so a slow list never leads to a second panel.
  let loaded = game.tuner.states.some((s) => s.name === PANEL_STATE);
  // A discovery below cannot tell whether res predates panel init or the
  // state cache simply missed an already initialized panel. A fresh poll
  // must confirm its generation before any drained work can be accepted.
  let justFound = false;
  if (!loaded && Date.now() - lastStateRefresh > 15000) {
    lastStateRefresh = Date.now();
    let fresh = false;
    try {
      await game.tuner.refreshStates();
      fresh = true;
      loaded = game.tuner.states.some((s) => s.name === PANEL_STATE);
    } catch {
      // keep the last answer
    }
    if (fresh && loaded) {
      justFound = true;
    } else if (fresh && !loaded) {
      log(`the copilot panel is not loaded in this game (no "${PANEL_STATE}" Lua state); adding it`);
      justFound = loaded = await injectPanel();
    }
  }
  if (justFound || (deferredPanelPolls.length && !(loaded && res.panel))) {
    deferredPanelPolls.push(res);
    return;
  }
  if (loaded && res.panel && deferredPanelPolls.length) {
    // Only a known matching generation proves a deferred mailbox belongs
    // here. Unstamped deferred data cannot be confirmed; ordinary current
    // polls retain their existing legacy behavior. Use fresh metadata, and
    // merge only the destructively drained lanes in their original order.
    const polls = [...deferredPanelPolls.filter((p) => p.generation != null && p.generation === res.generation), res];
    deferredPanelPolls = []; // consume before any dispatch or recovery
    const questions = polls.flatMap((p) => p.questions || []);
    const questionIds = new Set(questions.filter((q) => q.id != null && q.id !== 0).map((q) => q.id));
    const seen = new Set();
    // The confirmation poll now sees deferred questions in taken. They
    // still belong to normal dispatch, not restart recovery (which refuses
    // actions). Genuine pre-existing recovery entries keep their behavior.
    const recovery = polls.flatMap((p) => p.recovered || []).filter((q) => {
      if (questionIds.has(q.id) || seen.has(q.id)) return false;
      seen.add(q.id);
      return true;
    });
    res = { ...res, questions, recovered: recovery, events: polls.flatMap((p) => p.events || []) };
  }
  state.panelLoaded = loaded;
  state.panelVersion = res.version ?? null;
  if (res.events?.length) {
    memory.events.add(res.events);
    for (const e of res.events) if (e.kind === "war" || e.kind === "deal" || e.kind === "peace") log(`event: ${e.text}`);
  }
  const live = !!(res.panel && state.panelLoaded);
  // A generation change (a different game's panel, stamped once at its own
  // init) must re-announce and resend buttons even if `live` never dipped to
  // false in between polls - a fast reload can look identical to "still the
  // same panel" from state.panel alone, but it is a fresh incarnation with
  // its own fresh abilities/tabs. state.panelGeneration is also what /say
  // and any other caller with no specific request of its own default to.
  const newGeneration = live && res.generation != null && res.generation !== state.panelGeneration;
  if (live) state.panelGeneration = res.generation;
  if (live && (!state.panel || newGeneration)) {
    log(`in-game panel detected (version ${res.version ?? "?"})`);
    // A mod's UI context starts hidden; make sure the panel's is shown (the
    // panel does this itself too - this covers older installed versions).
    try {
      await game.lua(PANEL_STATE, "ContextPtr:SetHide(false)");
    } catch (err) {
      log(`could not show the panel context: ${err.message}`);
    }
    // Tell the panel who is answering, and give it the saved abilities.
    // Short: it shares the status line with the New button.
    await reply(0, "hello", `${shortModel(ADVISOR_MODEL)} / ${shortModel(DIG_MODEL)}`, { generation: state.panelGeneration });
    // Panel v5+ rebuilds its tabs from this, so new buttons need no reload.
    await sendButtons("tabs", TABS, state.panelGeneration);
    await sendButtons("abilities", abilityButtons(memory), state.panelGeneration);
  }
  state.panel = live;
  if (res.turn != null && res.turn !== state.lastHistoryTurn) {
    // Once per turn: record everyone's standing, so trends build up over time.
    state.lastHistoryTurn = res.turn;
    game.standing().then((s) => s && !s.error && memory.history.record(s)).catch((err) => log(`standing: ${err.message}`));
  }
  state.turn = res.turn ?? state.turn;
  // An absent panel cannot authorize dispatch. Discovery batches above wait
  // for generation confirmation; accepted questions retain normal dispatch
  // while genuine prior requests retain their restart-recovery behavior.
  if (!recovered && loaded) {
    recovered = true;
    await recover(res.recovered);
  }
  if (loaded) for (const q of res.questions || []) await handlePanel(q);
}

// When the game connection drops, say what was running at that moment: if
// the game crashed, one of these calls is the likely cause.
game.tuner.on("close", () => {
  const open = suspects(undefined, { sinceMs: 120000 });
  if (!open.length) return log("tuner connection closed");
  log(`tuner connection closed; ${open.length} recent call(s) did not settle cleanly - if the game crashed, look here first:`);
  for (const e of open) log(`  [${e.status}] ${e.at} ${e.state} ${e.label || ""}: ${String(e.body || "").slice(0, 300).replace(/\s+/g, " ")}`);
  memory.record({ type: "connection-lost", suspects: open.map((e) => ({ at: e.at, status: e.status, state: e.state, label: e.label, body: e.body })) });
});

async function connectLoop() {
  for (;;) {
    if (!game.connected) {
      try {
        await game.tuner.connect();
        state.connected = true;
        stale = true;
        const names = game.tuner.states.map((s) => s.name);
        log(`connected to ${game.tuner.app || "Civ VI"}; ${names.length} Lua states${names.includes(UI_STATE) ? "" : " (no game loaded yet)"}`);
      } catch {
        state.connected = false;
      }
    } else {
      state.connected = true;
      try {
        await pollPanel();
      } catch (err) {
        log(`poll loop: ${err.message}`);
      }
    }
    await new Promise((r) => setTimeout(r, game.connected ? POLL_MS : 3000));
  }
}

// ------------------------------------------------------------------ http
function body(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (err) {
        reject(err);
      }
    });
  });
}

const routes = {
  "GET /status": async () => ({ ...state, model: DEFAULT_MODEL, advisorModel: ADVISOR_MODEL, digModel: DIG_MODEL, paused: game.paused, coreLocked: !!game.coreLocked, aiBlocked: aiBlock && Date.now() < aiBlock.until ? aiBlock.message : null, states: game.tuner.states.map((s) => s.name), abilities: memory.listAbilities().length }),
  "GET /snapshot": async () => makeCtx().snapshot().then((s) => (stale = true, s)),
  "GET /summary": async () => empireSummary(await makeCtx().snapshot()),
  "GET /states": async () => game.states(),
  "GET /tools": async () => allTools(memory).map((t) => ({ name: t.name, description: t.description })),
  "GET /journal": async () => memory.recentJournal(50),
  "GET /inflight": async () => suspects(undefined, { limit: 20 }),
  "POST /ask": async (b) => answer(b.source || "http", b.question, undefined, { tier: b.tier || tierFor(b.question), freeText: true }),
  "POST /lua": async (b) => {
    stale = true;
    return game.lua(b.state || UI_STATE, b.code, { params: b.params || {}, timeoutMs: b.timeoutMs || 20000 });
  },
  "POST /action": async (b) => {
    stale = true;
    return performAction(game, b.action, b.args || {}, { journal: memory });
  },
  "POST /tool": async (b) => runTool(makeCtx(), b.name, b.input || {}),
  "POST /say": async (b) => (await reply(0, b.kind || "answer", b.text, { generation: state.panelGeneration }), { ok: true }),
};

const server = http.createServer(async (req, res) => {
  const key = `${req.method} ${req.url.split("?")[0]}`;
  const handler = routes[key];
  res.setHeader("content-type", "application/json; charset=utf-8");
  if (!handler) {
    res.statusCode = 404;
    return res.end(JSON.stringify({ error: `no route ${key}`, routes: Object.keys(routes) }));
  }
  try {
    const out = await handler(req.method === "POST" ? await body(req) : {});
    res.end(JSON.stringify(out ?? null));
  } catch (err) {
    res.statusCode = 500;
    res.end(JSON.stringify({ error: err.message, name: err.name }));
  }
});

server.listen(PORT, "127.0.0.1", () => {
  log(`AI Civ Copilot bridge on http://127.0.0.1:${PORT}  advisor=${ADVISOR_MODEL}  dig=${DIG_MODEL}`);
  log(`waiting for Civ VI tuner on ${game.tuner.host}:${game.tuner.port} (AppOptions.txt: EnableTuner 1)`);
  connectLoop();
});

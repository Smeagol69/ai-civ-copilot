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
import { Game, UI_STATE } from "./lib/game.mjs";
import { Memory } from "./lib/memory.mjs";
import { GameFiles } from "./lib/gamefiles.mjs";
import { ask, makeClient, DEFAULT_MODEL } from "./lib/agent.mjs";
import { performAction } from "./lib/actions.mjs";
import { runTool, allTools } from "./lib/tools.mjs";
import { empireSummary } from "./lib/solvers.mjs";
import { suspects } from "./lib/inflight.mjs";

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
const POLL_LUA = `
local m = ExposedMembers and ExposedMembers.AICivCopilot
if m == nil then emitJson({ panel = false }) return end
local q = m.outbox or {}
m.outbox = {}
m.bridgeTicks = (m.bridgeTicks or 0) + 1
emitJson({ panel = true, questions = q, turn = Game.GetCurrentGameTurn() })
`;
const REPLY_LUA = `LuaEvents.AICivCopilot_Reply(P.id, P.kind, P.text)`;

function plain(text) {
  return String(text || "")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^#{1,6}\s*/gm, "")
    .replace(/^\s*[*]\s+/gm, "- ");
}

async function reply(id, kind, text) {
  try {
    await game.lua(UI_STATE, REPLY_LUA, { params: { id, kind, text: plain(text).slice(0, 12000) } });
  } catch (err) {
    log(`panel reply failed: ${err.message}`);
  }
}

async function answer(source, question, onProgress) {
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
    const res = await ask({ client, question, history, ctx: makeCtx(onProgress), log });
    history.push({ question, answer: res.answer });
    histories.set(source, history.slice(-12));
    memory.record({ type: "question", source, question, answer: res.answer, usage: res.usage, ms: Date.now() - started });
    log(`answered in ${((Date.now() - started) / 1000).toFixed(1)}s, ${res.usage.toolCalls} tool calls`);
    return res;
  } finally {
    state.busy = false;
  }
}

async function pollPanel() {
  if (!game.connected) return;
  let res;
  try {
    ({ value: res } = await game.lua(UI_STATE, POLL_LUA, { timeoutMs: 5000 }));
  } catch (err) {
    state.panel = false;
    if (!/not found/.test(err.message)) log(`poll: ${err.message}`);
    return;
  }
  if (!res) return;
  if (res.panel && !state.panel) log("in-game panel detected");
  state.panel = !!res.panel;
  state.turn = res.turn ?? state.turn;
  for (const q of res.questions || []) {
    const text = String(q.text || "").trim();
    if (!text) continue;
    log(`panel question #${q.id}: ${text}`);
    await reply(q.id, "status", "Thinking...");
    try {
      const res2 = await answer("panel", text, (p) => reply(q.id, "status", p));
      await reply(q.id, "answer", res2.answer);
    } catch (err) {
      state.lastError = err.message;
      await reply(q.id, "error", `Copilot error: ${err.message}`);
    }
  }
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
  "GET /status": async () => ({ ...state, model: DEFAULT_MODEL, states: game.tuner.states.map((s) => s.name), abilities: memory.listAbilities().length }),
  "GET /snapshot": async () => makeCtx().snapshot().then((s) => (stale = true, s)),
  "GET /summary": async () => empireSummary(await makeCtx().snapshot()),
  "GET /states": async () => game.states(),
  "GET /tools": async () => allTools(memory).map((t) => ({ name: t.name, description: t.description })),
  "GET /journal": async () => memory.recentJournal(50),
  "GET /inflight": async () => suspects(undefined, { limit: 20 }),
  "POST /ask": async (b) => answer(b.source || "http", b.question),
  "POST /lua": async (b) => {
    stale = true;
    return game.lua(b.state || UI_STATE, b.code, { params: b.params || {}, timeoutMs: b.timeoutMs || 20000 });
  },
  "POST /action": async (b) => {
    stale = true;
    return performAction(game, b.action, b.args || {}, { journal: memory });
  },
  "POST /tool": async (b) => runTool(makeCtx(), b.name, b.input || {}),
  "POST /say": async (b) => (await reply(0, b.kind || "answer", b.text), { ok: true }),
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
  log(`AI Civ Copilot bridge on http://127.0.0.1:${PORT}  model=${DEFAULT_MODEL}`);
  log(`waiting for Civ VI tuner on ${game.tuner.host}:${game.tuner.port} (AppOptions.txt: EnableTuner 1)`);
  connectLoop();
});

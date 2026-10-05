// Model tiers (cheap advisor, strong digger) and the safety locks added after
// the 2026-10-04 multiplayer crash.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ask, tierFor, toolsFor, systemPrompt, TIERS, ADVISOR_MODEL, DIG_MODEL, DIG_ONLY_TOOLS, refusedParam, explainApiError, AiUnavailable } from "../lib/agent.mjs";
import { Memory } from "../lib/memory.mjs";
import { Game, CORE_STATE, UI_STATE } from "../lib/game.mjs";
import { startFakeTuner } from "./fixtures/fake-tuner.mjs";
import { SNAP } from "./fixtures/snapshot.mjs";

const mem = () => new Memory(fs.mkdtempSync(path.join(os.tmpdir(), "aiciv-")));
const usage = { input_tokens: 10, output_tokens: 5 };
const done = (text = "Done.") => ({ stop_reason: "end_turn", usage, content: [{ type: "text", text }] });

// A client that records which endpoint each request used and can fail first.
function client(responses) {
  const requests = [];
  const make = (beta) => (params) => {
    requests.push({ ...params, beta });
    const next = responses.shift();
    return { finalMessage: async () => { if (next instanceof Error) throw next; return next; } };
  };
  return { requests, messages: { stream: make(false) }, beta: { messages: { stream: make(true) } } };
}
const apiError = (status, message) => Object.assign(new Error(`${status} ${message}`), { status, error: { error: { message } } });
const ctxFor = (memory, extra = {}) => ({ memory, files: {}, game: { lua: async () => ({ value: {}, text: [] }) }, markStale() {}, async snapshot() { return SNAP; }, ...extra });

test("free text goes to the cheap advisor unless it is about digging", () => {
  // Strategy questions that use dig-like words (the review's false positives).
  for (const q of ["what should I research next?", "should I accept France's deal", "where do I settle", "how do I beat Mongolia",
    "Should I dig in and defend Kyoto or counterattack?", "where can I discover more natural wonders?", "should I discover Sailing first?",
    "how do I exploit the river adjacency for my campus?", "should I probe their defenses with a scout first?",
    "my units got new abilities after the promotion, which one?", "Is there a vulnerability in their defense?", "which new features do I get from Feudalism?"]) assert.equal(tierFor(q), "advisor", q);
  for (const q of ["dig for new functions", "dig deeper", "find hidden abilities", "any vulnerabilities to exploit?", "vulnerabilities we can use",
    "learn a new skill", "probe the API", "save this as an ability", "scan_api please", "look for exploits in the game",
    "discover what lua calls can change loyalty", "reverse engineer the trade system"]) assert.equal(tierFor(q), "dig", q);
});

test("the advisor tier gets a smaller toolset and prompt; digging keeps everything", () => {
  const memory = mem();
  const all = toolsFor(memory, "dig").map((t) => t.name);
  const adv = toolsFor(memory, "advisor", { lua: false }).map((t) => t.name);
  const advLua = toolsFor(memory, "advisor", { lua: true }).map((t) => t.name);
  for (const t of DIG_ONLY_TOOLS) {
    assert.ok(all.includes(t), `dig has ${t}`);
    assert.ok(!adv.includes(t), `advisor lacks ${t}`);
  }
  assert.ok(!adv.includes("run_lua") && advLua.includes("run_lua"), "run_lua only for free-text advisor questions");
  for (const t of ["game_advisor", "combat_preview", "turn_plan", "current_situation", "perform_action", "victory_standing"]) assert.ok(adv.includes(t), `advisor keeps ${t}`);
  const advPrompt = systemPrompt(memory, { tier: "advisor", lua: false });
  const digPrompt = systemPrompt(memory, { tier: "dig" });
  assert.ok(!advPrompt.includes("dig_map maps the whole API") && digPrompt.includes("dig_map maps the whole API"));
  assert.ok(!advPrompt.includes("<!--"), "no commented-out text is sent");
  assert.ok(advPrompt.length < digPrompt.length, "the advisor prompt is shorter");
});

test("advisor requests use the cheap model, no effort, no fallback beta, small limits", async () => {
  const c = client([done()]);
  const r = await ask({ client: c, tier: "advisor", question: "advise", ctx: ctxFor(mem()) });
  const req = c.requests[0];
  assert.equal(req.model, ADVISOR_MODEL);
  assert.equal(req.beta, false);
  assert.equal(req.output_config, undefined);
  assert.equal(req.max_tokens, TIERS.advisor.maxTokens);
  assert.ok(!req.tools.some((t) => DIG_ONLY_TOOLS.has(t.name)));
  assert.equal(r.usage.model, ADVISOR_MODEL);
  assert.equal(r.usage.tier, "advisor");
});

test("dig requests keep the strong model with effort and the fallback beta", async () => {
  const c = client([done()]);
  await ask({ client: c, tier: "dig", question: "dig", ctx: ctxFor(mem()) });
  assert.equal(c.requests[0].model, DIG_MODEL);
  assert.equal(c.requests[0].output_config?.effort, TIERS.dig.effort);
  assert.equal(c.requests[0].beta, TIERS.dig.fallbacks);
});

test("a param the model refuses is dropped, retried, and remembered for that model", async () => {
  const c = client([apiError(400, "output_config.effort: Extra inputs are not permitted"), done("ok"), done("again")]);
  const ctx = ctxFor(mem());
  const r = await ask({ client: c, tier: "dig", model: "test-model-effort", question: "q", ctx });
  assert.equal(r.answer, "ok");
  assert.ok(c.requests[0].output_config && !c.requests[1].output_config);
  await ask({ client: c, tier: "dig", model: "test-model-effort", question: "q2", ctx });
  assert.ok(!c.requests[2].output_config, "remembered");
  assert.equal(refusedParam(apiError(400, "Your credit balance is too low")), null, "a credit error is not a param problem");
});

test("an empty account reads as a plain message, not a JSON blob", async () => {
  const c = client([apiError(400, "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing.")]);
  await assert.rejects(ask({ client: c, tier: "advisor", question: "q", ctx: ctxFor(mem()) }), (err) => err instanceof AiUnavailable && err.code === "no-credits" && /out of API credits/.test(err.message) && !/\{/.test(err.message));
  assert.equal(explainApiError(apiError(429, "rate limited")).code, "rate-limit");
  assert.equal(explainApiError(apiError(500, "boom")), null);
});

test("the AI stops when the game leaves its session", async () => {
  const c = client([done()]);
  const r = await ask({ client: c, tier: "advisor", question: "q", ctx: ctxFor(mem(), { stopReason: () => "the game is loading" }) });
  assert.match(r.answer, /Stopped: the game is loading/);
  assert.equal(c.requests.length, 0);
});

test("multiplayer with other people: the model is told, and the game core is locked", async () => {
  const c = client([done()]);
  await ask({ client: c, tier: "advisor", question: "q", ctx: ctxFor(mem(), { game: { coreLocked: "locked", lua: async () => ({ value: {} }) } }) });
  const text = c.requests[0].messages.at(-1).content.map((b) => b.text).join("\n");
  assert.match(text, /Multiplayer with other human players/);

  const fake = await startFakeTuner((ctx) => ctx.emitJson({ ran: ctx.state }));
  const game = new Game({ port: fake.port, trace: false });
  try {
    game.coreLocked = "multiplayer: edits off";
    await assert.rejects(game.lua(CORE_STATE, "emitJson(1)"), (e) => e.code === "core-locked" && /edits off/.test(e.message));
    assert.equal((await game.lua(UI_STATE, "emitJson(1)")).value.ran, "InGame", "reads in the UI state still work");
    game.coreLocked = null;
    game.paused = "loading";
    await assert.rejects(game.lua(UI_STATE, "emitJson(1)"), (e) => e.code === "paused");
    await assert.rejects(game.script("standing"), (e) => e.code === "paused");
    assert.equal((await game.lua(UI_STATE, "emitJson(1)", { force: true })).value.ran, "InGame", "the poll can still run");
  } finally {
    game.tuner.close();
    await fake.close();
  }
});

test("a reply from the wrong Lua state is refused, and Invalid Lua State forces a fresh state list", async () => {
  let mode = "wrong";
  const fake = await startFakeTuner((ctx) => {
    if (mode === "wrong") {
      ctx.emitAs("My2K", "J{\"players\":false}");
      ctx.endAs("My2K");
      return "no-end";
    }
    if (mode === "invalid") {
      ctx.compileError("Invalid Lua State");
      return "no-end";
    }
    ctx.emitJson({ ok: true });
  });
  const game = new Game({ port: fake.port, trace: false });
  try {
    await assert.rejects(game.lua(CORE_STATE, "emitJson(1)"), (e) => e.code === "wrong-state" && /My2K/.test(e.message));
    mode = "invalid";
    await assert.rejects(game.lua(CORE_STATE, "emitJson(1)"), (e) => e.code === "invalid-state");
    const lsqBefore = fake.received.filter((f) => f.payload === "LSQ:").length;
    mode = "ok";
    assert.equal((await game.lua(CORE_STATE, "emitJson(1)")).value.ok, true);
    assert.ok(fake.received.filter((f) => f.payload === "LSQ:").length > lsqBefore, "the state list was re-read before the next call");
  } finally {
    game.tuner.close();
    await fake.close();
  }
});

// ---- regressions from the adversarial review (2026-10-05)

test("typed actions go through the same locks (they used to call the tuner directly)", async () => {
  const { performAction } = await import("../lib/actions.mjs");
  const sent = [];
  const fake = await startFakeTuner((ctx) => {
    sent.push(ctx.state);
    ctx.emitJson({ ok: true, before: 1, after: 2 });
  });
  const game = new Game({ port: fake.port, trace: false });
  try {
    game.coreLocked = "multiplayer: edits off";
    const edit = await performAction(game, "change_gold", { amount: 100 });
    assert.equal(edit.ok, false);
    assert.match(edit.reason, /edits off/);
    assert.ok(!sent.includes(CORE_STATE), "nothing reached the game core");
    game.coreLocked = null;
    game.paused = "loading";
    const paused = await performAction(game, "change_gold", { amount: 100 });
    assert.equal(paused.ok, false);
    assert.match(paused.reason, /loading/);
    assert.equal(sent.length, 0, "no call at all while paused");
  } finally {
    game.tuner.close();
    await fake.close();
  }
});

test("while locked only the UI states run: other gameplay-script states are refused too", async () => {
  const fake = await startFakeTuner((ctx) => ctx.emitJson({ ran: ctx.state }));
  const game = new Game({ port: fake.port, trace: false });
  try {
    game.coreLocked = "locked";
    for (const st of ["GameCore_Tuner", "WorldCongress", "Cheat_Menu_Panel_Script", "MP_helper"]) {
      await assert.rejects(game.lua(st, "emitJson(1)"), (e) => e.code === "core-locked", st);
    }
    assert.equal((await game.lua(UI_STATE, "emitJson(1)")).value.ran, "InGame");
  } finally {
    game.tuner.close();
    await fake.close();
  }
});

test("wrong-state is reported even when the misrouted code errors there (as in the real incident)", async () => {
  // Only a runtime error (no result line) comes back, printed by "My2K".
  const fake = await startFakeTuner((ctx) => {
    ctx.runtimeErrorAs("My2K", "attempt to index a nil value");
    ctx.endAs("My2K");
    return "no-end";
  });
  const game = new Game({ port: fake.port, trace: false });
  try {
    await assert.rejects(game.lua(CORE_STATE, "error('x')"), (e) => e.code === "wrong-state" && /My2K/.test(e.message));
    assert.equal(game.tuner.statesAt, 0, "the state list is marked old");
  } finally {
    game.tuner.close();
    await fake.close();
  }
});

test("if the game stops answering the state query, calls fail closed instead of using an old index", async () => {
  let silent = false;
  const sent = [];
  const fake = await startFakeTuner((ctx) => {
    sent.push(ctx.state);
    ctx.emitJson({ ok: true });
  }, { silentLsq: () => silent });
  const game = new Game({ port: fake.port, trace: false });
  try {
    assert.equal((await game.lua(UI_STATE, "emitJson(1)")).value.ok, true);
    silent = true;
    game.tuner.statesAt = 0; // the list is now old
    await assert.rejects(game.lua(UI_STATE, "emitJson(1)"), (e) => e.code === "invalid-state");
    assert.equal(sent.length, 1, "no command was sent with the stale list");
  } finally {
    game.tuner.close();
    await fake.close();
  }
});

test("multiplayer lock: network or Play By Cloud with other people locks; single player and unknown facts behave", async () => {
  const { multiplayerLock, MP_LOCK, CLOUD_LOCK, UNKNOWN_LOCK } = await import("../lib/locks.mjs");
  assert.equal(multiplayerLock({ mp: true, cloud: false, humans: 5 }, null), MP_LOCK);
  assert.equal(multiplayerLock({ mp: false, cloud: true, humans: 3 }, null), CLOUD_LOCK);
  assert.equal(multiplayerLock({ mp: true, cloud: false, humans: 1 }, MP_LOCK), null, "networked but alone: no one to desync");
  assert.equal(multiplayerLock({ mp: false, cloud: false, humans: 2 }, UNKNOWN_LOCK), null, "hot-seat: one machine");
  assert.equal(multiplayerLock({ mp: false, cloud: false, humans: null }, UNKNOWN_LOCK), null, "single player even without a head-count");
  assert.equal(multiplayerLock({ mp: true, cloud: false, humans: null }, null), MP_LOCK, "networked with unknown head-count: assume people");
  assert.equal(multiplayerLock({ panel: false }, MP_LOCK), MP_LOCK, "a poll without the facts keeps the lock");
  assert.equal(multiplayerLock(undefined, UNKNOWN_LOCK), UNKNOWN_LOCK);
});

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
import { UNKNOWN_LOCK, MP_LOCK } from "../lib/locks.mjs";
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

test("a Game that does not opt into establishCoreLock starts exactly as before - unlocked, no extra calls", async () => {
  // Every existing caller (the bridge, every other test) constructs Game
  // this way and must see zero behavior change.
  let cmds = 0;
  const fake = await startFakeTuner((ctx) => { cmds++; return ctx.emitJson({ ran: ctx.state }); });
  const game = new Game({ port: fake.port, trace: false });
  try {
    assert.equal(game.coreLocked, undefined);
    assert.equal((await game.lua(CORE_STATE, "emitJson(1)")).value.ran, "GameCore_Tuner");
    assert.equal(cmds, 1, "no hidden fact-finding call was made");
  } finally {
    game.tuner.close();
    await fake.close();
  }
});

test("a direct client (establishCoreLock) starts fail-closed and stays locked until it reads real multiplayer facts", async () => {
  // Unlike the bridge, cli/civ.mjs's --direct path never runs a poll, so it
  // must establish the facts itself before its first core-editing call -
  // this is the CLI's exact construction (see directCtx() in cli/civ.mjs).
  let otherCmds = 0;
  const fake = await startFakeTuner((ctx) => {
    if (/GetHumanPlayerCount/.test(ctx.lua)) return ctx.emitJson({ mp: true, cloud: false, humans: 5, factsOk: true });
    otherCmds++;
    return ctx.emitJson({ ran: ctx.state });
  });
  const game = new Game({ port: fake.port, trace: false, establishCoreLock: true });
  try {
    assert.equal(game.coreLocked, UNKNOWN_LOCK, "fail closed before the facts are known");
    assert.equal((await game.lua(UI_STATE, "emitJson(1)")).value.ran, "InGame", "a UI read never needs the facts - CORE_LOCK_ALLOWED already covers it");
    assert.equal(game.coreLocked, UNKNOWN_LOCK, "a UI-only call does not trigger fact-finding");
    assert.equal(otherCmds, 1, "the UI read reached the game normally");
    await assert.rejects(game.lua(CORE_STATE, "emitJson(1)"), (e) => e.code === "core-locked");
    assert.equal(otherCmds, 1, "the real facts said multiplayer with others - the core-editing write never reached the game");
    assert.equal(game.coreLocked, MP_LOCK);
  } finally {
    game.tuner.close();
    await fake.close();
  }
});

test("two concurrent first core calls share one facts read and both succeed once it resolves (single player)", async () => {
  // coreLockEstablished was set true synchronously purely to stop a second
  // concurrent caller from starting its own redundant read - but that also
  // made the second caller treat the still-unknown coreLocked as final and
  // refuse before the real facts ever arrived.
  let factsCmds = 0;
  const fake = await startFakeTuner((ctx) => {
    if (/GetHumanPlayerCount/.test(ctx.lua)) {
      factsCmds++;
      return ctx.emitJson({ mp: false, cloud: false, humans: null, factsOk: true });
    }
    return ctx.emitJson({ ran: ctx.state });
  });
  const game = new Game({ port: fake.port, trace: false, establishCoreLock: true });
  try {
    const [a, b] = await Promise.allSettled([
      game.lua(CORE_STATE, "emitJson(1)"),
      game.lua(CORE_STATE, "emitJson(2)"),
    ]);
    assert.equal(a.status, "fulfilled", a.reason?.message);
    assert.equal(b.status, "fulfilled", b.reason?.message);
    assert.equal(a.value.value.ran, "GameCore_Tuner");
    assert.equal(b.value.value.ran, "GameCore_Tuner");
    assert.equal(factsCmds, 1, "both callers shared the one facts read");
    assert.equal(game.coreLocked, null);
  } finally {
    game.tuner.close();
    await fake.close();
  }
});

test("two concurrent first core calls share one facts read and both refuse once it resolves (multiplayer)", async () => {
  let factsCmds = 0;
  let coreCmds = 0;
  const fake = await startFakeTuner((ctx) => {
    if (/GetHumanPlayerCount/.test(ctx.lua)) {
      factsCmds++;
      return ctx.emitJson({ mp: true, cloud: false, humans: 5, factsOk: true });
    }
    coreCmds++;
    return ctx.emitJson({ ran: ctx.state });
  });
  const game = new Game({ port: fake.port, trace: false, establishCoreLock: true });
  try {
    const [a, b] = await Promise.allSettled([
      game.lua(CORE_STATE, "emitJson(1)"),
      game.lua(CORE_STATE, "emitJson(2)"),
    ]);
    assert.equal(a.status, "rejected");
    assert.equal(a.reason.code, "core-locked");
    // Checking the exact lock text, not just the error code, matters here:
    // a caller that wrongly bypassed the shared read would still be
    // refused, but with UNKNOWN_LOCK's wording (the still-unresolved
    // placeholder), not MP_LOCK's (the real, now-known reason).
    assert.equal(a.reason.message, MP_LOCK);
    assert.equal(b.status, "rejected");
    assert.equal(b.reason.code, "core-locked");
    assert.equal(b.reason.message, MP_LOCK);
    assert.equal(factsCmds, 1, "both callers shared the one facts read");
    assert.equal(coreCmds, 0, "neither core write ever reached the game");
    assert.equal(game.coreLocked, MP_LOCK);
  } finally {
    game.tuner.close();
    await fake.close();
  }
});

test("a caller arriving after a disconnect does not join the stale pre-disconnect establishment", async () => {
  // coreLockEstablishing (round 11) is a bare field with no epoch of its
  // own. The close handler bumps connectionEpoch and resets coreLocked/
  // coreLockEstablished but never touches coreLockEstablishing, so a
  // caller arriving after the disconnect would otherwise await the SAME
  // stale promise instead of starting its own read for the new session -
  // safe (the stale promise discards itself on the epoch mismatch), but it
  // leaves the new caller refused with UNKNOWN_LOCK and no fresh read ever
  // happens until a third, separate call tries again.
  let phase = "sp1";
  let factsCmds = 0;
  const fake = await startFakeTuner((ctx) => {
    if (/GetHumanPlayerCount/.test(ctx.lua)) {
      factsCmds++;
      return phase === "sp1"
        ? ctx.emitJson({ mp: false, cloud: false, humans: null, factsOk: true })
        : ctx.emitJson({ mp: false, cloud: false, humans: 1, factsOk: true });
    }
    return ctx.emitJson({ ran: ctx.state });
  });
  let releaseStarted;
  const releaseWaiting = new Promise((resolve) => { releaseStarted = resolve; });
  let releaseGate;
  const gated = new Promise((resolve) => { releaseGate = resolve; });
  let releases = 0;
  const lock = {
    async acquire() {},
    async release() {
      releases++;
      // The 1st release is the connect handshake's; the 2nd is the old
      // (pre-disconnect) facts read's own - hold it so it is still pending
      // when the new caller arrives.
      if (releases === 2) {
        releaseStarted();
        await gated;
      }
    },
  };
  const { TunerClient } = await import("../lib/tuner.mjs");
  const game = new Game({ tuner: new TunerClient({ port: fake.port, lock }), trace: false, establishCoreLock: true });
  try {
    const first = game.lua(CORE_STATE, "emitJson(1)");
    await releaseWaiting;
    const closed = new Promise((resolve) => game.tuner.once("close", resolve));
    fake.dropAll();
    await closed;
    phase = "sp2";
    // A new caller arrives after the disconnect, while the old attempt's
    // reply is still held pending - it must do its own fresh read, not
    // join the stale one.
    const second = game.lua(CORE_STATE, "emitJson(2)");
    releaseGate();
    const [, r2] = await Promise.allSettled([first, second]);
    assert.equal(r2.status, "fulfilled", r2.reason?.message);
    assert.equal(r2.value.value.ran, "GameCore_Tuner", "the new caller re-read the new session's facts and succeeded");
    assert.equal(factsCmds, 2, "the new caller did its own fresh read instead of joining the stale one");
    assert.equal(game.coreLocked, null);
  } finally {
    game.tuner.close();
    await fake.close();
  }
});

test("a direct client in an ordinary single-player game is not stuck refusing core edits forever", async () => {
  const fake = await startFakeTuner((ctx) => {
    if (/GetHumanPlayerCount/.test(ctx.lua)) return ctx.emitJson({ mp: false, cloud: false, humans: null, factsOk: true });
    return ctx.emitJson({ ran: ctx.state });
  });
  const game = new Game({ port: fake.port, trace: false, establishCoreLock: true });
  try {
    assert.equal(game.coreLocked, UNKNOWN_LOCK);
    assert.equal((await game.lua(CORE_STATE, "emitJson(1)")).value.ran, "GameCore_Tuner", "single player, once its facts are known, is never locked");
    assert.equal(game.coreLocked, null);
  } finally {
    game.tuner.close();
    await fake.close();
  }
});

test("a direct client re-establishes the facts after a lost connection reconnects to a different session", async () => {
  // coreLockEstablished must not outlive the connection it was learned on -
  // a dropped socket may reconnect to an entirely different game (closed
  // and reopened, or a different save), and the old session's facts say
  // nothing about the new one.
  let phase = "sp";
  const fake = await startFakeTuner((ctx) => {
    if (/GetHumanPlayerCount/.test(ctx.lua)) {
      return phase === "sp"
        ? ctx.emitJson({ mp: false, cloud: false, humans: null, factsOk: true })
        : ctx.emitJson({ mp: true, cloud: false, humans: 5, factsOk: true });
    }
    return ctx.emitJson({ ran: ctx.state });
  });
  const game = new Game({ port: fake.port, trace: false, establishCoreLock: true });
  try {
    assert.equal((await game.lua(CORE_STATE, "emitJson(1)")).value.ran, "GameCore_Tuner", "the first session is single player");
    assert.equal(game.coreLocked, null);

    const closed = new Promise((resolve) => game.tuner.once("close", resolve));
    fake.dropAll();
    await closed;
    phase = "mp";
    await assert.rejects(game.lua(CORE_STATE, "emitJson(1)"), (e) => e.code === "core-locked",
      "a reconnect must not reuse the previous session's facts - the new session is multiplayer");
    assert.equal(game.coreLocked, MP_LOCK);
  } finally {
    game.tuner.close();
    await fake.close();
  }
});

test("a direct client re-establishes facts after a call times out and resets the connection", async () => {
  // A timeout resets the connection through TunerClient#detach, not a
  // remote-initiated socket close - round 9's fix only covered the latter.
  let phase = "sp";
  const fake = await startFakeTuner((ctx) => {
    if (/GetHumanPlayerCount/.test(ctx.lua)) {
      return phase === "sp"
        ? ctx.emitJson({ mp: false, cloud: false, humans: null, factsOk: true })
        : ctx.emitJson({ mp: true, cloud: false, humans: 5, factsOk: true });
    }
    if (/--HANG/.test(ctx.lua)) return "no-end";
    return ctx.emitJson({ ran: ctx.state });
  });
  const { TunerClient } = await import("../lib/tuner.mjs");
  const game = new Game({ tuner: new TunerClient({ port: fake.port, lock: false, lateGraceMs: 10 }), trace: false, establishCoreLock: true });
  try {
    assert.equal((await game.lua(CORE_STATE, "emitJson(1)")).value.ran, "GameCore_Tuner", "the first session is single player");
    assert.equal(game.coreLocked, null);

    phase = "mp";
    // The timeout handler calls #detach synchronously, before the rejection
    // settles, so by the time this rejects any "close" effects already ran.
    await assert.rejects(game.lua(UI_STATE, "emitJson(1) --HANG", { timeoutMs: 10 }), (e) => e.code === "timeout");
    assert.equal(game.tuner.connected, false, "the timeout reset the connection");
    await assert.rejects(game.lua(CORE_STATE, "emitJson(1)"), (e) => e.code === "core-locked",
      "a timeout-triggered reset must not reuse the previous session's facts either - the new session is multiplayer");
    assert.equal(game.coreLocked, MP_LOCK);
  } finally {
    game.tuner.close();
    await fake.close();
  }
});

test("a direct client's in-flight facts read cannot overwrite a disconnect that happened while it was waiting to resolve", async () => {
  // The read's reply can already be fully received while tuner.exec() is
  // still waiting on an async mutex release before its promise resolves -
  // a disconnect that lands in that window must not be undone by the
  // stale reply arriving afterward.
  let phase = "sp";
  const fake = await startFakeTuner((ctx) => {
    if (/GetHumanPlayerCount/.test(ctx.lua)) {
      return phase === "sp"
        ? ctx.emitJson({ mp: false, cloud: false, humans: null, factsOk: true })
        : ctx.emitJson({ mp: true, cloud: false, humans: 5, factsOk: true });
    }
    return ctx.emitJson({ ran: ctx.state });
  });
  let releaseStarted;
  const releaseWaiting = new Promise((resolve) => { releaseStarted = resolve; });
  let releaseGate;
  const gated = new Promise((resolve) => { releaseGate = resolve; });
  let releases = 0;
  const lock = {
    async acquire() {},
    async release() {
      releases++;
      // The 1st release is the connect handshake's; the 2nd is the implicit
      // facts read's own - its reply has already arrived by this point.
      if (releases === 2) {
        releaseStarted();
        await gated;
      }
    },
  };
  const { TunerClient } = await import("../lib/tuner.mjs");
  const game = new Game({ tuner: new TunerClient({ port: fake.port, lock }), trace: false, establishCoreLock: true });
  try {
    const core = game.lua(CORE_STATE, "emitJson(1)");
    await releaseWaiting;
    const closed = new Promise((resolve) => game.tuner.once("close", resolve));
    fake.dropAll();
    await closed;
    phase = "mp";
    releaseGate();
    await assert.rejects(core, (e) => e.code === "core-locked",
      "a stale in-flight reply must not re-unlock after the disconnect already invalidated it");
    // The stale reply is discarded outright, not replaced with a guessed
    // answer - coreLockEstablished stays false too, so the next call (not
    // this one) does a fresh read and would correctly see the new MP5 game.
    assert.equal(game.coreLocked, UNKNOWN_LOCK, "refused now and left to re-verify later, not upgraded to a guessed MP_LOCK");
    assert.equal((await game.lua(CORE_STATE, "emitJson(1)").catch((e) => e)).code, "core-locked");
    assert.equal(game.coreLocked, MP_LOCK, "a fresh call does re-read and correctly finds the new session is multiplayer");
  } finally {
    game.tuner.close();
    await fake.close();
  }
});

test("a direct client that cannot read the facts yet stays locked and retries on the next call", async () => {
  let attempts = 0;
  const fake = await startFakeTuner((ctx) => {
    if (/GetHumanPlayerCount/.test(ctx.lua)) {
      attempts++;
      if (attempts === 1) return ctx.runtimeError("GameConfiguration is not available yet");
      return ctx.emitJson({ mp: false, cloud: false, humans: null, factsOk: true });
    }
    return ctx.emitJson({ ran: ctx.state });
  });
  const game = new Game({ port: fake.port, trace: false, establishCoreLock: true });
  try {
    await assert.rejects(game.lua(CORE_STATE, "emitJson(1)"), (e) => e.code === "core-locked", "the first attempt could not read the facts - stays locked");
    assert.equal(game.coreLocked, UNKNOWN_LOCK);
    assert.equal((await game.lua(CORE_STATE, "emitJson(1)")).value.ran, "GameCore_Tuner", "the next call retries and succeeds once the facts are readable");
    assert.equal(attempts, 2);
  } finally {
    game.tuner.close();
    await fake.close();
  }
});

test("a direct client retries when the multiplayer getters fail, rather than trusting their false-by-default placeholders", async () => {
  // MP_FACTS_LUA inits mp/cloud to false before the pcalls run, so a failed
  // GameConfiguration.IsNetworkMultiplayer()/IsPlayByCloud() (e.g. no game
  // loaded yet) looks byte-for-byte identical to a confirmed single-player
  // read unless factsOk says otherwise - without it, this would unlock a
  // real multiplayer game on the strength of a read that never happened.
  let attempts = 0;
  const fake = await startFakeTuner((ctx) => {
    if (/GetHumanPlayerCount/.test(ctx.lua)) {
      attempts++;
      if (attempts === 1) return ctx.emitJson({ mp: false, cloud: false, humans: null, factsOk: false });
      return ctx.emitJson({ mp: true, cloud: false, humans: 5, factsOk: true });
    }
    return ctx.emitJson({ ran: ctx.state });
  });
  const game = new Game({ port: fake.port, trace: false, establishCoreLock: true });
  try {
    await assert.rejects(game.lua(CORE_STATE, "emitJson(1)"), (e) => e.code === "core-locked",
      "a failed-getter read must not be trusted as confirmed single player");
    assert.equal(game.coreLocked, UNKNOWN_LOCK, "still unestablished - nothing reliable was learned");
    await assert.rejects(game.lua(CORE_STATE, "emitJson(1)"), (e) => e.code === "core-locked",
      "the retried read is reliable and says real multiplayer");
    assert.equal(game.coreLocked, MP_LOCK);
    assert.equal(attempts, 2, "the unreliable read did not count as 'established' - it was retried");
  } finally {
    game.tuner.close();
    await fake.close();
  }
});

test("a direct client does not send any CMD for its lazy fact-finding while paused", async () => {
  // paused means "the game is loading, leaving or between sessions: no
  // calls at all" (a call into a half-torn-down game can crash it - the
  // 2026-10-04 incident). The implicit bootstrap must not be exempt.
  let cmds = 0;
  const fake = await startFakeTuner((ctx) => { cmds++; return ctx.emitJson({ mp: true, cloud: false, humans: 5, factsOk: true }); });
  const game = new Game({ port: fake.port, trace: false, establishCoreLock: true });
  try {
    game.paused = "the game is loading or between sessions";
    await assert.rejects(game.lua(CORE_STATE, "emitJson(1)"), (e) => e.code === "paused");
    assert.equal(cmds, 0, "no fact-finding CMD was sent while paused");
    assert.equal(game.coreLocked, UNKNOWN_LOCK, "still unestablished - nothing was learned while paused");
    game.paused = null;
    await assert.rejects(game.lua(CORE_STATE, "emitJson(1)"), (e) => e.code === "core-locked", "once unpaused, the facts are read and this game is multiplayer");
    assert.equal(cmds, 1, "fact-finding ran exactly once, only after pause lifted");
    assert.equal(game.coreLocked, MP_LOCK);
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
  // factsOk: false means the getters themselves failed (false-by-default
  // placeholders, not a confirmed read) - must not be trusted even though
  // mp/cloud/humans are all present and well-typed. Both server.mjs's
  // POLL_LUA and game.mjs's MP_FACTS_LUA report this the same way, so this
  // one guard protects every caller.
  assert.equal(multiplayerLock({ mp: false, cloud: false, humans: null, factsOk: false }, UNKNOWN_LOCK), UNKNOWN_LOCK,
    "a failed read must not unlock from unknown");
  assert.equal(multiplayerLock({ mp: false, cloud: false, humans: null, factsOk: false }, MP_LOCK), MP_LOCK,
    "a failed read must not unlock an already-known multiplayer game either");
  assert.equal(multiplayerLock({ mp: true, cloud: false, humans: 5, factsOk: true }, UNKNOWN_LOCK), MP_LOCK,
    "a reliable read still locks normally");
  // "A failed read keeps the current lock" is only safe when the current
  // lock is already restrictive. A *previous* reliable read confirming
  // single player (current === null) is not a fact that keeps being true
  // on its own - losing the ability to re-verify it must mean "unknown",
  // not "still trusted", or a core edit could land while the real status
  // is genuinely unverified (reviewer's prior-SP-then-failed-getter case).
  assert.equal(multiplayerLock({ mp: false, cloud: false, humans: null, factsOk: false }, null), UNKNOWN_LOCK,
    "an unreliable read after a confirmed single-player session must not stay unlocked");
});

test("a lock applied while a call is queued prevents its command from reaching the game", async () => {
  // The first call holds the tuner queue. The later call passes Game.exec's
  // initial check while it is unlocked, then waits behind that first call.
  let releaseFirst;
  const held = new Promise((resolve) => { releaseFirst = resolve; });
  let firstStarted;
  const started = new Promise((resolve) => { firstStarted = resolve; });
  const sent = [];
  const fake = await startFakeTuner(async (ctx) => {
    sent.push(ctx.state);
    if (sent.length === 1) {
      firstStarted();
      await held;
    }
    ctx.emitJson({ ok: true });
  });
  const game = new Game({ port: fake.port, trace: false });
  try {
    await game.ensureConnected();
    const first = game.lua(UI_STATE, "emitJson({ok=true})");
    await started;
    const core = game.lua(CORE_STATE, "emitJson({ok=true})");
    // Give the async entry path time to put the call in the tuner's queue.
    await new Promise((resolve) => setImmediate(resolve));
    game.coreLocked = "multiplayer: edits off";
    const rejected = assert.rejects(core, (e) => e.code === "core-locked");
    releaseFirst();
    await first;
    await rejected;
    assert.deepEqual(sent, [UI_STATE], "the queued core command was never sent");
    assert.equal((await game.lua(UI_STATE, "emitJson({ok=true})")).value.ok, true,
      "the lock still permits normal UI calls and the rejected call releases the queue");
  } finally {
    releaseFirst();
    game.tuner.close();
    await fake.close();
  }
});

test("pausing while a command waits for the machine-wide mutex is checked before dispatch", async () => {
  let releaseLock;
  let lockStarted;
  const waiting = new Promise((resolve) => { lockStarted = resolve; });
  const held = new Promise((resolve) => { releaseLock = resolve; });
  let acquisitions = 0;
  let releases = 0;
  const lock = {
    async acquire() {
      if (++acquisitions > 1) {
        lockStarted();
        await held;
      }
    },
    async release() { releases++; },
  };
  const fake = await startFakeTuner((ctx) => ctx.emitJson({ ok: true }));
  const { TunerClient } = await import("../lib/tuner.mjs");
  const game = new Game({ tuner: new TunerClient({ port: fake.port, lock }), trace: false });
  try {
    await game.ensureConnected();
    const call = game.lua(UI_STATE, "emitJson({ok=true})");
    await waiting;
    game.paused = "loading";
    const rejected = assert.rejects(call, (e) => e.code === "paused");
    releaseLock();
    await rejected;
    assert.equal(fake.received.filter((f) => f.payload.startsWith("CMD:")).length, 0,
      "nothing was sent after the game became paused");
    assert.equal(releases, 2, "both the handshake and the rejected call release the mutex");
    assert.equal((await game.lua(UI_STATE, "emitJson({ok=true})", { force: true })).value.ok, true,
      "the internal poll can still dispatch while paused");
  } finally {
    releaseLock();
    game.tuner.close();
    await fake.close();
  }
});

test("a direct client's implicit bootstrap obeys a pause that lands while it is queued behind another call", async () => {
  // The round-4 fix only checked !this.paused before starting the implicit
  // facts read - too early to catch a pause that lands while that read is
  // still queued behind an earlier call.
  let releaseFirst;
  const held = new Promise((resolve) => { releaseFirst = resolve; });
  let firstStarted;
  const started = new Promise((resolve) => { firstStarted = resolve; });
  const sent = [];
  const fake = await startFakeTuner(async (ctx) => {
    sent.push(ctx.state);
    if (sent.length === 1) {
      firstStarted();
      await held;
    }
    ctx.emitJson({ mp: true, cloud: false, humans: 5, factsOk: true });
  });
  const game = new Game({ port: fake.port, trace: false, establishCoreLock: true });
  try {
    await game.ensureConnected();
    const first = game.lua(UI_STATE, "emitJson({ok=true})");
    await started;
    const core = game.lua(CORE_STATE, "emitJson({ok=true})");
    // Give the async entry path time to queue the implicit facts read.
    await new Promise((resolve) => setImmediate(resolve));
    game.paused = "loading";
    const rejected = assert.rejects(core, (e) => e.code === "paused");
    releaseFirst();
    await first;
    await rejected;
    assert.deepEqual(sent, [UI_STATE], "the queued implicit facts read was never sent once paused");
    assert.equal(game.coreLocked, UNKNOWN_LOCK, "nothing was learned while paused");
  } finally {
    releaseFirst();
    game.tuner.close();
    await fake.close();
  }
});

test("a direct client's implicit bootstrap obeys a pause that lands while it waits for the machine-wide mutex", async () => {
  let releaseLock;
  let lockStarted;
  const waiting = new Promise((resolve) => { lockStarted = resolve; });
  const held = new Promise((resolve) => { releaseLock = resolve; });
  let acquisitions = 0;
  let releases = 0;
  const lock = {
    async acquire() {
      if (++acquisitions > 1) {
        lockStarted();
        await held;
      }
    },
    async release() { releases++; },
  };
  const fake = await startFakeTuner((ctx) => ctx.emitJson({ mp: true, cloud: false, humans: 5, factsOk: true }));
  const { TunerClient } = await import("../lib/tuner.mjs");
  const game = new Game({ tuner: new TunerClient({ port: fake.port, lock }), trace: false, establishCoreLock: true });
  try {
    await game.ensureConnected();
    const core = game.lua(CORE_STATE, "emitJson({ok=true})");
    await waiting;
    game.paused = "loading";
    const rejected = assert.rejects(core, (e) => e.code === "paused");
    releaseLock();
    await rejected;
    assert.equal(fake.received.filter((f) => f.payload.startsWith("CMD:")).length, 0,
      "nothing was sent after the game became paused, not even the implicit facts read");
    assert.equal(releases, 2, "both the handshake and the rejected facts read release the mutex");
    assert.equal(game.coreLocked, UNKNOWN_LOCK, "nothing was learned while paused");
  } finally {
    releaseLock();
    game.tuner.close();
    await fake.close();
  }
});

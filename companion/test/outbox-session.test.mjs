// ExposedMembers is app-wide (outlives a game - server.mjs's POLL_LUA comment
// at lines 354-355 of AGENTS.md documents this), but a panel request belongs
// to the session that queued it. The panel's own init must discard anything
// left over from a previous game before the bridge's next poll can ever see
// it, exactly the way it already discards `taken`; otherwise a stale queued
// click (e.g. a city/unit edit) replays against whatever is selected in the
// new game once the bridge drains it.
//
// Phase 1 (this file also covers): every panel incarnation stamps a
// generation once at init, and every request it queues carries that same
// value. A reply/button update captured under an older generation must not
// land in a newer one's UI or clear its taken entry - REPLY_LUA/BUTTONS_LUA
// (lib/panel-mailbox.mjs) check this before acting, and the panel's own
// OnReply/OnButtons check it a second time as defense in depth.
//
// Executes the real statements' AST, the same approach actions-plot-bounds.
// test.mjs uses for actions.lua: this runs the actual shipped source text,
// not a hand-copied description of it.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import luaparse from "luaparse";
import { POLL_LUA, REPLY_LUA, BUTTONS_LUA } from "../lib/panel-mailbox.mjs";

const SERVER_SOURCE = fs.readFileSync(new URL("../server.mjs", import.meta.url), "utf8");

const PANEL_SOURCE = fs.readFileSync(new URL("../../mod/AICivCopilot/UI/AICivCopilotPanel.lua", import.meta.url), "utf8");
const INIT_START = "ExposedMembers.AICivCopilot = ExposedMembers.AICivCopilot or {};";
const INIT_END = "local TABS = {";

function extractInit(source) {
  const start = source.indexOf(INIT_START);
  const end = source.indexOf(INIT_END);
  assert.ok(start >= 0 && end > start, "panel init markers not found - the file shape changed");
  return source.slice(start, end);
}

const FIXED_INIT = extractInit(PANEL_SOURCE);
// The exact pre-fix line this test guards against, confirmed against the
// diff: the fix only replaces this one default-preserving read with a plain
// reset, the same treatment Mailbox.taken already had.
assert.match(FIXED_INIT, /Mailbox\.outbox = \{\};/, "the shipped source must reset outbox unconditionally");
const PRE_FIX_INIT = FIXED_INIT.replace("Mailbox.outbox = {};", "Mailbox.outbox = Mailbox.outbox or {};");

// The line right after a given function signature in the real panel source -
// used to pull out just the new generation guard clause, not a rewritten
// description of it.
function extractGuardLine(signature) {
  const at = PANEL_SOURCE.indexOf(signature);
  assert.ok(at >= 0, `${signature} not found - the file shape changed`);
  const lineStart = PANEL_SOURCE.indexOf("\n", at) + 1;
  const lineEnd = PANEL_SOURCE.indexOf("\n", lineStart);
  return PANEL_SOURCE.slice(lineStart, lineEnd).trim();
}

const truthy = (v) => ![undefined, null, false].includes(v);
const RETURN = Symbol("Lua return");

function evaluate(n, scope) {
  switch (n.type) {
    case "Identifier": return scope[n.name];
    case "NilLiteral": return undefined;
    case "BooleanLiteral":
    case "NumericLiteral":
    case "StringLiteral": return n.value;
    case "MemberExpression": return evaluate(n.base, scope)[n.identifier.name];
    case "IndexExpression": return evaluate(n.base, scope)[evaluate(n.index, scope)];
    case "UnaryExpression":
      if (n.operator === "not") return !truthy(evaluate(n.argument, scope));
      break;
    case "LogicalExpression": {
      const left = evaluate(n.left, scope);
      if (n.operator === "or") return truthy(left) ? left : evaluate(n.right, scope);
      if (n.operator === "and") return truthy(left) ? evaluate(n.right, scope) : left;
      break;
    }
    case "BinaryExpression": {
      const a = evaluate(n.left, scope), b = evaluate(n.right, scope);
      if (n.operator === "==") return a === b;
      if (n.operator === "~=") return a !== b;
      if (n.operator === "+") return a + b;
      break;
    }
    case "TableConstructorExpression":
      assert.deepEqual(n.fields, [], "this interpreter only ever builds empty table literals ({})");
      return {};
    case "CallExpression": {
      const args = n.arguments.map((a) => evaluate(a, scope));
      const fn = n.base.type === "MemberExpression" ? evaluate(n.base.base, scope)[n.base.identifier.name] : evaluate(n.base, scope);
      return fn(...args);
    }
  }
  throw new Error(`unsupported expression ${n.type} ${n.operator || ""}`);
}

function assign(target, value, scope) {
  if (target.type === "Identifier") scope[target.name] = value;
  else if (target.type === "MemberExpression") evaluate(target.base, scope)[target.identifier.name] = value;
  else if (target.type === "IndexExpression") evaluate(target.base, scope)[evaluate(target.index, scope)] = value;
  else throw new Error(`unsupported assignment ${target.type}`);
}

// Returns {[RETURN]: value} if a `return` statement fired, so a caller
// (an enclosing if-body or the top-level runner) can stop early instead of
// continuing past it, matching real Lua control flow.
function execute(body, scope) {
  for (const n of body) {
    switch (n.type) {
      case "LocalStatement":
      case "AssignmentStatement":
        n.variables.forEach((target, i) => assign(target, evaluate(n.init[i], scope), scope));
        break;
      case "IfStatement":
        for (const clause of n.clauses) {
          if (!clause.condition || truthy(evaluate(clause.condition, scope))) {
            const r = execute(clause.body, scope);
            if (r) return r;
            break;
          }
        }
        break;
      case "CallStatement":
        evaluate(n.expression, scope);
        break;
      case "ReturnStatement":
        return { [RETURN]: n.arguments.length ? evaluate(n.arguments[0], scope) : undefined };
      default: throw new Error(`unsupported statement ${n.type}`);
    }
  }
}

// Runs one init snippet against a given pre-existing ExposedMembers (or none,
// for a first-ever game) and returns the Mailbox it produced.
function runInit(source, exposedMembers = {}) {
  const ast = luaparse.parse(source, { luaVersion: "5.1", encodingMode: "x-user-defined" });
  const scope = { ExposedMembers: exposedMembers };
  execute(ast.body, scope);
  return scope.ExposedMembers.AICivCopilot;
}

test("a stale previous-session outbox entry does not survive the fixed panel init", () => {
  const stale = { outbox: [{ id: 77, kind: "quick", key: "heal", turn: 200 }], taken: { 77: { id: 77 } }, events: [{ kind: "turn" }], version: 4 };
  const mailbox = runInit(FIXED_INIT, { AICivCopilot: stale });
  // The interpreter models every Lua table (array-style or not) as a plain
  // object, same as real Lua itself makes no such distinction - {} is empty
  // either way.
  assert.deepEqual(mailbox.outbox, {}, "a previous game's queued-but-undrained request must not reach the new session");
  assert.deepEqual(mailbox.taken, {}, "taken must still be cleared, as before");
  assert.equal(mailbox.version, 5);
});

test("the pre-fix line actually leaked the stale entry (this reproduces the real bug)", () => {
  const stale = { outbox: [{ id: 77, kind: "quick", key: "heal", turn: 200 }], taken: { 77: { id: 77 } }, events: [] };
  const mailbox = runInit(PRE_FIX_INIT, { AICivCopilot: stale });
  assert.deepEqual(mailbox.outbox, [{ id: 77, kind: "quick", key: "heal", turn: 200 }], "confirms the old `outbox or {}` default actually preserved the stale request");
  assert.deepEqual(mailbox.taken, {}, "taken was already correctly cleared before this fix - isolates the one changed line");
});

test("a first-ever game (no prior ExposedMembers.AICivCopilot) still initializes cleanly", () => {
  const mailbox = runInit(FIXED_INIT, {});
  assert.deepEqual(mailbox.outbox, {});
  assert.deepEqual(mailbox.taken, {});
  assert.deepEqual(mailbox.events, {});
  assert.equal(mailbox.version, 5);
  assert.equal(mailbox.autoBrief, true);
  assert.equal(mailbox.autoAdvise, false);
  assert.equal(mailbox.alerts, true);
  assert.equal(mailbox.generation, 1, "the first ever panel is generation 1");
});

test("the player's own toggle choices still survive a same-session reload (not part of this fix)", () => {
  const prior = { outbox: [], taken: {}, events: [], autoBrief: false, autoAdvise: true, alerts: false };
  const mailbox = runInit(FIXED_INIT, { AICivCopilot: prior });
  assert.equal(mailbox.autoBrief, false, "resetting outbox/taken must not collaterally reset unrelated toggles");
  assert.equal(mailbox.autoAdvise, true);
  assert.equal(mailbox.alerts, false);
});

test("generation is continued and incremented on every reinit, never reset, like nextId", () => {
  let exposed = {};
  for (let expected = 1; expected <= 3; expected++) {
    const mailbox = runInit(FIXED_INIT, exposed);
    assert.equal(mailbox.generation, expected, `incarnation #${expected}`);
    exposed = { AICivCopilot: mailbox };
  }
});

test("Queue() and the New-button request both stamp the queuing incarnation's generation", () => {
  // A low-risk, mechanical field addition (unlike the conditional generation
  // logic above and below, which gets full behavioral execution) - checked
  // directly against the real source text rather than modelling table.insert
  // and the engine globals (Selection, Game.GetCurrentGameTurn) it also calls.
  const queueInsert = /table\.insert\(Mailbox\.outbox, \{ id = id,[^}]*\}\);/.exec(PANEL_SOURCE);
  assert.ok(queueInsert, "Queue()'s table.insert call not found - the file shape changed");
  assert.match(queueInsert[0], /generation = MY_GENERATION/);
  const newInsert = /table\.insert\(Mailbox\.outbox, \{ id = 0, kind = "new",[^}]*\}\);/.exec(PANEL_SOURCE);
  assert.ok(newInsert, "the New-button table.insert call not found - the file shape changed");
  assert.match(newInsert[0], /generation = MY_GENERATION/);
});

// Executes the real REPLY_LUA/BUTTONS_LUA bodies (imported from the same
// module server.mjs uses) against a stubbed ExposedMembers/LuaEvents - the
// actual wire-protocol text, not a description of it.
function runProtocol(source, { exposedMembers, params }) {
  const ast = luaparse.parse(source, { luaVersion: "5.1", encodingMode: "x-user-defined" });
  const fired = [];
  const scope = {
    ExposedMembers: exposedMembers,
    P: params,
    LuaEvents: { AICivCopilot_Reply: (...a) => fired.push(a), AICivCopilot_Buttons: (...a) => fired.push(a) },
  };
  execute(ast.body, scope);
  return { exposedMembers, fired };
}

test("REPLY_LUA refuses a confirmed-stale generation: no LuaEvent, taken left untouched", () => {
  const exposedMembers = { AICivCopilot: { generation: 2, taken: { 7: { id: 7 } } } };
  const { fired } = runProtocol(REPLY_LUA, { exposedMembers, params: { generation: 1, id: 7, kind: "answer", text: "late answer from generation 1" } });
  assert.deepEqual(fired, [], "a reply captured under a generation that is confirmedly no longer current must never reach the panel");
  assert.ok(exposedMembers.AICivCopilot.taken[7], "a refused reply must not clear a current taken entry either");
});

test("REPLY_LUA accepts a matching generation and an ambiguous (unstamped) one", () => {
  for (const generation of [2, undefined]) {
    const exposedMembers = { AICivCopilot: { generation: 2, taken: { 7: { id: 7 } } } };
    const { fired } = runProtocol(REPLY_LUA, { exposedMembers, params: { generation, id: 7, kind: "answer", text: "ok" } });
    // generation is trailing (ABI compatibility with an older/newer
    // installed panel - see panel-mailbox.mjs), not leading.
    assert.deepEqual(fired, [[7, "answer", "ok", generation]], `generation=${generation}`);
    assert.equal(exposedMembers.AICivCopilot.taken[7], undefined, "an accepted answer still clears its taken entry");
  }
});

test("REPLY_LUA status/hello never clear taken, matching the existing protocol", () => {
  const exposedMembers = { AICivCopilot: { generation: 1, taken: { 7: { id: 7 } } } };
  runProtocol(REPLY_LUA, { exposedMembers, params: { generation: 1, id: 7, kind: "status", text: "..." } });
  assert.ok(exposedMembers.AICivCopilot.taken[7]);
});

test("BUTTONS_LUA refuses a confirmed-stale generation, accepts a matching or ambiguous one", () => {
  const stale = runProtocol(BUTTONS_LUA, { exposedMembers: { AICivCopilot: { generation: 2 } }, params: { generation: 1, group: "abilities", items: ["old"] } });
  assert.deepEqual(stale.fired, [], "a stale button update must never reach the panel");
  for (const generation of [2, undefined]) {
    const ok = runProtocol(BUTTONS_LUA, { exposedMembers: { AICivCopilot: { generation: 2 } }, params: { generation, group: "abilities", items: ["new"] } });
    assert.deepEqual(ok.fired, [["abilities", ["new"], generation]]);
  }
});

// The exact tail of pollPanel (server.mjs) that gates recovery/dispatch on
// `loaded` - run via vm so this is the real shipped statements, not a
// reimplementation of them.
const DRAIN_TAIL_START = "if (!recovered && loaded) {";
const DRAIN_TAIL_END = /\n\}\r?\n\r?\n\/\/ When the game connection/;
function extractDrainTail() {
  const start = SERVER_SOURCE.indexOf(DRAIN_TAIL_START);
  assert.ok(start >= 0, "pollPanel's drain tail start not found - the file shape changed");
  const after = SERVER_SOURCE.slice(start);
  const m = DRAIN_TAIL_END.exec(after);
  assert.ok(m, "pollPanel's drain tail end not found - the file shape changed");
  return after.slice(0, m.index);
}

test("pollPanel's drain/recovery tail only runs once this game's panel is confirmed loaded", async () => {
  const tail = extractDrainTail();
  for (const loaded of [false, true]) {
    const handled = [];
    const recoverCalls = [];
    let recovered = false;
    const env = {
      loaded,
      get recovered() { return recovered; },
      set recovered(v) { recovered = v; },
      recover: async (list) => recoverCalls.push(list),
      handlePanel: async (q) => handled.push(q),
      res: { recovered: ["stale-or-current-recovered"], questions: [{ id: 1, kind: "quick" }] },
    };
    const context = vm.createContext(env);
    await vm.runInContext(`(async () => { ${tail} })()`, context);
    assert.equal(recoverCalls.length, loaded ? 1 : 0, `loaded=${loaded}`);
    assert.deepEqual(handled, loaded ? [{ id: 1, kind: "quick" }] : [], `loaded=${loaded}`);
    assert.equal(recovered, loaded, "recovered must only flip once recovery actually ran, so a later loaded poll still recovers");
  }
});

// The whole pollPanel function, run via vm against a full stub environment -
// the drain-tail fragment above only covers the gate's own tail; this proves
// the gate stays correct when a successful mid-poll injection changes
// `loaded` after `res` (this same poll's POLL_LUA result) was already
// captured from the panel that existed *before* that injection.
const POLL_PANEL_START = "async function pollPanel() {";
const POLL_PANEL_END = /\n\}\r?\n\r?\n\/\/ When the game connection/;
function extractPollPanel() {
  const start = SERVER_SOURCE.indexOf(POLL_PANEL_START);
  assert.ok(start >= 0, "pollPanel start not found - the file shape changed");
  const after = SERVER_SOURCE.slice(start);
  const m = POLL_PANEL_END.exec(after);
  assert.ok(m, "pollPanel end not found - the file shape changed");
  return after.slice(0, m.index + 2); // include the function's own closing "}"
}
const FIXED_POLL_PANEL = extractPollPanel();
assert.match(FIXED_POLL_PANEL, /if \(await injectPanel\(\)\) \{/, "the shipped source must discard this poll's result on a successful mid-poll injection");
// The exact pre-fix shape this test discriminates against: injectPanel()'s
// success just overwrote `loaded` in place, with no return - so the rest of
// the function went on to trust this poll's already-stale `res`.
const PRE_FIX_POLL_PANEL = FIXED_POLL_PANEL.replace(
  /if \(await injectPanel\(\)\) \{[\s\S]*?return;\s*\}/,
  "loaded = await injectPanel();",
);
assert.doesNotMatch(PRE_FIX_POLL_PANEL, /if \(await injectPanel/, "the pre-fix reconstruction must not still contain the fix");

function pollPanelHarness(source, { injects }) {
  const handled = [];
  const recoverCalls = [];
  let recovered = false;
  let panelGeneration;
  // What POLL_LUA returns this poll - captured from the panel that existed
  // *before* any injection below, carrying its (stale, generation 1) data.
  const staleRes = {
    panel: true, generation: 1, version: 5, turn: 1,
    questions: [{ id: 17, kind: "quick", key: "heal", generation: 1 }],
    recovered: [{ id: 16, generation: 1 }], events: [], mp: false, cloud: false, humans: 1, factsOk: true,
  };
  const env = {
    game: {
      connected: true, paused: null, coreLocked: null,
      tuner: { states: [], refreshStates: async () => {} }, // still not loaded right after the refresh
      lua: async (state, code) => {
        assert.equal(state, "InGame");
        assert.equal(code, POLL_LUA);
        return { value: staleRes };
      },
      standing: async () => null,
    },
    UI_STATE: "InGame", PANEL_STATE: "AICivCopilotPanel", POLL_LUA, UNKNOWN_LOCK: "unknown",
    log: () => {}, stale: false, snapCache: null, applyMultiplayer: () => {}, lastStateRefresh: 0,
    injectPanel: async () => {
      if (!injects) return false;
      // A real injection loads the panel's own fresh Lua context - its
      // mailbox/generation moved on from what `staleRes` above captured.
      env.game.tuner.states = [{ name: "AICivCopilotPanel" }];
      return true;
    },
    get recovered() { return recovered; },
    set recovered(v) { recovered = v; },
    recover: async (list) => recoverCalls.push(list),
    handlePanel: async (q) => handled.push(q),
    state: {
      panel: false, lastHistoryTurn: 1,
      get panelGeneration() { return panelGeneration; },
      set panelGeneration(v) { panelGeneration = v; },
    },
    memory: { events: { add: () => {} }, history: { record: () => {} } },
    reply: async () => {}, sendButtons: async () => {},
    shortModel: (s) => s, ADVISOR_MODEL: "advisor", DIG_MODEL: "dig", TABS: [], abilityButtons: () => [],
  };
  return { env, handled, recoverCalls, resultOf: () => ({ recovered, panelGeneration }) };
}

test("a successful mid-poll injection defers this poll's stale pre-injection mailbox to the next poll", async () => {
  for (const injects of [true, false]) {
    const { env, handled, recoverCalls, resultOf } = pollPanelHarness(FIXED_POLL_PANEL, { injects });
    const context = vm.createContext(env);
    vm.runInContext(`${FIXED_POLL_PANEL}\nglobalThis.__invoke = pollPanel;`, context);
    await context.__invoke();
    assert.deepEqual(handled, [], `injects=${injects}: a request captured before injection must never dispatch this poll`);
    assert.deepEqual(recoverCalls, [], `injects=${injects}`);
    assert.equal(resultOf().recovered, false, `injects=${injects}: recovered must stay false so a later, genuinely-fresh poll still recovers`);
    assert.equal(resultOf().panelGeneration, undefined, `injects=${injects}: must not adopt the stale res's generation as current`);
  }
});

test("the pre-fix shape actually dispatched the stale pre-injection request (this reproduces the real bug)", async () => {
  const { env, handled, recoverCalls, resultOf } = pollPanelHarness(PRE_FIX_POLL_PANEL, { injects: true });
  const context = vm.createContext(env);
  vm.runInContext(`${PRE_FIX_POLL_PANEL}\nglobalThis.__invoke = pollPanel;`, context);
  await context.__invoke();
  assert.deepEqual(handled, [{ id: 17, kind: "quick", key: "heal", generation: 1 }], "confirms the pre-fix code dispatched a request captured before the injection that replaced its mailbox");
  assert.deepEqual(recoverCalls, [[{ id: 16, generation: 1 }]]);
  assert.equal(resultOf().panelGeneration, 1, "confirms it also adopted the stale generation as current, corrupting later reply/button routing");
});

test("the panel's own OnButtons/OnReply guard line mirrors the same confirmed-mismatch-only rule", () => {
  for (const [signature, extra] of [
    ["local function OnButtons(group, items, generation)", {}],
    ["local function OnReply(id, kind, text, generation)", {}],
  ]) {
    const guard = extractGuardLine(signature);
    assert.match(guard, /generation ~= nil and generation ~= MY_GENERATION/, signature);
    for (const [generation, shouldReturn] of [[5, true], [7, false], [undefined, false]]) {
      const ast = luaparse.parse(`${guard}\nreturn "reached"`, { luaVersion: "5.1", encodingMode: "x-user-defined" });
      const scope = { generation, MY_GENERATION: 7, ...extra };
      const r = execute(ast.body, scope);
      // The guard's own bare `return;` never reaches the appended marker;
      // falling through to it (shouldReturn=false) does.
      assert.equal(r?.[RETURN] !== "reached", shouldReturn, `${signature} generation=${generation}`);
    }
  }
});

function extractParams(signature) {
  assert.ok(PANEL_SOURCE.includes(signature), `${signature} not found - the file shape changed`);
  const m = /\(([^)]*)\)/.exec(signature);
  return m[1].split(",").map((s) => s.trim());
}

test("generation is the trailing parameter on both sides of the wire, not a leading one", () => {
  // Lua silently drops an extra trailing call argument a callee never
  // declared, and gives nil for a declared trailing parameter the caller
  // never supplied - but shifts every position if a field is inserted at
  // the front instead. generation must stay last everywhere for an
  // older/newer bridge-panel pair's existing fields to never shift:
  // REPLY_LUA/BUTTONS_LUA's LuaEvents calls (panel-mailbox.mjs, checked
  // directly here, not just by reading the module) and the panel's own
  // OnReply/OnButtons declarations (checked via the real extracted source,
  // like the guard-line test above).
  assert.match(REPLY_LUA, /LuaEvents\.AICivCopilot_Reply\(P\.id, P\.kind, P\.text, P\.generation\)/);
  assert.match(BUTTONS_LUA, /LuaEvents\.AICivCopilot_Buttons\(P\.group, P\.items, P\.generation\)/);
  for (const signature of ["local function OnReply(id, kind, text, generation)", "local function OnButtons(group, items, generation)"]) {
    const params = extractParams(signature);
    assert.equal(params.at(-1), "generation", signature);
  }
});

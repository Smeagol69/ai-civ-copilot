// ExposedMembers is app-wide (outlives a game - server.mjs's POLL_LUA comment
// at lines 354-355 of AGENTS.md documents this), but a panel request belongs
// to the session that queued it. The panel's own init must discard anything
// left over from a previous game before the bridge's next poll can ever see
// it, exactly the way it already discards `taken`; otherwise a stale queued
// click (e.g. a city/unit edit) replays against whatever is selected in the
// new game once the bridge drains it.
//
// Executes the real init statements' AST, the same approach
// actions-plot-bounds.test.mjs uses for actions.lua: this runs the actual
// shipped source text, not a hand-copied description of it.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import luaparse from "luaparse";

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

const truthy = (v) => ![undefined, null, false].includes(v);

function evaluate(n, scope) {
  switch (n.type) {
    case "Identifier": return scope[n.name];
    case "NilLiteral": return undefined;
    case "BooleanLiteral":
    case "NumericLiteral": return n.value;
    case "MemberExpression": return evaluate(n.base, scope)[n.identifier.name];
    case "LogicalExpression": {
      const left = evaluate(n.left, scope);
      if (n.operator === "or") return truthy(left) ? left : evaluate(n.right, scope);
      break;
    }
    case "BinaryExpression":
      if (n.operator === "==") return evaluate(n.left, scope) === evaluate(n.right, scope);
      break;
    case "TableConstructorExpression":
      assert.deepEqual(n.fields, [], "this init snippet only ever builds empty table literals ({})");
      return {};
  }
  throw new Error(`unsupported expression ${n.type} ${n.operator || ""}`);
}

function assign(target, value, scope) {
  if (target.type === "Identifier") scope[target.name] = value;
  else if (target.type === "MemberExpression") evaluate(target.base, scope)[target.identifier.name] = value;
  else throw new Error(`unsupported assignment ${target.type}`);
}

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
            execute(clause.body, scope);
            break;
          }
        }
        break;
      default: throw new Error(`unsupported statement ${n.type}`);
    }
  }
}

// Runs one init snippet against a given pre-existing ExposedMembers (or none,
// for a first-ever game) and returns the Mailbox it produced.
function runInit(source, exposedMembers = {}) {
  const ast = luaparse.parse(source, { luaVersion: "5.1" });
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
});

test("the player's own toggle choices still survive a same-session reload (not part of this fix)", () => {
  const prior = { outbox: [], taken: {}, events: [], autoBrief: false, autoAdvise: true, alerts: false };
  const mailbox = runInit(FIXED_INIT, { AICivCopilot: prior });
  assert.equal(mailbox.autoBrief, false, "resetting outbox/taken must not collaterally reset unrelated toggles");
  assert.equal(mailbox.autoAdvise, true);
  assert.equal(mailbox.alerts, false);
});

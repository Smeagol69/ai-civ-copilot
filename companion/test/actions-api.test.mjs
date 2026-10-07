// Every engine call an action makes must exist in the Lua state that action
// runs in. Checked against the API catalogs scanned from the live game
// (companion/data/api-catalog, written by scan_api; skipped if absent).
// This is the class of bug that shipped once already: finish_production
// called BuildQueue:GetSize, which exists in InGame but not in GameCore.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import luaparse from "luaparse";
import { ACTIONS, ACTION_QUERIES, validateAction, performAction } from "../lib/actions.mjs";
import { loadLua, Game } from "../lib/game.mjs";
import { startFakeTuner } from "./fixtures/fake-tuner.mjs";

const CATALOG_DIR = new URL("../data/api-catalog/", import.meta.url);
const catalogs = {};
for (const state of ["InGame", "GameCore_Tuner"]) {
  const f = new URL(`${state}.json`, CATALOG_DIR);
  if (fs.existsSync(f)) catalogs[state] = JSON.parse(fs.readFileSync(f, "utf8"));
}

// Split actions.lua into `function A.<name>(P) ... end` bodies.
function actionBodies() {
  const src = loadLua("actions");
  const out = {};
  const re = /^function A\.([a-z_]+)\(P\)([\s\S]*?)(?=^function A\.|^local fn = A\[)/gm;
  for (const m of src.matchAll(re)) out[m[1]] = m[2];
  return out;
}

// Lua methods and globals that are not engine API.
const NOT_ENGINE = new Set(["string", "table", "math", "pairs", "ipairs", "type", "tostring", "tonumber", "pcall", "next", "select"]);
const LOCAL_TABLES = new Set(["GameInfo", "Players", "PlayersVisibility", "PlayerConfigurations", "spec", "P", "o", "results", "res"]);

test("every engine call in an action exists in that action's Lua state", { skip: !catalogs.InGame || !catalogs.GameCore_Tuner ? "no live API catalog" : false }, () => {
  const bodies = actionBodies();
  const problems = [];
  for (const [name, body] of Object.entries(bodies)) {
    const base = name.replace(/^verify_/, "");
    const def = ACTIONS[base] || ACTION_QUERIES[base];
    if (!def) continue;
    const cat = catalogs[def.state];
    const methods = new Set(Object.values(cat.objects || {}).flat());
    const code = body.replace(/--[^\n]*/g, "").replace(/'[^'\n]*'|"[^"\n]*"/g, "''");
    for (const m of code.matchAll(/:([A-Z][A-Za-z0-9_]*)\(/g)) {
      if (!methods.has(m[1])) problems.push(`${name} [${def.state}] :${m[1]}()`);
    }
    for (const m of code.matchAll(/\b([A-Z][A-Za-z0-9_]*)\.([A-Za-z][A-Za-z0-9_]*)\b/g)) {
      const [, holder, member] = m;
      if (NOT_ENGINE.has(holder) || LOCAL_TABLES.has(holder)) continue;
      const g = cat.globals?.[holder];
      const e = cat.enums?.[holder];
      if (Array.isArray(g) ? g.includes(member) : false) continue;
      if (e && member in e) continue;
      if (g === "table") continue; // a table of non-functions the scan did not list
      problems.push(`${name} [${def.state}] ${holder}.${member}`);
    }
  }
  assert.deepEqual(problems, [], `calls missing from the live catalog:\n${problems.join("\n")}`);
});

test("production keeps the city's queue unless exclusive is asked for", () => {
  const body = actionBodies().set_production;
  assert.match(body, /VALUE_REPLACE_AT/);
  assert.match(body, /PARAM_QUEUE_DESTINATION_LOCATION\] = 0/);
  assert.match(body, /mode == 'exclusive'/);
  assert.equal(validateAction("set_production", { cityId: 1, item: "UNIT_SCOUT", mode: "append" }).ok, true);
  assert.match(validateAction("set_production", { cityId: 1, item: "UNIT_SCOUT", mode: "wipe" }).reason, /mode must be string/);
});

test("risky edits copy Firaxis' call shapes", () => {
  const b = actionBodies();
  assert.match(b.declare_war, /CanDeclareWarOn\(other, warType, true\)/);
  assert.match(b.declare_war, /DeclareWarOn\(other, warType, true\)/);
  assert.match(b.unit_command, /PARAM_PROMOTION_TYPE\] = pr\.Index/);
  assert.match(b.spawn_unit, /InitUnitValidAdjacentHex\(pid, P\.unitType, P\.x, P\.y, radius\)/);
  assert.doesNotMatch(b.spawn_unit, /UnitManager\.InitUnit\(/, "no blind fallback that can double-spawn");
  assert.match(b.restore_moves, /RestoreMovementToFormation/);
  assert.match(b.grant_tech, /SetResearchProgress/);
  assert.match(b.make_peace, /experimental ~= true/);
  assert.match(b.unit_operation, /startsWar/);
});

test("a non-unit purchase verifies the specific acquired item, not just unrelated spending", () => {
  // verify_purchase otherwise only checks P.unitsBefore (set for Units);
  // a building/district purchase had no per-item check at all, so an
  // unrelated gold/faith change (upkeep, another purchase, a deal) during
  // the read-back window would confirm a purchase that never happened.
  const b = actionBodies();
  assert.match(
    b.purchase,
    /verifyArgs\.hadBuildingBefore = c:GetBuildings\(\):HasBuilding\(row\.Index\) == true/,
    "A.purchase must snapshot whether the city already had this building, using the same API finish_production/snapshot.lua already use",
  );
  assert.match(
    b.purchase,
    /verifyArgs\.districtsBefore = countCityDistricts\(c, P\.item\)/,
    "A.purchase must snapshot how many of this district type the city already had",
  );
  assert.match(
    b.verify_purchase,
    /P\.hadBuildingBefore[\s\S]*?HasBuilding\(row\.Index\)/,
    "verify_purchase must re-check the specific building, not just the balance",
  );
  assert.match(
    b.verify_purchase,
    /P\.districtsBefore[\s\S]*?countCityDistricts\(c, P\.item\)/,
    "verify_purchase must re-check the specific district count, not just the balance",
  );
  assert.match(
    b.verify_purchase,
    /o\.ok = false\s*\n\s*o\.note = /,
    "an item type with no verified acquisition check (e.g. a Project) must never read unrelated spending as confirmation",
  );
});

test("countCityDistricts mirrors countUnits: counts completed districts of the target type", () => {
  const src = loadLua("actions");
  assert.match(src, /local function countCityDistricts\(c, districtType\)/);
  assert.match(src, /GetDistricts\(\):Members\(\)/);
  assert.match(src, /d:IsComplete\(\)/, "an incomplete (still under construction) district must not count as acquired");
});

// A plain substring/regex match can't tell "this text is present" from "this
// text actually runs and decides the result" - a mutation deleting the
// DELETE branch's own `return o` would still match any regex built from its
// source. There is no Lua interpreter in this suite (only luaparse, a
// parser), so this walks the real AST instead: it confirms control-flow
// facts a regex cannot - branch order, that the branch cannot fall through,
// and that its own condition (not just its body text) depends on a fresh
// lookup.

// A named Identifier anywhere within an expression subtree. Bounded to the
// node shapes this function's logic actually uses.
function refersTo(node, name) {
  if (!node || typeof node !== "object") return false;
  if (node.type === "Identifier") return node.name === name;
  if (node.type === "MemberExpression") return refersTo(node.base, name) || refersTo(node.identifier, name);
  if (node.type === "CallExpression") return refersTo(node.base, name) || (node.arguments || []).some((a) => refersTo(a, name));
  if (node.type === "BinaryExpression" || node.type === "LogicalExpression") return refersTo(node.left, name) || refersTo(node.right, name);
  if (node.type === "UnaryExpression") return refersTo(node.argument, name);
  return false;
}

// actionBodies() captures everything between "(P)" and the next function/
// dispatcher line, which already includes this function's own closing
// "end" (plus whatever trailing comment sits before the next definition) -
// so the wrapper must not add a second one.
function parseFunctionBody(luaFunctionBody) {
  const ast = luaparse.parse(`local function f(P)${luaFunctionBody}`, { luaVersion: "5.1" });
  return ast.body[0].body;
}

test("DELETE verification runs first and uses one coherent player+unit lookup", () => {
  const statements = parseFunctionBody(actionBodies().verify_unit_command);

  // The DELETE branch must be the function's very first statement - not
  // preceded by a generic "local u = uiUnit(P)". That call does its own
  // internal checkPlayer, independently of any checkPlayer called later
  // inside the branch: if the first one fails transiently (IsValid false
  // or throwing) and a second, later checkPlayer call then recovers, a u
  // computed from the FIRST (failed) call would get paired with a pid
  // from the SECOND (recovered) call - reading as "GetUnit ran and found
  // nothing" when GetUnit was never actually called with a valid pid.
  const firstIf = statements[0];
  assert.equal(firstIf?.type, "IfStatement", "the DELETE check must be the function's first statement, before any generic lookup whose pid/unit could be reused incoherently");

  const cond = firstIf.clauses[0].condition;
  // luaparse 0.3.x leaves StringLiteral.value null; .raw keeps the quotes.
  const isDelete = (n) => n.type === "StringLiteral" && n.raw === "'UNITCOMMAND_DELETE'";
  const isCommandMember = (n) => n.type === "MemberExpression" && n.identifier?.name === "command";
  const isDeleteCheck =
    cond.type === "BinaryExpression" &&
    cond.operator === "==" &&
    ((isCommandMember(cond.left) && isDelete(cond.right)) || (isCommandMember(cond.right) && isDelete(cond.left)));
  assert.ok(isDeleteCheck, "the first statement's condition must be the DELETE check, so no other metadata (promotionIndex, UPGRADE) can run first and substitute for it");

  const branchBody = firstIf.clauses[0].body;
  assert.equal(branchBody.at(-1)?.type, "ReturnStatement", "the DELETE branch must end in a return - it must never fall through to a later branch");

  const pidDecl = branchBody.find((s) => s.type === "LocalStatement" && s.variables.some((v) => v.name === "pid"));
  assert.ok(pidDecl, "the branch must declare its own pid");
  assert.ok(
    pidDecl.init.some((e) => e.type === "CallExpression" && e.base?.type === "Identifier" && e.base.name === "checkPlayer"),
    "pid must come from checkPlayer(P)",
  );

  const uDecl = branchBody.find((s) => s.type === "LocalStatement" && s.variables.some((v) => v.name === "u"));
  assert.ok(uDecl, "the branch must declare its own u, looked up from the SAME pid it just checked - never reuse a u computed outside this branch by a separate, independently-fallible checkPlayer call");
  const uInit = uDecl.init[0];
  assert.equal(uInit?.type, "LogicalExpression", "u must be gated on pid (pid and UnitManager.GetUnit(pid, ...)), not computed unconditionally");
  assert.equal(uInit.operator, "and");
  assert.ok(refersTo(uInit.left, "pid"), "u's gate must be the SAME pid just declared");
  const getUnitCall = uInit.right;
  assert.equal(getUnitCall?.type, "CallExpression");
  assert.ok(refersTo(getUnitCall.base, "GetUnit"), "u must come from a GetUnit lookup");
  assert.ok(
    getUnitCall.arguments?.some((a) => a.type === "Identifier" && a.name === "pid"),
    "GetUnit must be called with the SAME pid just checked - a coherent single lookup, not pid and u from two different checkPlayer calls",
  );

  const okAssign = branchBody.find((s) => s.type === "AssignmentStatement" && s.variables.some((v) => v.type === "MemberExpression" && v.identifier?.name === "ok"));
  assert.ok(okAssign, "the branch must assign o.ok");
  assert.ok(refersTo(okAssign.init[0], "pid"), "o.ok must depend on pid");
  assert.ok(refersTo(okAssign.init[0], "u"), "o.ok must depend on u, the result of that same coherent lookup - not only on pid");
});

test("verify gets the action's verifyArgs; they are not shown to the caller", async () => {
  const seen = [];
  const fake = await startFakeTuner((ctx) => {
    const action = /action="([a-z_]+)"/.exec(ctx.lua)?.[1];
    seen.push(ctx.lua);
    if (action === "end_turn") ctx.emitJson({ ok: true, requested: true, turn: 271, verifyArgs: { turn: 271 } });
    else ctx.emitJson({ ok: true, turnNow: 272 });
  });
  const game = new Game({ port: fake.port, trace: false });
  const r = await performAction(game, "end_turn", {}, { verifyDelayMs: 1 });
  assert.equal(r.ok, true);
  assert.equal(r.verifyArgs, undefined);
  assert.match(seen.at(-1), /turn=271/);
  game.tuner.close();
  await fake.close();
});

test("a dead connection during read-back stops the retries", async () => {
  let calls = 0;
  const fake = await startFakeTuner((ctx) => {
    calls++;
    if (calls === 1) {
      ctx.emitJson({ ok: true, requested: true, verifyArgs: { mode: "front" } });
      return;
    }
    fake.dropAll();
    return "no-end";
  });
  const game = new Game({ port: fake.port, trace: false });
  const r = await performAction(game, "set_civic", { civic: "CIVIC_HUMANISM" });
  assert.equal(r.ok, false);
  assert.equal(r.verified.transportError, true);
  assert.equal(r.verified.attempts, 1, "no further calls on a dead link");
  game.tuner.close();
  await fake.close();
});

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import luaparse from "luaparse";
import { performAction, validateAction } from "../lib/actions.mjs";
import { loadLua } from "../lib/game.mjs";

// Execute the real plot lookup and a real edit's AST against in-memory APIs.
// This small evaluator supports only the expressions/statements these functions
// use; unsupported syntax throws instead of silently giving a guessed result.
// Values preserve Lua's multiple returns and truthiness (including 0 being true).
const source = loadLua("actions");
const ast = luaparse.parse(source, { luaVersion: "5.1", encodingMode: "x-user-defined" });
const multi = Symbol("Lua returns");
const returns = (...values) => ({ [multi]: values });
const first = (v) => v?.[multi] ? v[multi][0] : v;
const truthy = (v) => ![undefined, null, false].includes(first(v));
const luaType = (v) => v == null ? "nil" : typeof v === "object" ? "table" : typeof v;
const equal = (a, b) => a == null && b == null || a === b;

function values(nodes, scope) {
  const out = nodes.map((n) => evaluate(n, scope));
  return out.flatMap((v, i) => i === out.length - 1 && v?.[multi] ? v[multi] : [first(v)]);
}

function evaluate(n, scope) {
  switch (n.type) {
    case "Identifier": return scope[n.name];
    case "NilLiteral": return undefined;
    case "BooleanLiteral":
    case "NumericLiteral":
    case "StringLiteral": return n.value;
    case "MemberExpression": return first(evaluate(n.base, scope))[n.identifier.name];
    case "IndexExpression": return first(evaluate(n.base, scope))[first(evaluate(n.index, scope))];
    case "UnaryExpression": {
      const v = first(evaluate(n.argument, scope));
      if (n.operator === "not") return !truthy(v);
      if (n.operator === "-") return -v;
      break;
    }
    case "LogicalExpression": {
      const left = first(evaluate(n.left, scope));
      if (n.operator === "and") return truthy(left) ? first(evaluate(n.right, scope)) : left;
      if (n.operator === "or") return truthy(left) ? left : first(evaluate(n.right, scope));
      break;
    }
    case "BinaryExpression": {
      const a = first(evaluate(n.left, scope)), b = first(evaluate(n.right, scope));
      if (n.operator === "==") return equal(a, b);
      if (n.operator === "~=") return !equal(a, b);
      if (n.operator === "..") return String(a) + String(b);
      if (typeof a !== typeof b || !["number", "string"].includes(typeof a)) {
        throw new Error("Lua comparison requires two numbers or two strings");
      }
      if (n.operator === "<") return a < b;
      if (n.operator === ">") return a > b;
      if (n.operator === "<=") return a <= b;
      if (n.operator === ">=") return a >= b;
      break;
    }
    case "TableConstructorExpression": {
      const out = {};
      for (const f of n.fields) {
        assert.equal(f.type, "TableKeyString");
        const v = first(evaluate(f.value, scope));
        if (v != null) out[f.key.name] = v;
      }
      return out;
    }
    case "CallExpression": {
      const args = values(n.arguments, scope);
      if (n.base.type === "MemberExpression" && n.base.indexer === ":") {
        const receiver = first(evaluate(n.base.base, scope));
        return receiver[n.base.identifier.name](...args);
      }
      return first(evaluate(n.base, scope))(...args);
    }
  }
  throw new Error(`unsupported expression ${n.type} ${n.operator || ""}`);
}

function assign(target, value, scope) {
  if (target.type === "Identifier") scope[target.name] = value;
  else if (target.type === "MemberExpression") first(evaluate(target.base, scope))[target.identifier.name] = value;
  else throw new Error(`unsupported assignment ${target.type}`);
}

function execute(body, scope) {
  for (const n of body) {
    switch (n.type) {
      case "LocalStatement":
      case "AssignmentStatement": {
        const v = values(n.init, scope);
        n.variables.forEach((target, i) => assign(target, v[i], scope));
        break;
      }
      case "IfStatement": {
        for (const clause of n.clauses) {
          if (!clause.condition || truthy(evaluate(clause.condition, scope))) {
            const result = execute(clause.body, scope);
            if (result) return result;
            break;
          }
        }
        break;
      }
      case "CallStatement": evaluate(n.expression, scope); break;
      case "ReturnStatement": return returns(...values(n.arguments, scope));
      default: throw new Error(`unsupported statement ${n.type}`);
    }
  }
}

function harness({ grid = [80, 52], gridError = false, missingGetter = false, missingPlot = false } = {}) {
  const calls = { grid: 0, plot: [], edits: [] };
  let terrain = 0;
  const plot = { GetTerrainType: () => terrain };
  const globals = {
    type: luaType, tostring: String, math: { floor: Math.floor, huge: Infinity },
    pcall: (fn, ...args) => {
      try {
        const v = fn(...args);
        return returns(true, ...(v?.[multi] || [v]));
      } catch (error) { return returns(false, error.message); }
    },
    Map: {
      GetPlot: (x, y) => { calls.plot.push([x, y]); return missingPlot ? undefined : plot; },
    },
    GameInfo: { Terrains: {
      0: { TerrainType: "TERRAIN_PLAINS", Water: false },
      1: { TerrainType: "TERRAIN_GRASS", Water: false },
      TERRAIN_GRASS: { Index: 1, TerrainType: "TERRAIN_GRASS", Water: false },
    } },
    TerrainBuilder: { SetTerrainType: (p, index) => { calls.edits.push([p, index]); terrain = index; } },
  };
  if (!missingGetter) globals.Map.GetGridSize = () => {
    calls.grid++;
    if (gridError) throw new Error("map unavailable");
    return returns(...grid);
  };
  const funcs = {};
  for (const fn of ast.body.filter((n) => n.type === "FunctionDeclaration")) {
    const name = fn.identifier.type === "Identifier" ? fn.identifier.name : `A.${fn.identifier.identifier.name}`;
    funcs[name] = (...args) => {
      const scope = Object.assign(Object.create(globals), funcs);
      fn.parameters.forEach((p, i) => { scope[p.name] = args[i]; });
      return execute(fn.body, scope) || returns();
    };
  }
  return {
    calls, plot,
    lookup: (P) => funcs.plotAt(P)[multi],
    game: { exec: async (state, code, { params }) => {
      assert.equal(state, "GameCore_Tuner");
      assert.equal(code, source);
      return ["J" + JSON.stringify(first(funcs[`A.${params.action}`](params)))];
    } },
  };
}

test("off-map typed edit coordinates stop before the native lookup or edit", async () => {
  for (const [x, y] of [[-1, 0], [0, -1], [80, 0], [0, 52], [2147483647, 0], [0, 2147483647]]) {
    const h = harness();
    const args = { x, y, terrain: "TERRAIN_GRASS" };
    assert.equal(validateAction("set_terrain", args).ok, true, "bounds depend on the live map, not this static schema");
    const result = await performAction(h.game, "set_terrain", args);
    assert.equal(result.ok, false, JSON.stringify(args));
    assert.deepEqual(h.calls.plot, [], "invalid coordinates must never enter Map.GetPlot");
    assert.deepEqual(h.calls.edits, [], "refused destinations must never be edited");
  }
});

test("plotAt refuses non-finite, fractional and nonnumeric coordinates", () => {
  for (const bad of [0.5, NaN, Infinity, -Infinity, "0", false, undefined, null]) {
    for (const P of [{ x: bad, y: 0 }, { x: 0, y: bad }]) {
      const h = harness();
      const [plot, error] = h.lookup(P);
      assert.equal(plot, undefined);
      assert.equal(error.ok, false);
      assert.deepEqual(h.calls.plot, []);
    }
  }
});

test("unknown, malformed or failed map dimensions cannot authorize a lookup", () => {
  const invalid = [[undefined, 52], [80], [80, undefined], [null, 52], ["80", 52], [80, false],
    [0, 52], [-1, 52], [80, 0], [80, -1], [80.5, 52], [80, 52.5], [NaN, 52], [80, NaN],
    [Infinity, 52], [80, Infinity], [-Infinity, 52], [80, -Infinity]];
  for (const options of [...invalid.map((grid) => ({ grid })), { gridError: true }, { missingGetter: true }]) {
    const h = harness(options);
    const [plot, error] = h.lookup({ x: 0, y: 0 });
    assert.equal(plot, undefined, JSON.stringify(options));
    assert.equal(error.ok, false);
    assert.deepEqual(h.calls.plot, [], "unknown dimensions must fail before Map.GetPlot");
  }
});

test("valid map corners and a one-tile map preserve the exact edit coordinates", async () => {
  for (const [grid, corners] of [[[80, 52], [[0, 0], [79, 0], [0, 51], [79, 51]]], [[1, 1], [[0, 0]]]]) {
    for (const [x, y] of corners) {
      const h = harness({ grid });
      const result = await performAction(h.game, "set_terrain", { x, y, terrain: "TERRAIN_GRASS" });
      assert.equal(result.ok, true);
      assert.equal(result.before, "TERRAIN_PLAINS");
      assert.equal(result.after, "TERRAIN_GRASS");
      assert.deepEqual(h.calls.plot, [[x, y]]);
      assert.equal(h.calls.edits.length, 1);
      assert.equal(h.calls.edits[0][0], h.plot);
    }
  }
});

test("a valid coordinate with no plot retains the existing clean refusal", async () => {
  const h = harness({ missingPlot: true });
  const result = await performAction(h.game, "set_terrain", { x: 1, y: 1, terrain: "TERRAIN_GRASS" });
  assert.equal(result.ok, false);
  assert.match(result.reason, /no plot at/);
  assert.deepEqual(h.calls.plot, [[1, 1]]);
  assert.deepEqual(h.calls.edits, []);
});

test("both action states expose the established map query APIs", () => {
  for (const state of ["InGame", "GameCore_Tuner"]) {
    const cat = JSON.parse(fs.readFileSync(new URL(`../data/api-catalog/${state}.json`, import.meta.url), "utf8"));
    assert.ok(cat.globals.Map.includes("GetGridSize"), state);
    assert.ok(cat.globals.Map.includes("GetPlot"), state);
  }
});

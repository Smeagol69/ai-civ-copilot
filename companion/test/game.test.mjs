import test from "node:test";
import assert from "node:assert/strict";
import { toLua, decodeLines, buildScript, Game, loadLua } from "../lib/game.mjs";
import { startFakeTuner } from "./fixtures/fake-tuner.mjs";

test("toLua escapes strings and serialises tables", () => {
  assert.equal(toLua('a"b\\c\nd'), '"a\\"b\\\\c\\010d"');
  assert.equal(toLua("Zürich"), '"Zürich"');
  assert.equal(toLua({ x: 1, "bad key": true, list: [1, "two"] }), '{x=1,["bad key"]=true,list={1,"two"}}');
  assert.equal(toLua(null), "nil");
  assert.equal(toLua(NaN), "nil");
});

test("decodeLines joins JSON chunks and keeps plain lines", () => {
  const s = JSON.stringify({ a: "x".repeat(2000) });
  const lines = ["hello"];
  for (let i = 0; i < s.length; i += 900) lines.push("J" + s.slice(i, i + 900));
  const { value, text } = decodeLines(lines);
  assert.equal(value.a.length, 2000);
  assert.deepEqual(text, ["hello"]);
  assert.throws(() => decodeLines(["J{bad"]), /could not parse JSON/);
});

test("scripts get the prelude and params", () => {
  const s = buildScript("emitJson(P)", { cityId: 5 });
  assert.match(s, /local function emitJson/);
  assert.match(s, /local P = \{cityId=5\}/);
  assert.ok(s.trimEnd().endsWith("emitJson(P)"));
});

test("every shipped Lua file stays Lua 5.1 compatible (no goto, //, bit ops)", () => {
  for (const f of ["prelude", "snapshot", "actions", "inspect", "apiscan", "plots"]) {
    const src = loadLua(f).replace(/--[^\n]*/g, "").replace(/'[^'\n]*'|"[^"\n]*"/g, '""');
    assert.doesNotMatch(src, /\bgoto\b/, `${f}: goto`);
    assert.doesNotMatch(src, /[^/]\/\/[^/]/, `${f}: integer division`);
    assert.doesNotMatch(src, /[^~=<>]~[^=]|<<|>>/, `${f}: bit operators`);
  }
});

test("Game.lua decodes structured results through the real tuner protocol", async () => {
  const fake = await startFakeTuner((ctx) => {
    assert.match(ctx.lua, /local P = \{n=3\}/);
    ctx.emit("plain line");
    ctx.emitJson({ turn: 120, list: [1, 2, 3] });
  });
  const game = new Game({ port: fake.port });
  const { value, text } = await game.lua("InGame", "emitJson({})", { params: { n: 3 } });
  assert.deepEqual(value, { turn: 120, list: [1, 2, 3] });
  assert.deepEqual(text, ["plain line"]);
  game.tuner.close();
  await fake.close();
});

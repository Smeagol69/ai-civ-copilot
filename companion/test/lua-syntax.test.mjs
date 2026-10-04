// Every Lua file must parse as Lua 5.1 (Civ VI runs Havok Script, a 5.1
// dialect) in the exact shape the bridge sends it: prelude + params + body,
// all inside the pcall wrapper TunerClient.exec builds.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import luaparse from "luaparse";
import { buildScript, LUA_DIR } from "../lib/game.mjs";

const wrap = (body) => `local __tag = "x" local function emit(s) print(__tag .. tostring(s)) end local __ok, __err = pcall(function() ${body}\nend) print("end")`;
const parse = (src) => luaparse.parse(src, { luaVersion: "5.1" });

for (const f of fs.readdirSync(LUA_DIR).filter((f) => f.endsWith(".lua") && f !== "prelude.lua")) {
  test(`lua/${f} parses as sent to the game`, () => {
    let body = fs.readFileSync(path.join(LUA_DIR, f), "utf8");
    if (f === "inspect.lua") body = `local __target = function() return (_G) end\n${body}`;
    assert.doesNotThrow(() => parse(wrap(buildScript(body, { a: 1, s: 'q"uote' }))));
  });
}

test("mod panel Lua parses", () => {
  const src = fs.readFileSync(new URL("../../mod/AICivCopilot/UI/AICivCopilotPanel.lua", import.meta.url), "utf8");
  assert.doesNotThrow(() => parse(src));
});

test("inline Lua in tools and server parses", async () => {
  for (const file of ["../lib/tools.mjs", "../server.mjs"]) {
    const src = fs.readFileSync(new URL(file, import.meta.url), "utf8");
    const blocks = [...src.matchAll(/const [A-Z_]+_LUA = `([\s\S]*?)`;/g)].map((m) => m[1]);
    assert.ok(blocks.length > 0, `${file}: no inline Lua found`);
    for (const b of blocks) assert.doesNotThrow(() => parse(wrap(buildScript(b, {}))), b.slice(0, 80));
  }
});

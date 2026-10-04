#!/usr/bin/env node
// Command line for the copilot. Talks to the running bridge over HTTP; with
// --direct it talks to the game's tuner socket itself (no bridge needed).
//
//   node cli/civ.mjs status
//   node cli/civ.mjs ask "which city should build a campus?"
//   node cli/civ.mjs lua InGame "emit(Game.GetCurrentGameTurn())"
//   node cli/civ.mjs lua GameCore_Tuner -f probe.lua
//   node cli/civ.mjs action change_gold '{"amount":500}'
//   node cli/civ.mjs tool inspect_api '{"state":"InGame","expression":"UnitManager"}'
//   node cli/civ.mjs states | summary | journal | tools
//   node cli/civ.mjs scan GameCore_Tuner        (saves the API catalog)
//   node cli/civ.mjs inflight [n]               (calls that never finished)

import fs from "node:fs";
import { Game } from "../lib/game.mjs";
import { Memory } from "../lib/memory.mjs";
import { GameFiles } from "../lib/gamefiles.mjs";
import { performAction } from "../lib/actions.mjs";
import { runTool } from "../lib/tools.mjs";
import { suspects } from "../lib/inflight.mjs";

const BASE = `http://127.0.0.1:${process.env.AICIV_PORT || 8737}`;
const argv = process.argv.slice(2);
// --direct talks to the game itself, unless a bridge is running: then the
// call goes through the bridge's single connection, so the game never sees
// more than one client. --no-bridge forces a direct connection.
const noBridge = argv.includes("--no-bridge");
let direct = argv.includes("--direct") || noBridge;
const args = argv.filter((a) => a !== "--direct" && a !== "--no-bridge");
const [cmd, ...rest] = args;

const print = (v) => console.log(typeof v === "string" ? v : JSON.stringify(v, null, 2));

async function http(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
  return json;
}

function readCode(parts) {
  if (parts[0] === "-f") return fs.readFileSync(parts[1], "utf8");
  return parts.join(" ");
}

// Connects lazily: tools that only read local data (search_api, abilities,
// game scripts) work with the game closed.
async function bridgeRunning() {
  try {
    const res = await fetch(`${BASE}/status`, { signal: AbortSignal.timeout(400) });
    return res.ok;
  } catch {
    return false;
  }
}

async function directCtx() {
  const game = new Game({ host: process.env.CIV6_TUNER_HOST, port: Number(process.env.CIV6_TUNER_PORT || 4318) });
  const memory = new Memory();
  let snap = null;
  return {
    game,
    memory,
    files: new GameFiles(),
    markStale() { snap = null; },
    async snapshot() { return (snap ??= await game.snapshot()); },
  };
}

async function main() {
  if (direct && !noBridge && cmd !== "inflight" && (await bridgeRunning())) {
    console.error("(a bridge is running - routing through it)");
    direct = false;
  }
  switch (cmd) {
    case "inflight":
      // Calls that never settled, were lost, or timed out with an unknown
      // outcome - after a crash, the suspects.
      return print(suspects(undefined, { limit: Number(rest[0] || 10) }));
    case "status":
      return print(await http("GET", "/status"));
    case "summary":
      return print(await http("GET", "/summary"));
    case "journal":
      return print(await http("GET", "/journal"));
    case "tools":
      return print((await http("GET", "/tools")).map((t) => t.name).join("\n"));
    case "ask": {
      const r = await http("POST", "/ask", { question: rest.join(" "), source: "cli" });
      print(r.answer);
      return console.error(`\n[${r.usage?.toolCalls ?? 0} tool calls, ${r.usage?.input ?? 0} in / ${r.usage?.output ?? 0} out tokens]`);
    }
    case "states": {
      if (direct) {
        const ctx = await directCtx();
        print(await ctx.game.states());
        return ctx.game.tuner.close();
      }
      return print(await http("GET", "/states"));
    }
    case "lua": {
      const [state, ...code] = rest;
      if (direct) {
        const ctx = await directCtx();
        const r = await ctx.game.lua(state, readCode(code));
        print(r.value !== undefined ? r.value : r.text.join("\n"));
        return ctx.game.tuner.close();
      }
      const r = await http("POST", "/lua", { state, code: readCode(code) });
      return print(r.value !== undefined ? r.value : r.text.join("\n"));
    }
    case "action": {
      const [name, json] = rest;
      if (direct) {
        const ctx = await directCtx();
        print(await performAction(ctx.game, name, json ? JSON.parse(json) : {}, { journal: ctx.memory }));
        return ctx.game.tuner.close();
      }
      return print(await http("POST", "/action", { action: name, args: json ? JSON.parse(json) : {} }));
    }
    case "tool": {
      const [name, json] = rest;
      if (direct) {
        const ctx = await directCtx();
        const r = await runTool(ctx, name, json ? JSON.parse(json) : {});
        print(r.content);
        return ctx.game.tuner.close();
      }
      const r = await http("POST", "/tool", { name, input: json ? JSON.parse(json) : {} });
      return print(r.content);
    }
    case "scan": {
      const [state] = rest;
      if (direct) {
        const ctx = await directCtx();
        print((await runTool(ctx, "scan_api", { state })).content);
        return ctx.game.tuner.close();
      }
      return print((await http("POST", "/tool", { name: "scan_api", input: { state } })).content);
    }
    default:
      console.log("usage: civ.mjs <status|summary|journal|tools|ask|states|lua|action|tool|scan|inflight> [...] [--direct]");
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});

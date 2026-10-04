import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ask, systemPrompt } from "../lib/agent.mjs";
import { Memory } from "../lib/memory.mjs";
import { SNAP } from "./fixtures/snapshot.mjs";

// Scripted stand-in for the SDK client: returns queued messages in order and
// records every request.
function scriptedClient(responses) {
  const requests = [];
  const stream = (params) => {
    requests.push(params);
    const msg = responses.shift();
    return { finalMessage: async () => msg };
  };
  return { requests, messages: { stream }, beta: { messages: { stream } } };
}

const usage = { input_tokens: 10, output_tokens: 5 };

function ctxWith(memory, calls) {
  return {
    memory,
    files: {},
    game: { lua: async (state, code) => (calls.push({ state, code }), { value: { ok: true, after: 9000 }, text: [] }) },
    markStale() {},
    async snapshot() { return SNAP; },
  };
}

test("tool loop runs tools, feeds results back, and returns the final text", async () => {
  const memory = new Memory(fs.mkdtempSync(path.join(os.tmpdir(), "aiciv-")));
  const calls = [];
  const client = scriptedClient([
    { stop_reason: "tool_use", usage, content: [
      { type: "text", text: "Checking." },
      { type: "tool_use", id: "t1", name: "production_overview", input: {} },
      { type: "tool_use", id: "t2", name: "run_lua", input: { state: "GameCore_Tuner", code: "emitJson({ok=true})" } },
    ] },
    { stop_reason: "end_turn", usage, content: [{ type: "text", text: "Antium is idle." }] },
  ]);
  const res = await ask({ client, question: "anything idle?", ctx: ctxWith(memory, calls) });
  assert.equal(res.answer, "Antium is idle.");
  assert.equal(res.usage.toolCalls, 2);
  assert.equal(calls[0].state, "GameCore_Tuner");

  const second = client.requests[1];
  const results = second.messages.at(-1).content;
  assert.equal(results.length, 2, "both tool results go back in one user message");
  assert.deepEqual(results.map((r) => r.tool_use_id), ["t1", "t2"]);
  assert.match(results[0].content, /Antium/);

  const first = client.requests[0];
  assert.equal(first.model, "claude-fable-5-1");
  assert.ok(!("thinking" in first), "Fable: thinking is always on; the param is omitted");
  assert.match(JSON.stringify(first.messages[0].content), /lean view/);
  assert.ok(first.tools.every((t) => t.eager_input_streaming === true));
});

test("refusal stops the loop without running tools", async () => {
  const memory = new Memory(fs.mkdtempSync(path.join(os.tmpdir(), "aiciv-")));
  const calls = [];
  const client = scriptedClient([
    { stop_reason: "refusal", usage, content: [{ type: "tool_use", id: "t1", name: "run_lua", input: { state: "InGame", code: "x" } }] },
  ]);
  const res = await ask({ client, question: "q", ctx: ctxWith(memory, calls) });
  assert.equal(res.stop, "refusal");
  assert.equal(calls.length, 0);
});

test("system prompt carries saved abilities and learned facts", () => {
  const memory = new Memory(fs.mkdtempSync(path.join(os.tmpdir(), "aiciv-")));
  memory.saveAbility({ name: "list_wonders", description: "Every wonder built anywhere and by whom.", state: "GameCore_Tuner", lua: "emit(1)" });
  memory.remember("UnitManager.InitUnit takes a type string, not an index");
  const p = systemPrompt(memory);
  assert.match(p, /list_wonders \[query, GameCore_Tuner\]/);
  assert.match(p, /InitUnit takes a type string/);
  assert.match(p, /grow your own abilities/);
});

// The digger and the strategy layer.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as dig from "../lib/discovery.mjs";
import { analyzeStanding, formatStanding, History } from "../lib/strategy.mjs";
import { Memory } from "../lib/memory.mjs";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "aiciv-"));

// A tiny fake game install: one UI script and one Firaxis tuner panel.
function fakeFiles() {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, "Base", "Assets", "UI"), { recursive: true });
  fs.mkdirSync(path.join(dir, "Debug"), { recursive: true });
  fs.writeFileSync(path.join(dir, "Base", "Assets", "UI", "Panel.lua"), [
    "local n = pCity:GetPopulation()",
    "local y = plot:GetYield(0)",
    "local t = pTreasury:GetGoldBalance()",
    "local g = ResourceGenerator.Create(args)",
  ].join("\n"));
  fs.writeFileSync(path.join(dir, "Debug", "City.ltp"), "pCity:ChangeLoyalty(10);\npCityBuildQueue:AddProgress(20);\n");
  const files = { gameDir: dir, list: () => [path.join(dir, "Base", "Assets", "UI", "Panel.lua"), path.join(dir, "Debug", "City.ltp")], lines: (f) => fs.readFileSync(f, "utf8").split("\n") };
  return files;
}

function fakeMemory() {
  const m = new Memory(tmp());
  m.saveCatalog("GameCore_Tuner", {
    globals: {},
    objects: {
      City: ["GetPopulation", "ChangeLoyalty", "SetName"],
      "City:GetBuildQueue": ["AddProgress", "GetSize"],
      Plot: ["GetYield"],
      "Player:GetTreasury": ["GetGoldBalance"],
      "Player:GetUnits": ["Create"],
    },
  });
  return m;
}

test("the mapper classifies, scores and finds evidence on the right kind of object", () => {
  const memory = fakeMemory();
  const dmap = memory.discovery;
  const run = dig.mapApi(memory, fakeFiles(), dmap);
  assert.equal(run.total, 8);
  const loyalty = dmap.get("GameCore_Tuner", "City", "ChangeLoyalty");
  assert.equal(loyalty.kind, "write");
  assert.deepEqual(loyalty.evidence.contexts, ["tuner"], "found in Firaxis' cheat panel");
  const create = dmap.get("GameCore_Tuner", "Player:GetUnits", "Create");
  assert.equal(create.evidence, null, "ResourceGenerator.Create is not evidence for Player:GetUnits:Create");
  assert.ok(create.nameOnlyEvidence.length);
  const top = dig.frontier(dmap, { limit: 3 });
  assert.equal(top[0].method, "ChangeLoyalty", "cheat-panel writes on core objects rank first");
  assert.ok(top.every((e) => e.sites.length));
});

test("only zero-argument getters with same-object zero-argument evidence are probed", () => {
  const memory = fakeMemory();
  dig.mapApi(memory, fakeFiles(), memory.discovery);
  const keys = dig.probeCandidates(memory.discovery, { limit: 50 }).map((e) => `${e.holder}:${e.method}`);
  assert.ok(keys.includes("City:GetPopulation"));
  assert.ok(!keys.includes("Plot:GetYield"), "GetYield is called with an argument");
  assert.ok(!keys.includes("City:ChangeLoyalty"), "never a write");
  assert.ok(keys.includes("Player:GetTreasury:GetGoldBalance"), "pTreasury:GetGoldBalance() is zero-argument evidence on a treasury");
});

// A single shipped script with exactly the given lines, for testing
// indexCallSites' per-line regex directly without the shared fakeFiles()
// fixture (which several other tests assert an exact method count against).
function filesWith(lines) {
  const dir = tmp();
  const sub = path.join("Base", "Assets", "UI");
  fs.mkdirSync(path.join(dir, sub), { recursive: true });
  const file = path.join(dir, sub, "Script.lua");
  fs.writeFileSync(file, lines.join("\n"));
  return { gameDir: dir, list: () => [file], lines: (f) => fs.readFileSync(f, "utf8").split("\n") };
}

test("a multiline call with its argument on a later line is not inferred as zero-argument", () => {
  // The regex matches per line; a call whose "(" opens at end of line has
  // nothing after it on that line, so the captured argument text is empty
  // even though the real call takes YieldTypes.YIELD_FOOD on the next line.
  const files = filesWith(["local y = plot:GetYield(", "    YieldTypes.YIELD_FOOD", ")"]);
  const e = dig.indexCallSites(files).get("GetYield");
  assert.ok(e, "the call is still recorded as evidence");
  assert.equal(e.zeroArg, false, "a multiline call with an argument must not be inferred as zero-argument");
});

test("an incomplete call at end of file is not inferred as zero-argument either", () => {
  const files = filesWith(["local y = plot:GetYield("]);
  const e = dig.indexCallSites(files).get("GetYield");
  assert.ok(e, "the call is still recorded as evidence");
  assert.equal(e.zeroArg, false, "a truncated call must not be inferred as zero-argument");
});

test("a genuine same-line zero-argument call is still correctly inferred", () => {
  const files = filesWith(["local n = pCity:GetPopulation()"]);
  const e = dig.indexCallSites(files).get("GetPopulation");
  assert.ok(e.zeroArg, "a real zero-argument call on one line is still detected");
  assert.ok(e.zeroArgVars.has("pCity"));
});

test("a multiline call does not make the probe-safety gate wrongly treat the function as zero-argument", () => {
  // This is the actual safety consequence: probeBatch only calls a getter
  // live with zero arguments when the shipped usage looks zero-argument.
  // A wrongly-inferred one would call a function that needs an argument
  // with none - exactly what the crash-safe gate exists to prevent.
  const memory = fakeMemory();
  const files = filesWith(["local y = plot:GetYield(", "    YieldTypes.YIELD_FOOD", ")"]);
  dig.mapApi(memory, files, memory.discovery);
  const keys = dig.probeCandidates(memory.discovery, { limit: 50 }).map((e) => `${e.holder}:${e.method}`);
  assert.ok(!keys.includes("Plot:GetYield"), "a multiline call must not make GetYield look like a safe zero-argument getter");
});

test("a trailing comment mentioning a zero-argument call does not taint the real call on that line", () => {
  // The real call takes an argument; the trailing comment merely explains
  // it and is never executed, but the old per-line regex scanned the raw
  // line text and matched the comment's call-shaped text too.
  const files = filesWith(["local y = plot:GetYield(0) -- plot:GetYield()"]);
  const e = dig.indexCallSites(files).get("GetYield");
  assert.ok(e, "the real call is still recorded as evidence");
  assert.equal(e.zeroArg, false, "a trailing comment's call-shaped text must not be inferred as a real zero-argument call");
});

test("a quoted string literal containing call-shaped text is not mistaken for a real call", () => {
  const files = filesWith(['local s = "plot:GetYield()"']);
  const e = dig.indexCallSites(files).get("GetYield");
  assert.equal(e, undefined, "text inside a string literal is never executed code");
});

test("a multi-line block comment containing call-shaped text is not mistaken for a real call", () => {
  const files = filesWith(["--[[", "plot:GetYield()", "]]"]);
  const e = dig.indexCallSites(files).get("GetYield");
  assert.equal(e, undefined, "text inside a --[[ ... ]] block comment is never executed code");
});

test("a call whose only argument is a string literal is still correctly seen as having an argument", () => {
  // Guards the fix itself: stripping a string literal's contents must not
  // collapse ChangeName("Rome") into looking like ChangeName() either.
  const files = filesWith(['local ok = pCity:ChangeName("Rome")']);
  const e = dig.indexCallSites(files).get("ChangeName");
  assert.ok(e, "the call is still recorded as evidence");
  assert.equal(e.zeroArg, false, "a string-literal argument is still an argument");
});

test("inert text does not make the probe-safety gate wrongly treat the function as zero-argument", () => {
  const memory = fakeMemory();
  const files = filesWith(["local y = plot:GetYield(0) -- plot:GetYield()"]);
  dig.mapApi(memory, files, memory.discovery);
  const keys = dig.probeCandidates(memory.discovery, { limit: 50 }).map((e) => `${e.holder}:${e.method}`);
  assert.ok(!keys.includes("Plot:GetYield"), "a trailing comment must not make GetYield look like a safe zero-argument getter");
});

test("a --[=[ ]=] long comment is not confused with a plain --[[ ]] one, even when it contains comment-shaped text", () => {
  // Only --[[ ]] (level 0) was recognized before. A --[=[ ]=] (level 1)
  // comment was instead treated as an ordinary single-line "--" comment
  // that ends at end of line, so the real content on the next line was
  // scanned as code - including the nested "--[[ text ]]", which the
  // level-0 handling then stripped on its own, leaving "plot:GetYield( )"
  // behind: inert text manufacturing a fake zero-argument call.
  const files = filesWith(["local y = plot:GetYield(0)", "--[=[", "plot:GetYield(--[[ text ]] )", "]=]"]);
  const e = dig.indexCallSites(files).get("GetYield");
  assert.ok(e, "the one real call is still recorded as evidence");
  assert.equal(e.count, 1, "only the real call on line 1 is evidence; nothing from inside the --[=[ ]=] comment");
  assert.equal(e.zeroArg, false, "the real call takes an argument; the comment's inert text must not override that");
});

test("a [=[ ]=] long string literal containing comment-shaped text is not mistaken for a real call", () => {
  const files = filesWith(["local s = [=[plot:GetYield(--[[ text ]] )]=]"]);
  const e = dig.indexCallSites(files).get("GetYield");
  assert.equal(e, undefined, "the entire line is a string literal; there is no real call anywhere in it");
});

test("a block comment that closes on a line longer than 400 characters still closes", () => {
  // indexCallSites skips long lines entirely rather than scanning them for
  // call evidence, but it must still run them through the lexer so a
  // genuine close on that line is not lost - otherwise every real call
  // after it is wrongly treated as still being inside the comment forever.
  const files = filesWith(["--[[", "x".repeat(401) + "]]", "local y = plot:GetYield()"]);
  const e = dig.indexCallSites(files).get("GetYield");
  assert.ok(e, "the real call after the comment closes is recorded");
  assert.ok(e.zeroArg, "it is a genuine zero-argument call once the comment correctly closes");
});

test("a short string continued across lines with a backslash does not leak its content as a real call", () => {
  const files = filesWith(['local s = "abc\\', 'plot:GetYield() -- still inside the string from line 1"']);
  const e = dig.indexCallSites(files).get("GetYield");
  assert.equal(e, undefined, "line 2 is still inside the string opened on line 1; nothing there is real code");
});

test("a resumed short string is not ended early by an escaped quote", () => {
  // The resumed-string scan used a plain indexOf for the closing quote,
  // with no concept of escaping. \" inside the string is a literal quote
  // character, not the terminator - the real close is the final " at the
  // end of line 3. Only line 1's call is real; the rest is string content.
  const files = filesWith(["local y = plot:GetYield(0)", 'local s = "\\', '\\" plot:GetYield()"']);
  const e = dig.indexCallSites(files).get("GetYield");
  assert.ok(e, "the real call on line 1 is still recorded as evidence");
  assert.equal(e.count, 1, "only the real call on line 1 is evidence; the escaped quote does not end the string early");
  assert.equal(e.zeroArg, false, "the real call takes an argument; inert text after the escaped quote must not override that");
});

test("the same escaped-quote-on-resume case reproduces with single quotes too", () => {
  const files = filesWith(["local y = plot:GetYield(0)", "local s = '\\", "\\' plot:GetYield()'"]);
  const e = dig.indexCallSites(files).get("GetYield");
  assert.ok(e);
  assert.equal(e.count, 1);
  assert.equal(e.zeroArg, false);
});

test("a resumed short string still closes correctly, and real code after the close on that line is scanned", () => {
  // Guards the fix itself: an escape-aware resume must still find a real,
  // unescaped closing quote and keep scanning what follows as real code.
  const files = filesWith(['local s = "abc\\', 'def" local y = plot:GetYield()']);
  const e = dig.indexCallSites(files).get("GetYield");
  assert.ok(e, "the real call after the string closes is recorded");
  assert.ok(e.zeroArg, "it is a genuine zero-argument call");
});

test("an escaped quote on a resumed string does not make the probe-safety gate wrongly treat the function as zero-argument", () => {
  const memory = fakeMemory();
  const files = filesWith(["local y = plot:GetYield(0)", 'local s = "\\', '\\" plot:GetYield()"']);
  dig.mapApi(memory, files, memory.discovery);
  const keys = dig.probeCandidates(memory.discovery, { limit: 50 }).map((e) => `${e.holder}:${e.method}`);
  assert.ok(!keys.includes("Plot:GetYield"), "an escaped quote must not make GetYield look like a safe zero-argument getter");
});

test("dig status only moves forward, blocked is recorded, and notes accumulate", () => {
  const memory = fakeMemory();
  const dmap = memory.discovery;
  dig.mapApi(memory, fakeFiles(), dmap);
  dmap.update("GameCore_Tuner", "City", "ChangeLoyalty", { status: "ability", note: "saved as city_loyalty" });
  dmap.update("GameCore_Tuner", "City", "ChangeLoyalty", { status: "evidenced" });
  assert.equal(dmap.get("GameCore_Tuner", "City", "ChangeLoyalty").status, "ability");
  dmap.update("GameCore_Tuner", "City", "SetName", { status: "blocked", note: "needs a localized string" });
  assert.equal(dmap.get("GameCore_Tuner", "City", "SetName").status, "blocked");
  dmap.save();
  const again = new dig.DiscoveryMap(memory.dir);
  assert.equal(again.get("GameCore_Tuner", "City", "ChangeLoyalty").notes.length, 1);
  assert.ok(!dig.frontier(again).some((e) => e.method === "ChangeLoyalty"), "done items leave the frontier");
});

test("remapping and reloading keep blocked functions out of the frontier and probes", () => {
  const memory = fakeMemory();
  const files = fakeFiles();
  dig.mapApi(memory, files, memory.discovery);
  for (const method of ["ChangeLoyalty", "GetPopulation", "SetName"]) {
    memory.discovery.update("GameCore_Tuner", "City", method, { status: "blocked", note: `${method} has an unsafe call shape` });
  }
  memory.discovery.save();
  const dmap = new dig.DiscoveryMap(memory.dir);
  const notes = dmap.get("GameCore_Tuner", "City", "ChangeLoyalty").notes;
  const originalLines = files.lines;
  files.lines = (f) => originalLines(f).map((line) => line.replace("ChangeLoyalty(10)", "ChangeLoyalty(20)"));
  dig.mapApi(memory, files, dmap);
  for (const method of ["ChangeLoyalty", "GetPopulation", "SetName"]) {
    assert.equal(dmap.get("GameCore_Tuner", "City", method).status, "blocked", `${method} must remain blocked with or without evidence`);
  }
  assert.match(dmap.get("GameCore_Tuner", "City", "ChangeLoyalty").evidence.sites[0].code, /ChangeLoyalty\(20\)/, "evidence still refreshes");
  assert.ok(!dig.frontier(dmap).some((e) => e.method === "ChangeLoyalty"));
  assert.ok(!dig.probeCandidates(dmap).some((e) => e.method === "GetPopulation"));
  const again = new dig.DiscoveryMap(memory.dir);
  assert.equal(again.get("GameCore_Tuner", "City", "ChangeLoyalty").status, "blocked");
  assert.equal(again.get("GameCore_Tuner", "City", "GetPopulation").status, "blocked");
  assert.deepEqual(again.get("GameCore_Tuner", "City", "ChangeLoyalty").notes, notes);
});

test("a probe settling after a function was blocked retains the block and the learned result", async () => {
  const memory = fakeMemory();
  dig.mapApi(memory, fakeFiles(), memory.discovery);
  let release;
  const reply = new Promise((resolve) => { release = resolve; });
  const game = { lua: async (_state, _lua, { params }) => {
    assert.ok(params.calls.some((c) => c.key === "City|GetPopulation"), "the getter was selected before it was blocked");
    return reply;
  } };
  const pending = dig.probeBatch(game, memory.discovery);
  memory.discovery.update("GameCore_Tuner", "City", "GetPopulation", { status: "blocked", note: "the native call is unsafe" });
  release({ value: [{ key: "City|GetPopulation", type: "number", value: 3 }] });
  await pending;
  const again = new dig.DiscoveryMap(memory.dir);
  const entry = again.get("GameCore_Tuner", "City", "GetPopulation");
  assert.equal(entry.status, "blocked", "an in-flight read must not reopen a blocked function");
  assert.equal(entry.probe.value, 3, "the completed read is still learned");
  assert.match(entry.notes[0], /the native call is unsafe/);
  assert.ok(!dig.probeCandidates(again).some((e) => e.method === "GetPopulation"));
});

test("onProgress blocking a selected getter before its chunk is sent removes it from that dispatch", async () => {
  // cands is computed once up front and sliced into chunks; onProgress
  // fires synchronously right before each chunk's dispatch. If it blocks
  // a candidate at that point, the stale chunk must not still send it.
  const memory = fakeMemory();
  dig.mapApi(memory, fakeFiles(), memory.discovery);
  const game = { lua: async (_state, _lua, { params }) => {
    assert.ok(!params.calls.some((c) => c.key === "City|GetPopulation"), "GetPopulation was blocked by onProgress before this dispatch; it must not be submitted");
    return { value: params.calls.map((c) => ({ key: c.key, type: "number", value: 1 })) };
  } };
  await dig.probeBatch(game, memory.discovery, {
    onProgress: () => {
      memory.discovery.update("GameCore_Tuner", "City", "GetPopulation", { status: "blocked", note: "blocked mid-batch" });
    },
  });
});

test("onProgress revoking a selected getter's zero-argument evidence before its chunk is sent removes it from that dispatch", async () => {
  const memory = fakeMemory();
  dig.mapApi(memory, fakeFiles(), memory.discovery);
  const game = { lua: async (_state, _lua, { params }) => {
    assert.ok(!params.calls.some((c) => c.key === "City|GetPopulation"), "GetPopulation's zero-arg evidence was revoked by onProgress before this dispatch; it must not be submitted");
    return { value: params.calls.map((c) => ({ key: c.key, type: "number", value: 1 })) };
  } };
  await dig.probeBatch(game, memory.discovery, {
    onProgress: () => {
      const cur = memory.discovery.get("GameCore_Tuner", "City", "GetPopulation");
      memory.discovery.update("GameCore_Tuner", "City", "GetPopulation", { evidence: { ...cur.evidence, zeroArgVars: [] } });
    },
  });
});

test("probeBatch still submits every eligible candidate when onProgress changes nothing", async () => {
  const memory = fakeMemory();
  dig.mapApi(memory, fakeFiles(), memory.discovery);
  const seen = [];
  const game = { lua: async (_state, _lua, { params }) => {
    seen.push(...params.calls.map((c) => c.key));
    return { value: params.calls.map((c) => ({ key: c.key, type: "number", value: 1 })) };
  } };
  let progressCalls = 0;
  await dig.probeBatch(game, memory.discovery, { onProgress: () => { progressCalls++; } });
  assert.ok(progressCalls >= 1, "onProgress is still called");
  assert.ok(seen.includes("City|GetPopulation"), "an untouched eligible candidate is still submitted");
});

test("blocked functions can still be deliberately proven or saved as abilities", () => {
  const memory = fakeMemory();
  const files = fakeFiles();
  const dmap = memory.discovery;
  dig.mapApi(memory, files, dmap);
  for (const [method, status] of [["ChangeLoyalty", "proven"], ["SetName", "ability"]]) {
    dmap.update("GameCore_Tuner", "City", method, { status: "blocked", note: "call shape was unknown" });
    dmap.update("GameCore_Tuner", "City", method, { status, note: "the corrected call shape was verified" });
  }
  dig.mapApi(memory, files, dmap);
  const again = new dig.DiscoveryMap(memory.dir);
  for (const [method, status] of [["ChangeLoyalty", "proven"], ["SetName", "ability"]]) {
    const entry = again.get("GameCore_Tuner", "City", method);
    assert.equal(entry.status, status);
    assert.equal(entry.notes.length, 2, "both the block and later verification stay recorded");
  }
  assert.ok(!dig.frontier(again).some((e) => e.method === "ChangeLoyalty"));
});

const STANDING = {
  turn: 271, me: 0, victories: ["VICTORY_TECHNOLOGY", "VICTORY_CULTURE", "VICTORY_CONQUEST", "VICTORY_SCORE"],
  players: [
    { id: 0, me: true, known: true, civ: "Hungary", score: 176, techs: 13, touristsTo: 2, capitalsHeld: 0, military: 254 },
    { id: 1, known: true, civ: "Georgia", score: 753, techs: 41, touristsTo: 40, capitalsHeld: 1, military: 175 },
    { id: 2, known: true, civ: "China", score: 477, techs: 40, touristsTo: 9, capitalsHeld: 0, military: 300 },
    { id: 9, known: false },
  ],
  gaps: [],
};

test("standing ranks every road and names the strongest road and the biggest threat", () => {
  const a = analyzeStanding(STANDING);
  const sci = a.roads.find((r) => r.victory === "VICTORY_TECHNOLOGY");
  assert.deepEqual([sci.mine, sci.rank, sci.of, sci.leader, sci.share], [13, 3, 3, "Georgia", 32]);
  assert.equal(a.biggestThreat.civ, "Georgia");
  assert.ok(a.bestRoad);
  assert.match(a.note, /^calculated/);
  assert.match(formatStanding(a), /Science: you 13 \(#3 of 3\), leader Georgia 41/);
  assert.ok(!a.roads.some((r) => r.of > 3), "unknown civs are left out");
});

test("history records one row per turn and gives per-turn trends", () => {
  const h = new History(tmp());
  assert.equal(h.record(STANDING), true);
  assert.equal(h.record(STANDING), false, "same turn twice is not recorded");
  h.record({ ...STANDING, turn: 281, players: STANDING.players.map((p) => (p.known ? { ...p, score: p.score + 50, techs: p.techs + 5 } : p)) });
  const t = h.trends();
  assert.equal(t.perTurn.Hungary.score, 5);
  assert.equal(t.perTurn.Georgia.techs, 0.5);
});

test("a road where everyone is at zero reads as 'nobody has any yet'", () => {
  const s = { ...STANDING, players: STANDING.players.map((p) => (p.known ? { ...p, capitalsHeld: 0 } : p)) };
  assert.match(formatStanding(analyzeStanding(s)), /Domination: nobody has any yet/);
});

test("the event log keeps the current game's recent turns and formats them", async () => {
  const { EventLog, formatEvents, formatSituation } = await import("../lib/events.mjs");
  const log = new EventLog(tmp());
  log.add([{ kind: "turn", text: "Turn 271 began.", turn: 271 }, { kind: "research", text: "Researched Banking.", turn: 271 }]);
  // A new game: turn numbers restart, so the old game's events drop out.
  log.add([{ kind: "turn", text: "Turn 1 began.", turn: 1, blocking: "ENDTURN_BLOCKING_UNITS" }, { kind: "notification", text: "Meet Mongolia", turn: 1 }]);
  log.add([{ kind: "war", text: "Mongolia declared war on you!", turn: 2 }, { kind: "notification", text: "Meet Mongolia", turn: 2 }, { kind: "notification", text: "Meet Mongolia", turn: 2 }, { bad: true }]);
  const recent = log.recent({ turns: 2 });
  assert.ok(recent.every((e) => e.turn <= 2), "only the current game");
  const text = formatEvents(recent);
  assert.match(text, /Turn 1:\n- waiting on: units/);
  assert.match(text, /! Mongolia declared war on you!/);
  assert.match(text, /Meet Mongolia \(x2\)/);
  assert.deepEqual(log.recent({ kinds: ["war"] }).map((e) => e.kind), ["war"]);

  const s = formatSituation({
    turn: 40, wars: ["Mongolia"], blocking: "ENDTURN_BLOCKING_PRODUCTION",
    deals: [{ civ: "France", gives: ["peace"], asks: ["100 gold"] }],
    civs: [
      { civ: "England", mood: "DIPLO_STATE_FRIENDLY", moodLevel: 70, military: 90, reasons: [{ score: 6, text: "Trading partners" }] },
      { civ: "Mongolia", mood: "DIPLO_STATE_WAR", moodLevel: 0, atWar: true, military: 300, reasons: [] },
    ],
  });
  assert.match(s, /! At war with: Mongolia/);
  assert.match(s, /! Deal from France: they give peace; they ask 100 gold/);
  assert.match(s, /worst first\):\n- Mongolia: AT WAR/);
  assert.match(s, /England: friendly, military 90 \(\+6 Trading partners\)/);
  assert.match(s, /Before ending the turn: production/);
});

test("history starts a new file when a different game begins", () => {
  const dir = tmp();
  const h = new History(dir);
  h.record(STANDING);
  h.record({ ...STANDING, turn: 1 });
  assert.equal(h.rows().length, 1, "the new game's history starts fresh");
  assert.equal(fs.readdirSync(dir).filter((f) => /^history-\d+\.jsonl$/.test(f)).length, 1, "the old game's history is kept");
});

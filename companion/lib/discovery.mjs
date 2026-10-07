// The digger: maps everything the game exposes, finds what can change the
// game, and keeps a frontier of things to turn into new abilities.
//
// Each function in the live API catalogs becomes an entry in a persistent
// map (data/discovery/map.json) that only ever gains knowledge:
//   status   unknown -> evidenced (a Firaxis script calls it) -> probed
//            (called live, read-only) -> proven (a write tested with revert)
//            -> ability (saved as a tool/button); or blocked (with a reason)
//   kind     read | write | action | other, from the name and evidence
//   evidence up to 3 shipped call sites, with the file and its context
//            (ui, gameplay, tuner = Firaxis' own debug/cheat panels)
//   leverage how much a write here could add as a feature
//
// Stages, cheapest and safest first:
//   mapApi()      offline: one pass over Firaxis' scripts, no game access
//   probeBatch()  live: zero-argument getters only, and only those whose
//                 shipped usage shows zero arguments (the crash-safe gate)
//   frontier()    what the AI should prove next (dig_next tool / Dig button)

import fs from "node:fs";
import path from "node:path";

const WRITE_VERBS = /^(Set|Change|Add|Remove|Grant|Create|Destroy|Kill|Init|Place|Finish|Reset|Unlock|Trigger|Clear|Force|Give|Make|Declare|Transfer|Spawn|Award|Reveal|Restore|Apply|Increment|Decrement|Pillage|Repair)/;
const READ_VERBS = /^(Get|Is|Has|Can|Num|Find|Calculate|Compute|Should|Was|Are|Does|Will)/;
const ACTION_VERBS = /^(Request|Look|Select|Play|Open|Close|Show|Hide|Toggle|Start|Stop)/;
const HOLDER_WEIGHT = {
  Player: 5, City: 5, Unit: 5, Plot: 4, TerrainBuilder: 4, ResourceBuilder: 4, ImprovementBuilder: 4, UnitManager: 4, CityManager: 4,
  Game: 3, PlayerVisibility: 3, Eras: 3, District: 3, Map: 2,
};

export function classify(method) {
  if (WRITE_VERBS.test(method)) return "write";
  if (ACTION_VERBS.test(method)) return "action";
  if (READ_VERBS.test(method)) return "read";
  return "other";
}

function contextOf(rel) {
  const r = rel.replace(/\\/g, "/").toLowerCase();
  if (r.startsWith("debug/") || r.includes("/ui/tuner/")) return "tuner";
  if (r.includes("/scripts/") || r.includes("/gameplay/")) return "gameplay";
  return "ui";
}

// Masking and declaration offsets reuse the verified operator scanner from
// 884dfc78f0c846db57a7be1e4f44eaf1a7c30322. Keep source positions intact:
// comments are whitespace, while strings remain non-whitespace arguments.
// This handles Lua trivia across lines without treating a declaration's
// parameter list as call evidence or hiding names prefixed with "function".
function maskLuaLiterals(source) {
  const code = source.split("");
  const mask = (start, end, char) => {
    for (let i = start; i < end; i++) if (source[i] !== "\n" && source[i] !== "\r") code[i] = char;
  };
  const longEnd = (start) => {
    if (source[start] !== "[") return null;
    let at = start + 1;
    while (source[at] === "=") at++;
    if (source[at] !== "[") return null;
    const close = `]${source.slice(start + 1, at)}]`;
    const end = source.indexOf(close, at + 1);
    return end < 0 ? source.length : end + close.length;
  };
  for (let i = 0; i < source.length;) {
    if (source[i] === "-" && source[i + 1] === "-") {
      const newline = source.indexOf("\n", i + 2);
      const end = longEnd(i + 2) ?? (newline < 0 ? source.length : newline);
      mask(i, end, " ");
      i = end;
    } else if (source[i] === '"' || source[i] === "'") {
      const quote = source[i];
      let end = i + 1;
      while (end < source.length) {
        if (source[end] === "\\") end = Math.min(end + 2, source.length);
        else if (source[end++] === quote) break;
      }
      mask(i, end, "#");
      i = end;
    } else {
      const end = longEnd(i);
      if (end !== null) {
        mask(i, end, "#");
        i = end;
      } else i++;
    }
  }
  return code.join("");
}

// Executable fields in the installed FireTuner PanelData format. Labels,
// attributes, unknown elements and fields in other locations are not scripts.
const PANEL_LUA_PATHS = new Set([
  "PanelData/EnterAction", "PanelData/ExitAction", "PanelData/Actions/ActionData/Action",
  ...["Boolean", "Float", "Integer", "String"].flatMap((type) =>
    ["GetFunction", "SetFunction"].map((field) => `PanelData/${type}Controls/${type}ControlData/${field}`)),
  ...["OnDeselected", "OnSelected", "PopulateList"].map((field) => `PanelData/MultiselectLists/MultiselectListData/${field}`),
  ...["OnSelection", "PopulateList"].map((field) => `PanelData/SelectionLists/SelectionListData/${field}`),
  ...["OnSelection", "PopulateTree"].map((field) => `PanelData/TreeViews/TreeViewData/${field}`),
]);

// Decode XML text once, retaining each character's original source position.
// CDATA is literal; XML line-end normalization also applies inside CDATA.
function panelText(text, start, cdata = false) {
  const chars = [], positions = [];
  const named = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
  for (let i = 0; i < text.length;) {
    const at = i;
    let value = text[i++];
    if (value === "\r") {
      if (text[i] === "\n") i++;
      value = "\n";
    } else if (!cdata && value === "&") {
      const entity = /^&(#x[0-9a-fA-F]+|#[0-9]+|[a-z]+);/.exec(text.slice(at));
      if (!entity) return null;
      value = Object.hasOwn(named, entity[1]) ? named[entity[1]] : undefined;
      if (entity[1].startsWith("#")) {
        const hex = entity[1][1] === "x";
        const point = Number.parseInt(entity[1].slice(hex ? 2 : 1), hex ? 16 : 10);
        if ((point < 0x20 && ![9, 10, 13].includes(point)) || point > 0x10ffff ||
            (point >= 0xd800 && point <= 0xdfff) || point === 0xfffe || point === 0xffff) return null;
        value = String.fromCodePoint(point);
      }
      if (value === undefined) return null;
      i = at + entity[0].length;
    }
    if (/[\x00-\x08\x0b\x0c\x0e-\x1f\ufffe\uffff]/.test(value)) return null;
    for (const char of value.split("")) {
      chars.push(char);
      positions.push(start + at);
    }
  }
  return { text: chars.join(""), positions };
}

// Plain Lua .ltp files remain supported. XML panels are parsed structurally,
// without DTD/entity expansion, before any Lua masking. Each field gets fresh
// lexical state, so a label's apostrophe or a neighboring field cannot hide or
// manufacture calls. Malformed/unsupported XML contributes no evidence.
function luaSources(source, panel) {
  if (!panel || !/^\s*</.test(source)) return [{ text: source }];
  const sources = [], stack = [];
  let field = null, rootSeen = false;
  const append = (text, start, cdata = false) => {
    if (!cdata && text.includes("]]>")) return false;
    const decoded = panelText(text, start, cdata);
    if (!decoded || (!stack.length && !/^[ \t\r\n]*$/.test(text))) return false;
    if (field) {
      field.text += decoded.text;
      field.positions = field.positions.concat(decoded.positions);
    }
    return true;
  };
  for (let at = source[0] === "\ufeff" ? 1 : 0; at < source.length;) {
    if (source[at] !== "<") {
      const end = source.indexOf("<", at);
      const next = end < 0 ? source.length : end;
      if (!append(source.slice(at, next), at)) return [];
      at = next;
    } else if (source.startsWith("<!--", at)) {
      const end = source.indexOf("-->", at + 4);
      if (end < 0 || source.slice(at + 4, end).includes("--") || source[end - 1] === "-") return [];
      at = end + 3;
    } else if (source.startsWith("<?", at)) {
      const end = source.indexOf("?>", at + 2);
      if (end < 0) return [];
      at = end + 2;
    } else if (source.startsWith("<![CDATA[", at)) {
      const end = source.indexOf("]]>", at + 9);
      if (!stack.length || end < 0 || !append(source.slice(at + 9, end), at + 9, true)) return [];
      at = end + 3;
    } else if (source.startsWith("</", at)) {
      const tag = /^<\/([A-Za-z_][A-Za-z0-9_.:-]*)[ \t\r\n]*>/.exec(source.slice(at));
      if (!tag || stack.pop() !== tag[1]) return [];
      if (field && field.depth === stack.length + 1) {
        if (!field.nested) sources.push({ text: field.text, positions: field.positions });
        field = null;
      }
      at += tag[0].length;
    } else {
      const tag = /^<([A-Za-z_][A-Za-z0-9_.:-]*)(?:[ \t\r\n]+[A-Za-z_][A-Za-z0-9_.:-]*[ \t\r\n]*=[ \t\r\n]*(?:"[^"<]*"|'[^'<]*'))*[ \t\r\n]*\/?>/.exec(source.slice(at));
      if (!tag) return []; // includes DTD/ENTITY directives: never expand them
      const attributes = new Set();
      for (const attr of tag[0].matchAll(/[ \t\r\n]+([A-Za-z_][A-Za-z0-9_.:-]*)[ \t\r\n]*=[ \t\r\n]*(["'])(.*?)\2/gs)) {
        if (attributes.has(attr[1]) || !panelText(attr[3], 0) || (attr[1] === "xmlns" && attr[3])) return [];
        attributes.add(attr[1]);
      }
      if (!stack.length) {
        if (rootSeen || tag[1] !== "PanelData") return [];
        rootSeen = true;
      }
      if (field) field.nested = true;
      if (!tag[0].endsWith("/>")) {
        stack.push(tag[1]);
        if (!field && PANEL_LUA_PATHS.has(stack.join("/"))) field = { depth: stack.length, text: "", positions: [], nested: false };
      }
      at += tag[0].length;
    }
  }
  return rootSeen && !stack.length ? sources : [];
}

// One pass over every shipped .lua/.ltp source: method name -> call sites.
export function indexCallSites(files, { perMethod = 24 } = {}) {
  const index = new Map();
  const re = /([A-Za-z_][A-Za-z0-9_]*)[ \t\v\f\r\n]*([:.])[ \t\v\f\r\n]*([A-Z][A-Za-z0-9_]*)[ \t\v\f\r\n]*\(/g;
  // Record the opening-paren offsets of declaration heads, allowing Lua
  // whitespace/comments between every qualifier. Matching by offset avoids
  // confusing a real call inside a function body with the declaration itself.
  const declaration = /\bfunction[ \t\v\f\r\n]+[A-Za-z_][A-Za-z0-9_]*(?:[ \t\v\f\r\n]*[.:][ \t\v\f\r\n]*[A-Za-z_][A-Za-z0-9_]*)*[ \t\v\f\r\n]*\(/g;
  for (const f of files.list()) {
    const lower = f.toLowerCase();
    if (!lower.endsWith(".lua") && !lower.endsWith(".ltp")) continue;
    const rel = path.relative(files.gameDir, f);
    const ctx = contextOf(rel);
    const lines = files.lines ? files.lines(f) : fs.readFileSync(f, "utf8").split(/\r?\n/);
    let i = 0;
    let lineStart = 0;
    for (const script of luaSources(lines.join("\n"), lower.endsWith(".ltp"))) {
      const code = maskLuaLiterals(script.text);
      const declarations = new Set([...code.matchAll(declaration)].map((m) => m.index + m[0].length - 1));
      for (const m of code.matchAll(re)) {
        const sourceAt = script.positions ? script.positions[m.index] : m.index;
        while (lineStart + lines[i].length < sourceAt) lineStart += lines[i++].length + 1;
        const line = lines[i];
        const open = m.index + m[0].length - 1;
        if (line.length > 400 || declarations.has(open)) continue;
        const method = m[3];
        let e = index.get(method);
        if (!e) index.set(method, (e = { count: 0, sites: [], contexts: new Set(), zeroArg: false, zeroArgVars: new Set() }));
        e.count++;
        e.contexts.add(ctx);
        // A closing paren after only Lua trivia confirms an empty argument list,
        // even across lines. An incomplete call or a masked string cannot do so.
        let next = open + 1;
        while (next < code.length && /[ \t\v\f\r\n]/.test(code[next])) next++;
        if (m[2] === ":" && code[next] === ")") {
          e.zeroArg = true;
          if (e.zeroArgVars.size < 40) e.zeroArgVars.add(m[1]);
        }
        // Keep a spread of examples: one per receiver variable and context,
        // so a site on the right kind of object is likely to be among them.
        const site = { v: m[1], file: rel.replace(/\\/g, "/"), line: i + 1, code: line.trim().slice(0, 200), ctx };
        if (e.sites.length < perMethod && !e.sites.some((x) => x.v === site.v && x.ctx === site.ctx)) e.sites.push(site);
      }
    }
  }
  return index;
}

const keyOf = (state, holder, method) => `${state}|${holder}|${method}`;

export class DiscoveryMap {
  constructor(dataDir) {
    this.dir = path.join(dataDir, "discovery");
    this.file = path.join(this.dir, "map.json");
    fs.mkdirSync(this.dir, { recursive: true });
    this.data = fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file, "utf8")) : { entries: {}, runs: [] };
  }

  save() {
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 1));
  }

  get entries() {
    return Object.values(this.data.entries);
  }

  get(state, holder, method) {
    return this.data.entries[keyOf(state, holder, method)];
  }

  // Merge new facts into an entry; status only moves forward.
  update(state, holder, method, patch) {
    const k = keyOf(state, holder, method);
    const order = ["unknown", "evidenced", "probed", "proven", "ability"];
    const cur = this.data.entries[k] || { state, holder, method, status: "unknown", notes: [] };
    const next = { ...cur, ...patch, notes: [...(cur.notes || []), ...(patch.note ? [`${new Date().toISOString().slice(0, 10)} ${patch.note}`] : [])] };
    delete next.note;
    // Mapping and read-only probes add evidence, but cannot clear an explicit
    // block. Keep merging what they learned; a deliberate proven/ability
    // record can still promote the entry after the unsafe call is resolved.
    if (cur.status === "blocked" && ["unknown", "evidenced", "probed"].includes(patch.status)) next.status = cur.status;
    else if (patch.status && cur.status !== "blocked" && patch.status !== "blocked" && order.indexOf(patch.status) < order.indexOf(cur.status)) next.status = cur.status;
    this.data.entries[k] = next;
    return next;
  }

  stats() {
    const by = (f) => this.entries.reduce((a, e) => ((a[f(e)] = (a[f(e)] || 0) + 1), a), {});
    return { total: this.entries.length, byStatus: by((e) => e.status), byKind: by((e) => e.kind), runs: this.data.runs.length };
  }
}

// Stage 1 (offline): build or refresh the map from the catalogs + scripts.
export function mapApi(memory, files, dmap) {
  const t0 = Date.now();
  const index = indexCallSites(files);
  let added = 0;
  for (const cat of memory.catalogs()) {
    const holders = [
      ...Object.entries(cat.objects || {}).map(([h, ms]) => [h, ms]),
      ...Object.entries(cat.globals || {}).filter(([, v]) => Array.isArray(v)),
    ];
    for (const [holder, methods] of holders) {
      for (const method of methods) {
        const raw = index.get(method);
        // Only call sites on the same kind of object count as evidence:
        // ResourceGenerator.Create says nothing about Player:GetUnits:Create.
        const pattern = holderPattern(holder);
        const matched = raw ? raw.sites.filter((x) => pattern.test(x.v)) : [];
        const ev = matched.length ? { ...raw, sites: matched.slice(0, 3), contexts: new Set(matched.map((x) => x.ctx)) } : null;
        const kind = classify(method);
        const baseHolder = holder.split(":").pop().replace(/^Get/, "");
        const weight = HOLDER_WEIGHT[holder.split(":")[0]] || HOLDER_WEIGHT[baseHolder] || 1;
        const tuner = ev?.contexts.has("tuner") || false;
        const gameplay = ev?.contexts.has("gameplay") || false;
        // Leverage: writes on core game objects, proven safe by Firaxis' own
        // cheat panels or gameplay scripts, rank highest.
        const leverage = (kind === "write" ? 10 : kind === "action" ? 4 : kind === "read" ? 1 : 2) * weight + (tuner ? 15 : 0) + (gameplay ? 5 : 0) + (ev ? 3 : -8);
        const existing = dmap.get(cat.state, holder, method);
        if (!existing) added++;
        dmap.update(cat.state, holder, method, {
          kind,
          leverage,
          status: ev ? "evidenced" : "unknown",
          evidence: ev ? { count: ev.count, contexts: [...ev.contexts], zeroArg: ev.zeroArg, zeroArgVars: [...ev.zeroArgVars], sites: ev.sites } : null,
          nameOnlyEvidence: !ev && raw ? raw.sites.slice(0, 2) : undefined,
        });
      }
    }
  }
  const run = { at: new Date().toISOString(), stage: "map", ms: Date.now() - t0, added, ...dmap.stats() };
  dmap.data.runs.push(run);
  dmap.save();
  return run;
}

// Which objects the probe can reach, as Lua expressions (mirrors apiscan.lua).
export const PROBE_OBJECTS = {
  Player: "p",
  PlayerVisibility: "PlayersVisibility[me]",
  PlayerConfiguration: "PlayerConfigurations[me]",
  Eras: "Game.GetEras()",
  City: "city",
  District: "district",
  Unit: "unit",
  Plot: "plot",
};
export function probeExpr(holder) {
  if (PROBE_OBJECTS[holder]) return PROBE_OBJECTS[holder];
  const m = /^(Player|City|Unit):(Get[A-Za-z_]+)$/.exec(holder);
  if (m) return `${PROBE_OBJECTS[m[1]]}:${m[2]}()`;
  return null;
}

// The object a variable must look like for its zero-argument call to count
// as evidence for this holder: "pBuildQueue:GetSize()" is evidence for
// City:GetBuildQueue, "plot:GetYield()" would be for Plot - a zero-argument
// call on some other object proves nothing here.
export function holderPattern(holder) {
  const base = holder.includes(":") ? holder.split(":")[1].replace(/^Get/, "") : holder;
  const words = base.match(/[A-Z][a-z]+/g) || [base];
  const word = holder.includes(":") ? words[0] : words[words.length - 1];
  return new RegExp(word.slice(0, Math.min(5, word.length)), "i");
}

// Shared by probeCandidates (the initial batch selection) and probeBatch's
// per-chunk re-check (immediately before dispatch) - the two must agree on
// exactly what "safe to probe live" means, or a candidate blocked/revoked
// between those two points could slip through on a stale snapshot.
function isProbeEligible(e) {
  return e.kind === "read" && e.status === "evidenced" && !e.probe && !!probeExpr(e.holder) && (e.evidence?.zeroArgVars || []).some((v) => holderPattern(e.holder).test(v));
}

// Stage 2 candidates: zero-argument getters whose shipped usage shows a
// zero-argument call on the same kind of object, reachable by the probe.
// Never writes.
export function probeCandidates(dmap, { limit = 150 } = {}) {
  return dmap.entries
    .filter(isProbeEligible)
    .sort((a, b) => b.leverage - a.leverage)
    .slice(0, limit);
}

export const PROBE_LUA = `
local me = Game.GetLocalPlayer()
local p = Players[me]
local city, district, unit, plot = nil, nil, nil, nil
pcall(function() city = p:GetCities():GetCapitalCity() end)
pcall(function() for _, d in city:GetDistricts():Members() do district = d; break end end)
pcall(function() for _, u in p:GetUnits():Members() do unit = u; break end end)
pcall(function() plot = Map.GetPlot(city:GetX(), city:GetY()) end)
local out = {}
for _, c in ipairs(P.calls) do
  local f = loadstring('local me, p, city, district, unit, plot = ... return (' .. c.expr .. '):' .. c.method .. '()')
  local r = { key = c.key }
  if not f then
    r.err = 'compile'
  else
    local ok, v = pcall(f, me, p, city, district, unit, plot)
    if ok then
      r.type = type(v)
      if type(v) == 'number' or type(v) == 'boolean' then r.value = v
      elseif type(v) == 'string' then r.value = string.sub(v, 1, 80)
      elseif type(v) == 'table' then local n = 0; pcall(function() for _ in pairs(v) do n = n + 1 end end); r.size = n end
    else
      r.err = shortErr(v)
    end
  end
  out[#out + 1] = r
end
emitJson(out)
`;

// Stage 2 (live, read-only): call a batch of evidenced zero-arg getters.
export async function probeBatch(game, dmap, { limit = 120, onProgress } = {}) {
  const cands = probeCandidates(dmap, { limit });
  if (!cands.length) return { probed: 0, note: "nothing left to probe (run Map API first, or everything reachable is probed)" };
  const byState = {};
  for (const e of cands) (byState[e.state] ||= []).push(e);
  let probed = 0;
  let errors = 0;
  for (const [state, list] of Object.entries(byState)) {
    for (let i = 0; i < list.length; i += 40) {
      const chunk = list.slice(i, i + 40);
      onProgress?.(`Probing ${state} (${probed + chunk.length}/${cands.length})...`);
      // cands was snapshotted once, before this loop started. onProgress
      // (or anything else) may have blocked a candidate or revoked its
      // zero-arg evidence since then - re-check the live entry right
      // before dispatch so a just-blocked getter is never sent anyway.
      const eligible = chunk.filter((e) => isProbeEligible(dmap.get(e.state, e.holder, e.method) || {}));
      if (!eligible.length) continue;
      const calls = eligible.map((e) => ({ key: `${e.holder}|${e.method}`, expr: probeExpr(e.holder), method: e.method }));
      const { value } = await game.lua(state, PROBE_LUA, { params: { calls }, timeoutMs: 30000 });
      for (const r of value || []) {
        const [holder, method] = r.key.split("|");
        if (r.err) errors++;
        dmap.update(state, holder, method, {
          status: r.err ? "evidenced" : "probed",
          probe: r.err ? { err: r.err } : { type: r.type, value: r.value, size: r.size },
        });
        probed++;
      }
    }
  }
  const run = { at: new Date().toISOString(), stage: "probe", probed, errors, ...dmap.stats() };
  dmap.data.runs.push(run);
  dmap.save();
  return run;
}

// Stage 3: what the AI should prove next - high-leverage writes with
// shipped evidence that are not yet proven, blocked or turned into abilities.
export function frontier(dmap, { limit = 10, holder, kind = "write" } = {}) {
  return dmap.entries
    .filter((e) => e.kind === kind && ["evidenced", "probed"].includes(e.status) && e.evidence)
    .filter((e) => !holder || e.holder.toLowerCase().includes(holder.toLowerCase()))
    .sort((a, b) => b.leverage - a.leverage)
    .slice(0, limit)
    .map((e) => ({ state: e.state, holder: e.holder, method: e.method, leverage: e.leverage, status: e.status, contexts: e.evidence.contexts, sites: e.evidence.sites, notes: e.notes }));
}

export function summary(dmap) {
  const s = dmap.stats();
  const writes = dmap.entries.filter((e) => e.kind === "write");
  return {
    ...s,
    writes: writes.length,
    writesWithEvidence: writes.filter((e) => e.evidence).length,
    writesInFiraxisCheatPanels: writes.filter((e) => e.evidence?.contexts?.includes("tuner")).length,
    proven: dmap.entries.filter((e) => e.status === "proven" || e.status === "ability").length,
    blocked: dmap.entries.filter((e) => e.status === "blocked").length,
    lastRuns: dmap.data.runs.slice(-3),
  };
}

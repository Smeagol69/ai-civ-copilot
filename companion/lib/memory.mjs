// Everything the copilot learns and keeps between sessions:
//   abilities/   Lua it wrote, tested, and saved as a named, parameterised
//                tool. Each saved ability becomes a callable tool on every
//                later request - the copilot extends its own toolset.
//   knowledge.md facts it verified about the game's API (which call works in
//                which state, what a function really takes). Fed back into
//                its system prompt.
//   api-catalog/ the live API surface per Lua state, from scan_api.
//   journal.jsonl every write, with the game's own before/after.
//
// Nothing here is ever deleted by the copilot. A re-saved ability keeps its
// previous versions.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_DATA_DIR = process.env.AICIV_DATA_DIR || path.join(HERE, "..", "data");

const NAME_RE = /^[a-z][a-z0-9_]{2,48}$/;

export class Memory {
  constructor(dir = DEFAULT_DATA_DIR) {
    this.dir = dir;
    this.abilitiesDir = path.join(dir, "abilities");
    this.catalogDir = path.join(dir, "api-catalog");
    this.knowledgeFile = path.join(dir, "knowledge.md");
    this.journalFile = path.join(dir, "journal.jsonl");
    for (const d of [this.dir, this.abilitiesDir, this.catalogDir]) fs.mkdirSync(d, { recursive: true });
  }

  // ------------------------------------------------------------ abilities
  listAbilities() {
    return fs
      .readdirSync(this.abilitiesDir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => {
        try {
          return JSON.parse(fs.readFileSync(path.join(this.abilitiesDir, f), "utf8"));
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  getAbility(name) {
    const f = path.join(this.abilitiesDir, `${name}.json`);
    return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : null;
  }

  saveAbility({ name, description, state, lua, properties = {}, required = [], kind = "query", tested }) {
    if (!NAME_RE.test(name || "")) throw new Error("ability name must be lower_snake_case, 3-49 chars, starting with a letter");
    if (!description || description.length < 10) throw new Error("ability needs a description (what it does, when to use it)");
    if (!state) throw new Error("ability needs the Lua state it runs in (InGame, GameCore_Tuner, ...)");
    if (!lua || !lua.trim()) throw new Error("ability needs Lua code");
    for (const r of required) if (!properties[r]) throw new Error(`required parameter ${r} is not declared in properties`);
    const prev = this.getAbility(name);
    const now = new Date().toISOString();
    const record = {
      name,
      description,
      state,
      kind,
      properties,
      required,
      lua,
      tested: tested || null,
      createdAt: prev?.createdAt || now,
      updatedAt: now,
      uses: prev?.uses || 0,
      history: prev ? [...(prev.history || []), { at: prev.updatedAt, lua: prev.lua, description: prev.description }] : [],
    };
    fs.writeFileSync(path.join(this.abilitiesDir, `${name}.json`), JSON.stringify(record, null, 2));
    return record;
  }

  markAbilityUsed(name, ok) {
    const a = this.getAbility(name);
    if (!a) return;
    a.uses = (a.uses || 0) + 1;
    a.lastUsed = new Date().toISOString();
    a.lastOk = ok;
    fs.writeFileSync(path.join(this.abilitiesDir, `${name}.json`), JSON.stringify(a, null, 2));
  }

  // ------------------------------------------------------------ knowledge
  knowledge() {
    return fs.existsSync(this.knowledgeFile) ? fs.readFileSync(this.knowledgeFile, "utf8") : "";
  }

  remember(fact, { topic = "general" } = {}) {
    const line = `- [${new Date().toISOString().slice(0, 10)}] (${topic}) ${fact.replace(/\s+/g, " ").trim()}\n`;
    fs.appendFileSync(this.knowledgeFile, line);
    return line.trim();
  }

  // Newest facts win when the file outgrows the prompt budget.
  knowledgeForPrompt(maxChars = 24000) {
    const k = this.knowledge();
    if (k.length <= maxChars) return k;
    return "(older facts truncated)\n" + k.slice(k.length - maxChars).replace(/^[^\n]*\n/, "");
  }

  // ------------------------------------------------------------ catalog
  saveCatalog(state, catalog) {
    const f = path.join(this.catalogDir, `${state.replace(/[^\w.-]/g, "_")}.json`);
    fs.writeFileSync(f, JSON.stringify({ state, scannedAt: new Date().toISOString(), ...catalog }, null, 1));
    return f;
  }

  catalogs() {
    return fs
      .readdirSync(this.catalogDir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => JSON.parse(fs.readFileSync(path.join(this.catalogDir, f), "utf8")));
  }

  // Search every saved catalog for names matching a query (case-insensitive
  // substring, or /regex/).
  searchCatalog(query, { state, limit = 200 } = {}) {
    const re = query.startsWith("/") && query.lastIndexOf("/") > 0
      ? new RegExp(query.slice(1, query.lastIndexOf("/")), query.slice(query.lastIndexOf("/") + 1).replace("g", "") || "i")
      : new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    const hits = [];
    for (const c of this.catalogs()) {
      if (state && c.state !== state) continue;
      for (const [g, v] of Object.entries(c.globals || {})) {
        if (Array.isArray(v)) {
          for (const m of v) if (re.test(m) || re.test(g)) hits.push(`${c.state}  ${g}.${m}(...)`);
        } else if (re.test(g)) hits.push(`${c.state}  ${g}  [${v}]`);
      }
      for (const [obj, methods] of Object.entries(c.objects || {})) {
        for (const m of methods) if (re.test(m) || re.test(obj)) hits.push(`${c.state}  <${obj}>:${m}(...)`);
      }
      for (const [e, vals] of Object.entries(c.enums || {})) {
        for (const k of Object.keys(vals)) if (re.test(k) || re.test(e)) hits.push(`${c.state}  ${e}.${k} = ${vals[k]}`);
      }
      for (const t of c.gameInfoTables || []) if (re.test(t)) hits.push(`${c.state}  GameInfo.${t}`);
      if (hits.length >= limit) break;
    }
    return { total: hits.length, hits: hits.slice(0, limit), catalogs: this.catalogs().map((c) => `${c.state} @ ${c.scannedAt}`) };
  }

  // ------------------------------------------------------------ journal
  record(entry) {
    fs.appendFileSync(this.journalFile, JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n");
  }

  recentJournal(n = 20) {
    if (!fs.existsSync(this.journalFile)) return [];
    const lines = fs.readFileSync(this.journalFile, "utf8").trim().split("\n").filter(Boolean);
    return lines.slice(-n).map((l) => JSON.parse(l));
  }
}

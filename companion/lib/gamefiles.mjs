// Search Firaxis' own scripts in the game install. The shipped UI and
// gameplay Lua is the best documentation of the engine API that exists:
// every call there is known to work, with real argument shapes.

import fs from "node:fs";
import path from "node:path";

export const DEFAULT_GAME_DIR =
  process.env.CIV6_GAME_DIR || "D:\\SteamLibrary\\steamapps\\common\\Sid Meier's Civilization VI";

const EXTS = new Set([".lua", ".xml", ".sql", ".modinfo", ".ltp"]);

export class GameFiles {
  constructor(gameDir = DEFAULT_GAME_DIR) {
    this.gameDir = gameDir;
    this.files = null;
    this.cache = new Map();
  }

  available() {
    return fs.existsSync(this.gameDir);
  }

  #walk(dir, out) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) this.#walk(p, out);
      else if (EXTS.has(path.extname(e.name).toLowerCase())) out.push(p);
    }
  }

  list() {
    if (!this.files) {
      this.files = [];
      for (const sub of ["Base", "DLC", "Debug"]) this.#walk(path.join(this.gameDir, sub), this.files);
    }
    return this.files;
  }

  #read(file) {
    if (!this.cache.has(file)) {
      try {
        this.cache.set(file, fs.readFileSync(file, "utf8").split(/\r?\n/));
      } catch {
        this.cache.set(file, []);
      }
    }
    return this.cache.get(file);
  }

  // pattern: plain text (case-insensitive) or /regex/flags. ext: ".lua" etc.
  search(pattern, { ext = ".lua", maxResults = 60, context = 0, pathFilter } = {}) {
    if (!this.available()) return { error: `game directory not found: ${this.gameDir} (set CIV6_GAME_DIR)` };
    const re = pattern.startsWith("/") && pattern.lastIndexOf("/") > 0
      ? new RegExp(pattern.slice(1, pattern.lastIndexOf("/")), pattern.slice(pattern.lastIndexOf("/") + 1).replace("g", ""))
      : new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    const hits = [];
    let total = 0;
    for (const f of this.list()) {
      if (ext && !f.toLowerCase().endsWith(ext)) continue;
      if (pathFilter && !f.toLowerCase().includes(pathFilter.toLowerCase())) continue;
      const lines = this.#read(f);
      for (let i = 0; i < lines.length; i++) {
        if (!re.test(lines[i])) continue;
        total++;
        if (hits.length < maxResults) {
          const rel = path.relative(this.gameDir, f);
          const from = Math.max(0, i - context);
          const to = Math.min(lines.length - 1, i + context);
          const snippet = lines.slice(from, to + 1).map((l) => l.trim().slice(0, 240)).join(context ? "\n    " : "");
          hits.push(`${rel}:${i + 1}: ${snippet}`);
        }
      }
    }
    return { total, shown: hits.length, hits };
  }

  read(relPath, { from = 1, count = 120 } = {}) {
    const full = path.resolve(this.gameDir, relPath);
    if (!full.startsWith(path.resolve(this.gameDir))) return { error: "path escapes the game directory" };
    const lines = this.#read(full);
    if (!lines.length) return { error: `cannot read ${relPath}` };
    return { file: relPath, from, lines: lines.slice(from - 1, from - 1 + count).map((l, i) => `${from + i}: ${l}`) };
  }
}

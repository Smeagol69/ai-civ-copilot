// FireTuner client for Civilization VI.
//
// Civ VI opens a debug socket on 127.0.0.1:4318 when AppOptions.txt has
// `EnableTuner 1`. It executes Lua in any named Lua state and streams print()
// output back. This is the only channel into a running game from outside: Civ
// VI's Lua has no sockets and no file I/O.
//
// Wire format (both directions): [u32 LE length][i32 LE tag][payload + "\0"].
//   tag 4  handshake: "APP:" (identity), "LSQ:" (list Lua states)
//   tag 3  command:   "CMD:<stateIndex>:<lua>"
// print() output arrives as payloads shaped "O\0<StateName>: <text>".
// A Lua compile error arrives as a payload starting "ERR:".
//
// Protocol reference: lmwilki/civ6-mcp (MIT), src/civ_mcp/tuner_client.py.

import net from "node:net";
import { EventEmitter } from "node:events";

export const TAG_HELP = 1;
export const TAG_COMMAND = 3;
export const TAG_HANDSHAKE = 4;
export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_PORT = 4318;
export const DEFAULT_LOCK_PORT = Number(process.env.AICIV_LOCK_PORT || 47318);
const PORT_SCAN = Number(process.env.CIV6_TUNER_PORT_SCAN || 6);
// Upper bound on any single call, whatever the caller asks for.
export const MAX_TIMEOUT_MS = 120000;
// After a call times out, how long to keep waiting (holding the lock) for the
// game to finish it before the connection is dropped as unsettled.
const LATE_GRACE_MS = Number(process.env.AICIV_LATE_GRACE_MS || 30000);
const MAX_FRAME_BYTES = 64 * 1024 * 1024;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const LOST = Object.freeze({ lost: true });

// Machine-wide mutex: one process at a time talks to the game.
//
// Why: on 2026-10-04 thirteen concurrent clients ran against the live game
// and it crashed. The first replacement, a lock file, had check-then-delete
// races (two holders at once, reproduced). This one binds a fixed localhost
// TCP port instead: binding is exclusive, and the OS releases it the instant
// the holder exits or is killed, so there is no stale-holder logic at all.
// (Named pipes would be the classic choice but are refused with EACCES in
// this environment.) Anyone connecting to the port is told who holds it.
export class TunerMutex {
  constructor({ port = DEFAULT_LOCK_PORT, host = "127.0.0.1" } = {}) {
    this.port = port;
    this.host = host;
    this.server = null;
  }

  #tryListen() {
    return new Promise((resolve) => {
      const server = net.createServer((sock) => sock.end(`aiciv-lock pid=${process.pid}\n`));
      server.once("error", (err) => resolve({ code: err.code || err.message }));
      server.listen({ host: this.host, port: this.port, exclusive: true }, () => {
        server.unref();
        resolve({ server });
      });
    });
  }

  // Who is holding the port? Used once, to tell "another copilot is busy"
  // apart from "some other program owns this port".
  #banner() {
    return new Promise((resolve) => {
      const sock = net.createConnection({ host: this.host, port: this.port });
      let text = "";
      const done = () => {
        sock.destroy();
        resolve(text);
      };
      sock.setTimeout(1000, done);
      sock.on("data", (d) => (text += d));
      sock.on("end", done);
      sock.on("error", done);
    });
  }

  async acquire(waitMs = 180000) {
    const started = Date.now();
    let checked = false;
    for (;;) {
      const r = await this.#tryListen();
      if (r.server) {
        this.server = r.server;
        return;
      }
      if (r.code !== "EADDRINUSE") throw new Error(`tuner lock: cannot bind 127.0.0.1:${this.port} (${r.code})`);
      if (!checked && Date.now() - started > 3000) {
        checked = true;
        const banner = await this.#banner();
        if (banner && !banner.startsWith("aiciv-lock")) {
          throw new Error(`tuner lock port ${this.port} is used by another program; set AICIV_LOCK_PORT to a free port`);
        }
      }
      if (Date.now() - started > waitMs) throw new Error(`timed out after ${waitMs} ms waiting for the tuner lock (another copilot process is talking to the game)`);
      await sleep(10 + Math.floor(Math.random() * 25));
    }
  }

  release() {
    const s = this.server;
    this.server = null;
    if (!s) return Promise.resolve();
    return new Promise((resolve) => s.close(() => resolve()));
  }
}

export function encodeFrame(tag, payload) {
  const body = Buffer.concat([Buffer.from(payload, "utf8"), Buffer.from([0])]);
  const header = Buffer.alloc(8);
  header.writeUInt32LE(body.length, 0);
  header.writeInt32LE(tag, 4);
  return Buffer.concat([header, body]);
}

// Incremental frame decoder. Feed it socket chunks; it returns whole frames.
// A header announcing an absurd length means the stream is out of sync; the
// decoder marks itself corrupt and the client drops the connection.
export class FrameDecoder {
  constructor() {
    this.buf = Buffer.alloc(0);
    this.corrupt = false;
  }
  push(chunk) {
    if (this.corrupt) return [];
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const out = [];
    while (this.buf.length >= 8) {
      const len = this.buf.readUInt32LE(0);
      const tag = this.buf.readInt32LE(4);
      if (len > MAX_FRAME_BYTES) {
        this.corrupt = true;
        this.buf = Buffer.alloc(0);
        break;
      }
      if (this.buf.length < 8 + len) break;
      const body = this.buf.subarray(8, 8 + len);
      let end = body.length;
      while (end > 0 && body[end - 1] === 0) end--;
      out.push({ tag, payload: body.subarray(0, end).toString("utf8") });
      this.buf = this.buf.subarray(8 + len);
    }
    return out;
  }
}

// "O\0InGame: hello" -> { state: "InGame", text: "hello" }. Anything else -> null.
export function parseOutput(payload) {
  if (!payload.startsWith("O")) return null;
  const rest = payload.replace(/^O\0?/, "");
  const sep = rest.indexOf(": ");
  if (sep < 0) return { state: "", text: rest };
  return { state: rest.slice(0, sep), text: rest.slice(sep + 2) };
}

// LSQ reply is alternating index/name entries separated by NULs (or newlines).
export function parseStateList(payload) {
  let parts = payload.split("\0").map((s) => s.trim()).filter(Boolean);
  if (parts.length <= 1 && payload.includes("\n")) {
    parts = payload.split("\n").map((s) => s.trim()).filter(Boolean);
  }
  const states = [];
  for (let i = 0; i + 1 < parts.length; ) {
    const idx = Number(parts[i]);
    if (Number.isInteger(idx)) {
      states.push({ index: idx, name: parts[i + 1] });
      i += 2;
    } else {
      i += 1;
    }
  }
  return states;
}

// Engine errors carry the whole chunk source as the chunk name plus a
// traceback. Keep "line N: message".
export function shortLuaError(msg) {
  const first = String(msg).split("\n")[0];
  return first.replace(/^\[string ".*?"\]:(\d+):/, "line $1:").trim();
}

export class LuaError extends Error {
  // code: compile | runtime | timeout | lost | not-found
  constructor(message, { state, code, outcome } = {}) {
    super(message);
    this.name = "LuaError";
    this.state = state;
    this.code = code;
    if (outcome) this.outcome = outcome;
  }
}

export class TunerClient extends EventEmitter {
  // lock: a TunerMutex, or false to disable (default: the machine-wide one).
  // trace(event): called with {phase: start|end|error|lost, ...} around every
  // command - the record of what was in flight if the game dies.
  constructor({ host = DEFAULT_HOST, port = DEFAULT_PORT, log = () => {}, lock, trace, lateGraceMs = LATE_GRACE_MS } = {}) {
    super();
    this.lateGraceMs = lateGraceMs;
    this.host = host;
    this.port = port;
    this.basePort = port;
    this.log = log;
    // Under node --test the machine-wide lock is off unless a test passes one,
    // so the suite never contends with a real bridge.
    this.lock = lock === false ? null : lock || (process.env.NODE_TEST_CONTEXT ? null : new TunerMutex());
    this.trace = trace || null;
    this.socket = null;
    this.waiters = [];
    // Frames that arrived with nobody waiting. Several frames often arrive in
    // one TCP chunk, so a reply can land before the next waiter registers;
    // without this buffer the second frame of a burst would be lost.
    this.inbox = [];
    this.app = null;
    this.states = [];
    this.queue = Promise.resolve();
    this.connecting = null;
    this.nonce = 0;
  }

  get connected() {
    return !!this.socket && !this.socket.destroyed;
  }

  // Single-flight: concurrent callers share one attempt, so there is never
  // more than one socket per client.
  connect(timeoutMs = 4000) {
    if (!this.connecting) {
      this.connecting = this.#connect(timeoutMs).finally(() => {
        this.connecting = null;
      });
    }
    return this.connecting;
  }

  // The game does not always get its preferred port back: after loading a
  // save it re-bound on 4319 (2026-10-03). Scan a short range, but accept a
  // port only if a tuner actually answers there - the post-load screen
  // accepts connections without ever reading them, and so might any other
  // program on these ports.
  async #connect(timeoutMs) {
    const ports = [this.port, ...Array.from({ length: PORT_SCAN }, (_, i) => this.basePort + i).filter((p) => p !== this.port)];
    const notes = [];
    for (const port of ports) {
      let sock;
      try {
        sock = await this.#open(port, timeoutMs);
      } catch (err) {
        notes.push(`${port}: ${err.code || err.message}`);
        continue;
      }
      this.#attach(sock);
      let hs;
      try {
        hs = await this.#handshake();
      } catch (err) {
        // Lock or protocol trouble is not a reason to try other ports.
        this.#detach(sock);
        throw err;
      }
      if (hs.app || hs.states.length) {
        this.port = port;
        return;
      }
      notes.push(`${port}: accepted but never answered (load screen, or not a Civ VI tuner)`);
      this.#detach(sock);
    }
    throw new Error(`no Civ VI tuner answered on ${this.host} (${notes.join("; ")})`);
  }

  #open(port, timeoutMs) {
    return new Promise((resolve, reject) => {
      const sock = net.createConnection({ host: this.host, port });
      const timer = setTimeout(() => {
        sock.destroy();
        reject(new Error(`timed out connecting to ${this.host}:${port}`));
      }, timeoutMs);
      sock.once("connect", () => {
        clearTimeout(timer);
        resolve(sock);
      });
      sock.once("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  // Every handler is bound to its own socket: a previous socket's late
  // "close" must never touch the current one.
  #attach(sock) {
    if (this.socket && this.socket !== sock) this.#detach(this.socket);
    this.socket = sock;
    this.inbox = [];
    const decoder = new FrameDecoder();
    sock.setNoDelay(true);
    sock.on("data", (chunk) => {
      if (this.socket !== sock) return;
      for (const frame of decoder.push(chunk)) this.#dispatch(frame);
      if (decoder.corrupt) {
        this.log("tuner stream out of sync; dropping the connection");
        this.#detach(sock);
      }
    });
    sock.on("close", () => {
      if (this.socket !== sock) return;
      this.socket = null;
      this.#failWaiters();
      this.emit("close");
    });
    sock.on("error", (err) => this.log(`tuner socket error: ${err.message}`));
  }

  #detach(sock) {
    const current = this.socket === sock;
    if (current) this.socket = null;
    sock.destroy();
    if (current) this.#failWaiters();
  }

  // Wake everything waiting on the dead connection right away.
  #failWaiters() {
    this.inbox = [];
    for (const w of this.waiters.splice(0)) w(LOST);
  }

  close() {
    if (this.socket) this.#detach(this.socket);
  }

  #dispatch(frame) {
    this.emit("frame", frame);
    const w = this.waiters.shift();
    if (w) return w(frame);
    this.inbox.push(frame);
    if (this.inbox.length > 5000) this.inbox.splice(0, this.inbox.length - 5000);
  }

  // Next frame; null on timeout; LOST if the connection is gone.
  #next(timeoutMs) {
    if (this.inbox.length) return Promise.resolve(this.inbox.shift());
    if (!this.connected) return Promise.resolve(LOST);
    return new Promise((resolve) => {
      let done = false;
      const fn = (frame) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(frame);
      };
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        const i = this.waiters.indexOf(fn);
        if (i >= 0) this.waiters.splice(i, 1);
        resolve(null);
      }, timeoutMs);
      this.waiters.push(fn);
    });
  }

  // A handshake reply: the first frame that is not print output or an error.
  // Other scripts print into the same stream; taking any frame as the reply
  // turned the state list into [] whenever a print landed first.
  async #reply(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const left = deadline - Date.now();
      if (left <= 0) return null;
      const f = await this.#next(left);
      if (!f || f === LOST) return null;
      if (f.payload.startsWith("O\0") || f.payload.startsWith("ERR:")) continue;
      return f;
    }
  }

  #send(tag, payload) {
    if (!this.connected) throw new LuaError("tuner not connected", { code: "lost" });
    this.socket.write(encodeFrame(tag, payload));
  }

  async #locked(fn) {
    if (!this.lock) return fn();
    await this.lock.acquire();
    try {
      return await fn();
    } finally {
      await this.lock.release();
    }
  }

  #serial(fn) {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => {});
    return run;
  }

  async #lsq() {
    this.inbox = [];
    this.#send(TAG_HANDSHAKE, "LSQ:");
    const r = await this.#reply(5000);
    // No reply keeps what we knew; a real reply replaces it.
    if (r) this.states = parseStateList(r.payload);
    return this.states;
  }

  #handshake() {
    return this.#serial(() =>
      this.#locked(async () => {
        this.inbox = [];
        this.states = [];
        this.#send(TAG_HANDSHAKE, "APP:");
        const app = await this.#reply(5000);
        this.app = app ? app.payload : null;
        await this.#lsq();
        return { app: this.app, states: this.states };
      }),
    );
  }

  async refreshStates() {
    return this.#serial(() => this.#locked(() => this.#lsq()));
  }

  stateIndex(name) {
    const s = this.states.find((x) => x.name === name);
    return s ? s.index : null;
  }

  // Runs Lua in a named state and returns the lines it emitted through the
  // per-call channel. The Lua is wrapped so that:
  //   - emit(s) prints "@@<nonce>|s" - only these lines are collected, so
  //     print() noise from the game or other mods never leaks into results;
  //   - a runtime error is caught and reported in-band;
  //   - a sentinel marks the end so we never wait for a timeout on success.
  async exec(stateName, body, { timeoutMs = 15000, label } = {}) {
    const limit = Math.max(1, Math.min(Number(timeoutMs) || 15000, MAX_TIMEOUT_MS));
    return this.#serial(() => this.#locked(() => this.#exec(stateName, body, limit, label)));
  }

  async #exec(stateName, body, timeoutMs, label) {
    // Anything still buffered is print noise from earlier; it is not ours.
    this.inbox = [];
    if (!this.connected) throw new LuaError("tuner not connected", { state: stateName, code: "lost" });
    let idx = this.stateIndex(stateName);
    if (idx === null) {
      await this.#lsq();
      idx = this.stateIndex(stateName);
    }
    if (idx === null) {
      const names = this.states.map((s) => s.name).join(", ") || "(none)";
      throw new LuaError(`Lua state "${stateName}" not found. Is a game loaded? States: ${names}`, { state: stateName, code: "not-found" });
    }
    const n = `${Date.now().toString(36)}${(this.nonce++).toString(36)}`;
    const tag = `@@${n}|`;
    const end = `@@${n}$END`;
    const errTag = `@@${n}$ERR|`;
    const lua =
      `local __tag = "${tag}" ` +
      `local function emit(s) print(__tag .. tostring(s)) end ` +
      `local __ok, __err = pcall(function() ${body}\nend) ` +
      `if not __ok then print("${errTag}" .. tostring(__err)) end ` +
      `print("${end}")`;

    const started = Date.now();
    const finish = (phase, extra = {}) => this.trace?.({ phase, id: n, pid: process.pid, ms: Date.now() - started, ...extra });
    this.trace?.({ phase: "start", id: n, state: stateName, label, port: this.port, pid: process.pid, body });
    try {
      this.#send(TAG_COMMAND, `CMD:${idx}:${lua}`);
    } catch (err) {
      finish("error", { error: err.message, sent: false });
      throw err;
    }

    const lines = [];
    const deadline = started + timeoutMs;
    const graceDeadline = deadline + this.lateGraceMs;
    let late = false;
    for (;;) {
      const now = Date.now();
      if (now >= deadline) late = true;
      const left = (late ? graceDeadline : deadline) - now;
      if (left <= 0) {
        // The game never finished it. Its eventual reply would be taken as
        // the next call's, so this connection is no longer trustworthy.
        finish("error", { error: "timeout", outcome: "unknown" });
        if (this.socket) this.#detach(this.socket);
        throw new LuaError(
          `Lua in ${stateName} did not finish within ${timeoutMs + this.lateGraceMs} ms. The game may still be running it, so its effects are unknown; the connection was reset.`,
          { state: stateName, code: "timeout", outcome: "unknown" },
        );
      }
      const frame = await this.#next(left);
      if (frame === LOST) {
        finish("lost");
        throw new LuaError(`the game connection closed while Lua was running in ${stateName} (did the game crash or close?)`, { state: stateName, code: "lost", outcome: "unknown" });
      }
      if (!frame) continue;
      // Compile errors are not nonce-tagged. We hold the lock and wait for
      // every call to settle before releasing it, so one arriving now is ours.
      if (frame.payload.startsWith("ERR:")) {
        finish("error", { error: "compile" });
        throw new LuaError(frame.payload.slice(4).trim(), { state: stateName, code: "compile" });
      }
      const out = parseOutput(frame.payload);
      if (!out) continue;
      const text = out.text;
      if (text === end || text.endsWith(end)) break;
      const ei = text.indexOf(errTag);
      if (ei >= 0) {
        finish("error", { error: "runtime" });
        throw new LuaError(shortLuaError(text.slice(ei + errTag.length)), { state: stateName, code: "runtime" });
      }
      const ti = text.indexOf(tag);
      if (ti >= 0) lines.push(text.slice(ti + tag.length));
    }
    finish("end", { lines: lines.length, late: late || undefined });
    if (late) this.log(`Lua in ${stateName} finished late (${Date.now() - started} ms, asked for ${timeoutMs} ms)`);
    return lines;
  }
}

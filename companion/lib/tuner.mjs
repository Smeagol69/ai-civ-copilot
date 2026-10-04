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
// A Lua error arrives as a payload starting "ERR:".
//
// Protocol reference: lmwilki/civ6-mcp (MIT), src/civ_mcp/tuner_client.py.

import net from "node:net";
import { EventEmitter } from "node:events";

export const TAG_HELP = 1;
export const TAG_COMMAND = 3;
export const TAG_HANDSHAKE = 4;
export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_PORT = 4318;
const PORT_SCAN = Number(process.env.CIV6_TUNER_PORT_SCAN || 6);

export function encodeFrame(tag, payload) {
  const body = Buffer.concat([Buffer.from(payload, "utf8"), Buffer.from([0])]);
  const header = Buffer.alloc(8);
  header.writeUInt32LE(body.length, 0);
  header.writeInt32LE(tag, 4);
  return Buffer.concat([header, body]);
}

// Incremental frame decoder. Feed it socket chunks; it returns whole frames.
export class FrameDecoder {
  constructor() {
    this.buf = Buffer.alloc(0);
  }
  push(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const out = [];
    while (this.buf.length >= 8) {
      const len = this.buf.readUInt32LE(0);
      const tag = this.buf.readInt32LE(4);
      if (this.buf.length < 8 + len) break;
      let body = this.buf.subarray(8, 8 + len);
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

export class LuaError extends Error {
  constructor(message, { state, code } = {}) {
    super(message);
    this.name = "LuaError";
    this.state = state;
    this.code = code;
  }
}

export class TunerClient extends EventEmitter {
  constructor({ host = DEFAULT_HOST, port = DEFAULT_PORT, log = () => {} } = {}) {
    super();
    this.host = host;
    this.port = port;
    this.basePort = port;
    this.log = log;
    this.socket = null;
    this.decoder = new FrameDecoder();
    this.waiters = [];
    // Frames that arrived with nobody waiting. Several frames often arrive in
    // one TCP chunk, so a reply can land before the next waiter registers;
    // without this buffer the second frame of a burst would be lost.
    this.inbox = [];
    this.app = null;
    this.states = [];
    this.queue = Promise.resolve();
    this.nonce = 0;
  }

  get connected() {
    return !!this.socket && !this.socket.destroyed;
  }

  // The game does not always get its preferred port back. Observed live:
  // after loading a save from the main menu the tuner re-bound on 4319, not
  // 4318 (the old socket was still closing). So scan a short range and stick
  // with whichever port answered.
  async connect(timeoutMs = 4000) {
    const ports = [this.port, ...Array.from({ length: PORT_SCAN }, (_, i) => this.basePort + i).filter((p) => p !== this.port)];
    let lastErr;
    for (const port of ports) {
      try {
        await this.#connectTo(port, timeoutMs);
        this.port = port;
        return;
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr;
  }

  async #connectTo(port, timeoutMs) {
    this.close();
    this.decoder = new FrameDecoder();
    this.inbox = [];
    await new Promise((resolve, reject) => {
      const sock = net.createConnection({ host: this.host, port });
      const timer = setTimeout(() => {
        sock.destroy();
        reject(new Error(`timed out connecting to ${this.host}:${port}`));
      }, timeoutMs);
      sock.once("connect", () => {
        clearTimeout(timer);
        this.socket = sock;
        resolve();
      });
      sock.once("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
    this.socket.setNoDelay(true);
    this.socket.on("data", (chunk) => {
      for (const frame of this.decoder.push(chunk)) this.#dispatch(frame);
    });
    this.socket.on("close", () => {
      this.socket = null;
      this.emit("close");
    });
    this.socket.on("error", (err) => this.log(`tuner socket error: ${err.message}`));
    await this.handshake();
  }

  close() {
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
  }

  #dispatch(frame) {
    this.emit("frame", frame);
    const w = this.waiters.shift();
    if (w) return w(frame);
    this.inbox.push(frame);
    if (this.inbox.length > 5000) this.inbox.splice(0, this.inbox.length - 5000);
  }

  // Waits for the next frame, or null on timeout.
  #next(timeoutMs) {
    if (this.inbox.length) return Promise.resolve(this.inbox.shift());
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

  #send(tag, payload) {
    if (!this.connected) throw new Error("tuner not connected");
    this.socket.write(encodeFrame(tag, payload));
  }

  async handshake() {
    // Drain anything the game sent on connect.
    while (await this.#next(250)) {}
    this.#send(TAG_HANDSHAKE, "APP:");
    const app = await this.#next(5000);
    this.app = app ? app.payload : null;
    await this.refreshStates();
  }

  async refreshStates() {
    return this.#serial(async () => {
      this.inbox = [];
      this.#send(TAG_HANDSHAKE, "LSQ:");
      const lsq = await this.#next(5000);
      this.states = lsq ? parseStateList(lsq.payload) : [];
      return this.states;
    });
  }

  stateIndex(name) {
    const s = this.states.find((x) => x.name === name);
    return s ? s.index : null;
  }

  #serial(fn) {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => {});
    return run;
  }

  // Runs Lua in a named state and returns the lines it emitted through the
  // per-call channel. The Lua is wrapped so that:
  //   - emit(s) prints "@@<nonce>|s" - only these lines are collected, so
  //     print() noise from the game or other mods never leaks into results;
  //   - a runtime error is caught and reported in-band;
  //   - a sentinel marks the end so we never wait for a timeout on success.
  async exec(stateName, body, { timeoutMs = 15000 } = {}) {
    return this.#serial(async () => {
      // Anything still buffered is print noise from earlier; it is not ours.
      this.inbox = [];
      let idx = this.stateIndex(stateName);
      if (idx === null) {
        this.#send(TAG_HANDSHAKE, "LSQ:");
        const lsq = await this.#next(5000);
        this.states = lsq ? parseStateList(lsq.payload) : [];
        idx = this.stateIndex(stateName);
      }
      if (idx === null) {
        const names = this.states.map((s) => s.name).join(", ") || "(none)";
        throw new LuaError(`Lua state "${stateName}" not found. Is a game loaded? States: ${names}`, {
          state: stateName,
        });
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
      this.#send(TAG_COMMAND, `CMD:${idx}:${lua}`);

      const lines = [];
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const left = deadline - Date.now();
        if (left <= 0) throw new LuaError(`Lua in ${stateName} timed out after ${timeoutMs} ms`, { state: stateName });
        const frame = await this.#next(left);
        if (!frame) continue;
        if (frame.payload.startsWith("ERR:")) {
          throw new LuaError(frame.payload.slice(4).trim(), { state: stateName, code: "compile" });
        }
        const out = parseOutput(frame.payload);
        if (!out) continue;
        const text = out.text;
        if (text === end || text.endsWith(end)) break;
        const ei = text.indexOf(errTag);
        if (ei >= 0) throw new LuaError(text.slice(ei + errTag.length), { state: stateName, code: "runtime" });
        const ti = text.indexOf(tag);
        if (ti >= 0) lines.push(text.slice(ti + tag.length));
      }
      return lines;
    });
  }
}

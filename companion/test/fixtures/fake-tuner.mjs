// A fake Civ VI tuner socket speaking the real wire protocol. It cannot run
// Lua; a handler decides what each CMD "prints". The handler receives the
// Lua source and the per-call tag/end markers parsed from the wrapper that
// TunerClient.exec builds, exactly as the game would see them.

import net from "node:net";
import { encodeFrame, FrameDecoder, TAG_COMMAND, TAG_HANDSHAKE } from "../../lib/tuner.mjs";

export const STATES = [
  { index: 0, name: "Tuner" },
  { index: 3, name: "GameCore_Tuner" },
  { index: 7, name: "InGame" },
];

export function startFakeTuner(handler) {
  const sockets = new Set();
  const received = [];
  const server = net.createServer((sock) => {
    sockets.add(sock);
    const dec = new FrameDecoder();
    const out = (tag, payload) => sock.write(encodeFrame(tag, payload));
    sock.on("data", (chunk) => {
      for (const f of dec.push(chunk)) {
        received.push(f);
        if (f.tag === TAG_HANDSHAKE && f.payload === "APP:") out(TAG_HANDSHAKE, "Civ6 fake");
        else if (f.tag === TAG_HANDSHAKE && f.payload === "LSQ:") {
          out(TAG_HANDSHAKE, STATES.flatMap((s) => [String(s.index), s.name]).join("\0"));
        } else if (f.tag === TAG_COMMAND) {
          const m = /^CMD:(\d+):([\s\S]*)$/.exec(f.payload);
          const state = STATES.find((s) => s.index === Number(m[1]))?.name;
          const lua = m[2];
          const tag = /local __tag = "([^"]+)"/.exec(lua)?.[1];
          const end = /print\("([^"]+\$END)"\)/.exec(lua)?.[1];
          const errTag = /print\("([^"]+\$ERR\|)"/.exec(lua)?.[1];
          const ctx = {
            state, lua,
            emit: (s) => out(TAG_COMMAND, `O\0${state}: ${tag}${s}`),
            emitJson: (v) => {
              const s = JSON.stringify(v);
              for (let i = 0; i < s.length; i += 900) ctx.emit("J" + s.slice(i, i + 900));
            },
            noise: (s) => out(TAG_COMMAND, `O\0${state}: ${s}`),
            runtimeError: (msg) => out(TAG_COMMAND, `O\0${state}: ${errTag}${msg}`),
            compileError: (msg) => out(TAG_COMMAND, `ERR:${msg}`),
            end: () => out(TAG_COMMAND, `O\0${state}: ${end}`),
          };
          Promise.resolve(handler(ctx)).then((r) => {
            if (r !== "no-end") ctx.end();
          });
        }
      }
    });
    sock.on("close", () => sockets.delete(sock));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        port: server.address().port,
        received,
        close: () => new Promise((r) => { for (const s of sockets) s.destroy(); server.close(r); }),
      });
    });
  });
}

# Working on AI Civ Copilot

Handoff notes for anyone - human or agent - picking this up. Read this before
changing anything; it records the decisions and the traps. Same arrangement as
the Satisfactory copilot (`Documents\satisfactory`): Claude and Codex
collaborate through git only, so anything the next agent needs must be in the
code, its comments, or this file.

## Working agreement

- **Only improve, extend, or optimise. Never remove a working feature unless
  the owner explicitly asks.** The owner's standing rule; it covers the other
  agent's work as much as your own.
- Branch by author: `claude/<task>`, `codex/<task>`. `master` is integration.
- Run `cd companion; npm test` before you commit (51 tests as of 2026-10-04).
- Every change gets its own commit with the reasoning in the message.
- Finish with a handoff: what changed, what was verified live, what is open.

## What this is

An in-game panel mod plus a localhost Node bridge for Civilization VI. The
owner wants **full read and write access**: the copilot may read anything and
change anything, and it is expected to keep **discovering and adding its own
abilities**.

```
Civ VI (EnableTuner 1)
  <-- FireTuner TCP, 127.0.0.1:4318 (+ scan to 4323) -->
bridge (companion/server.mjs)
  -> Lua injected into named Lua states (companion/lua/*.lua)
  -> snapshot -> solvers (deterministic numbers) -> model (Claude, tools)
  -> typed actions / raw Lua / saved abilities  -> back into the game
  -> game's own read-back -> answer
in-game panel (mod/AICivCopilot): Ctrl+Shift+A or the "AI" button
  outbox: ExposedMembers.AICivCopilot.outbox  (bridge polls it)
  replies: LuaEvents.AICivCopilot_Reply(id, kind, text)
HTTP 127.0.0.1:8737: /status /snapshot /summary /states /ask /lua /action /tool /say /journal
CLI: node companion/cli/civ.mjs ... (add --direct to skip the bridge)
```

Civ VI's Lua has no sockets and no file I/O. The FireTuner debug socket is the
only way in or out of a running game, so the mod is deliberately thin: a UI and
a mailbox. All capture and action logic is Lua the bridge injects, which means
**Lua changes take effect without restarting the game.**

## Non-negotiable rules

1. **The game is authoritative.** Numbers come from the game or from a solver
   over the game's numbers; the model does not estimate. Calculated values are
   labelled as calculated.
2. **Unknown stays unknown.** Every optional read in `snapshot.lua` goes through
   `try(name, fn)`; a failing API leaves a named entry in `gaps`, never a guess.
3. **Nothing is reported done until the game says so.** PLAY actions go through
   the same request path as a click (`CityManager/UnitManager/UI.Request*`)
   after the game's own `CanStart*` check, then a `verify_<action>` reads the
   world back (requests are asynchronous). EDIT actions return the game's own
   before/after.
4. **Never guess an engine API into a write.** Look it up first: the shipped
   Lua under `D:\SteamLibrary\steamapps\common\Sid Meier's Civilization VI\Base\Assets\UI`
   (and `DLC\*`) is the reference - grep it (`search_game_scripts` does this
   for the model). Then probe read-only with `run_lua`, then write.
5. **The copilot never deletes what it learned.** Saved abilities keep their
   history; `knowledge.md` is append-only.

## Self-extension (the point of the project)

| Tool | What it gives the model |
|---|---|
| `run_lua` | Arbitrary Lua in any Lua state. No restrictions. |
| `list_lua_states` | Every state the game exposes. Each UI screen is its own state. |
| `inspect_api` | Methods and fields of any live value (walks metatables). |
| `scan_api` / `search_api` | Full API catalog per state, saved to `companion/data/api-catalog/`, searchable. |
| `search_game_scripts` / `read_game_file` | Firaxis' own scripts: real call shapes and which state a call works in. |
| `save_ability` | Lua that worked becomes a permanent tool `ability__<name>` (test-run before saving). |
| `remember_api_fact` | Verified API facts in `companion/data/knowledge.md`, fed back into the prompt. |

`companion/data/abilities/` and `knowledge.md` are tracked in git on purpose:
they are what the copilot taught itself, and the next agent inherits them.

## Environment (this machine)

| Thing | Path / value |
|---|---|
| Repo | `%USERPROFILE%\Documents\civ6-copilot` (local git; no remote yet) |
| Game | `D:\SteamLibrary\steamapps\common\Sid Meier's Civilization VI` (Steam app 289070, DX12 exe) |
| Mods folder | `%USERPROFILE%\Documents\My Games\Sid Meier's Civilization VI\Mods\AICivCopilot` (a copy - re-run `scripts\install.ps1`) |
| AppOptions.txt | `%LOCALAPPDATA%\Firaxis Games\Sid Meier's Civilization VI\AppOptions.txt` (original backed up as `.bak-aiciv`) |
| Logs | `%LOCALAPPDATA%\Firaxis Games\Sid Meier's Civilization VI\Logs\` - `Lua.log`, `Modding.log`, `Startup.log` |
| Saves | `%USERPROFILE%\Documents\My Games\Sid Meier's Civilization VI\Saves\Single\auto\` |
| API key | user-level env var `ANTHROPIC_API_KEY`; `scripts\start-bridge.ps1` reads it. Never print it. |
| Model | `claude-fable-5-1` by default (`AICIV_MODEL`), effort `high` (`AICIV_EFFORT`), server-side refusal fallback on (`AICIV_FALLBACKS=0` to disable). The owner's standing preference is Fable. |

## Verified live (2026-10-03, Hungary save, turn 271)

- The tuner handshake (`APP:`, `LSQ:`) and `CMD:` execution work exactly as in
  `lib/tuner.mjs`. The JSON prelude, chunked output, and decoding work against
  the real game.
- At the main menu there are 32 Lua states, one per UI screen (`MainMenu`,
  `Mods`, `LoadGameMenu`, `FrontEnd`, ...). Main-menu state names are not
  the in-game ones; `InGame` and `GameCore_Tuner` only exist with a game loaded.
- `Modding.GetInstalledMods()` in the `Mods` state lists our mod; a newly
  installed mod is enabled by default.
- `OnResumeGame()` in the `MainMenu` state loads the most recent save - the
  same function as the Resume button. `g_MostRecentSave` describes it first.
- The mod's `AddUserInterfaces` and `ImportFiles` components apply on load
  (see `Modding.log`).

## The 2026-10-04 crash - read this before touching a live game

A test workflow ran 13 agents against the owner's live game at once, each with
its own tuner connection. Under that load `LSQ:` intermittently returned an
empty state list, and about ten minutes in the game died with
`EXCEPTION_ACCESS_VIOLATION` (no crash dump, no Lua error). The call in flight
with no reply was a discovery probe doing
`RiverManager.GetRiverByIndex(_ - 1, 'plots')` with `_` taken from `pairs()`
over `RiverManager.EnumerateRivers()` - an index the engine never promised was
valid. Native functions do not bounds-check. Nothing was lost: no save had
happened since the load, so every test edit died with the process.

What changed because of it:

- **One caller at a time, machine-wide.** `TunerLock` (a lock file in the temp
  dir, per tuner port) wraps every handshake and command in every process.
  Dead or overrunning holders are evicted.
- **Write-ahead in-flight log.** Every call is recorded in
  `companion/data/inflight.jsonl` before it is sent and closed out when it
  finishes. After a crash, `node cli/civ.mjs inflight` lists exactly what was
  running; the bridge logs it when the connection drops.
- **The model is told** that bad native calls crash the game (system prompt
  rule 8), and the seeded `knowledge.md` records this incident.
- **Testing policy:** never fan out agents that all talk to the owner's live
  game. Game access goes through one agent at a time (the lock now enforces it
  anyway); parallel agents may only do offline work (code, shipped scripts,
  saved catalogs).

## Traps that already cost time

- **The tuner port moves.** After loading a save from the main menu the game
  re-bound the tuner on **4319**, not 4318. `TunerClient.connect` scans 4318-4323
  (`CIV6_TUNER_PORT_SCAN`) and keeps whichever answered.
- **The load screen does not service the tuner.** After a load the game sits on
  the load screen until someone clicks the continue button; meanwhile it accepts
  TCP connections but never reads them (they pile up in CLOSE_WAIT). Nothing
  over the tuner can press that button - a person (or screen automation, if the
  owner allows it) has to.
- **Frames arrive in bursts.** Several tuner frames often share one TCP chunk.
  The first version dropped every frame after the first in a burst; frames are
  now buffered in `TunerClient.inbox`. A regression test covers it.
- **Print noise.** Other scripts print into the same stream. Every call gets a
  nonce; only lines tagged `@@<nonce>|` are collected.
- **Havok Script is Lua 5.1.** No `goto`, no `//`, no bit operators, and
  `return` must be the last statement of a block. `test/lua-syntax.test.mjs`
  parses every script exactly as it is sent.
- **`CanStart*` signatures are overloaded.** Mirror `Panels/UnitPanel.lua`:
  operations `(unit, hash, nil, params, true)` for results, `(unit, hash, nil,
  false, false)` for "startable now"; commands `(unit, hash, params, true)` and
  `(unit, hash, false)`.
- **`Keys.A` is never referenced by shipped scripts**, so the panel compares
  against `(Keys.A or 65)`.
- **Research/civic choice can wipe the player's plan.** `VALUE_EXCLUSIVE`
  replaces the whole queue (a test erased a 7-civic queue). `set_research` /
  `set_civic` now send the game's own path (`GetResearchPath`/`GetCivicPath`, so
  far targets work) with `mode` front (default: target now, old queue after),
  replace (a click) or append (shift-click).
- **Read-backs race the game.** A single read 450 ms after a request sometimes
  missed a change that landed a moment later; play actions now re-read up to 4
  times (350/500/800/1200 ms).
- **No `_G`.** Havok Script 2013.2 has no `_G`, `getfenv`, `rawget`, `debug`,
  `require`, `io` (`loadstring` and `os` exist). `scan_api` harvests names from
  the shipped scripts and resolves each with `loadstring`.
- **Every emitted line is also written to `Lua.log`.** A snapshot adds ~20 KB.
- **The game speed lives in `GameConfiguration`.** `Game.GetGameSpeedType` does
  not exist in InGame; unit activity is an `ActivityTypes` enum value.

## Layout

| Path | What |
|---|---|
| `companion/lib/tuner.mjs` | FireTuner wire protocol, port scan, nonce-tagged exec |
| `companion/lib/game.mjs` | Lua states, script loading, param injection (`toLua`), JSON decoding |
| `companion/lua/prelude.lua` | JSON encoder, `emitJson` (chunked), `try` (named gaps), `L` |
| `companion/lua/snapshot.lua` | Whole-empire read in `InGame` |
| `companion/lua/actions.lua` | Every typed action + its read-back |
| `companion/lua/inspect.lua`, `apiscan.lua` | API discovery |
| `companion/lua/plots.lua` | Tiles around a point |
| `companion/lib/actions.mjs` | Action catalog: schema, state, play vs edit, read-back flow |
| `companion/lib/solvers.mjs` | Deterministic answers + the lean payload the model starts with |
| `companion/lib/tools.mjs` | Tool schemas and dispatch |
| `companion/lib/memory.mjs` | Abilities, knowledge, API catalogs, write journal |
| `companion/lib/gamefiles.mjs` | Search Firaxis' shipped scripts |
| `companion/lib/agent.mjs` | Model loop (official Anthropic SDK, streaming, manual tool loop) |
| `companion/server.mjs` | Bridge daemon: connect/reconnect, panel polling, HTTP API |
| `companion/cli/civ.mjs` | CLI |
| `mod/AICivCopilot/` | The in-game panel |
| `scripts/install.ps1` | Copy the mod, enable the tuner (with backup), npm install |
| `scripts/start-bridge.ps1` | Start the bridge with the user-level API key |

## Open

- The in-game panel has not been seen on screen yet (the owner declined screen
  control during the first live session); its layout offsets are a first guess.
- The hex-distance helper in `solvers.mjs` assumes an odd-row offset layout and
  is used only for ranking; verify against `Map.GetPlotDistance` and fix if
  needed.
- `make_peace`: `MakePeaceWith` was confirmed to exist on GameCore
  `Players[id]:GetDiplomacy()` by the live catalog; its argument shape (just the
  other player id?) is still unverified - check shipped scripts before using it.
- The full live test of play/edit actions and the expansion phase were cut short
  by the crash; rerun them one agent at a time.

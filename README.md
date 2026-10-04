# AI Civ Copilot

<https://github.com/Smeagol69/ai-civ-copilot>

An AI assistant inside your running game of Sid Meier's Civilization VI. Ask it
about your empire, or tell it to change the game. It has full read and write
access and grows its own toolset as it learns the game's API.

## What it can do

- **Answer from the live game:** yields, production, research paths, threats,
  rivals, any tile or city. Numbers come from the game, not guesses.
- **Play for you:** set production, buy items, pick research and civics, move
  units, run any unit operation or command, end the turn. These go through the
  game's own checks, exactly like a click, and are confirmed by reading the game
  back.
- **Edit the game:** gold, faith, techs, civics, finish production, population,
  spawn/kill/heal units, XP, moves, terrain/feature/resource/improvement, reveal
  the map, meet players, war and peace.
- **Do anything else:** run arbitrary Lua in any of the game's Lua states.
- **Dig for new features:** map every function the game exposes, find what can change the game (Firaxis' own cheat panels show the way), prove it safely and save it as a new button - one click per discovery.
- **Plan to win:** where you stand on every road to victory, your strongest road, the rival to watch, and trends turn by turn.
- **Teach itself:** inspect live objects, catalog the whole API, search
  Firaxis' own scripts for real usage, then save working Lua as a permanent new
  ability. Verified API facts are remembered across sessions.

## Set up

```powershell
# Close Civ VI first, then:
.\scripts\install.ps1        # copies the mod, enables the tuner (backs up AppOptions.txt), installs Node deps
.\scripts\start-bridge.ps1   # starts the bridge (leave this window open)
```

Launch Civ VI, check **AI Civ Copilot** is enabled under Additional Content, and
load a game. Press **Ctrl+Shift+A** (or the **AI** button at the top right) and
ask. Type `new` to start a fresh conversation.

Requires Node 20+ and `ANTHROPIC_API_KEY` (user environment variable). The
default model is Claude Fable 5.1; set `AICIV_MODEL` to change it.

## From outside the game

```powershell
cd companion
node cli/civ.mjs status
node cli/civ.mjs ask "which city should build the next campus?"
node cli/civ.mjs summary
node cli/civ.mjs action change_gold '{\"amount\":500}'
node cli/civ.mjs lua InGame "emit(Game.GetCurrentGameTurn())"
node cli/civ.mjs scan GameCore_Tuner     # catalog the API for search_api
```

Add `--direct` to talk to the game without the bridge running.

## Safety notes

- The tuner socket only listens on 127.0.0.1, but anything on this PC can run
  Lua in your game while `EnableTuner 1` is set. Restore
  `AppOptions.txt.bak-aiciv` (or set `EnableTuner 0`) to turn it off.
- Direct edits can break a save. Keep a manual save before large experiments.
- Every write is logged in `companion/data/journal.jsonl` with the game's own
  before/after values.

See `AGENTS.md` for architecture, rules, and traps.

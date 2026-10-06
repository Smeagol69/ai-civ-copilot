// When the copilot may change the game.
//
// In a multiplayer game with other people every player runs their own copy
// of the simulation (network games) or plays real opponents (Play By Cloud):
// a direct edit desyncs the game or cheats against real players. The bridge
// then locks everything but the UI states (game.coreLocked, see game.mjs).

export const MP_LOCK = "This is a multiplayer game with other people. Edits are switched off here: each player runs their own copy of the game, so a direct edit desyncs everyone (and would be cheating against real players). Advice and your normal moves still work.";
export const CLOUD_LOCK = "This is a Play By Cloud game with other people. Edits are switched off here: they would be cheating against real players. Advice and your normal moves still work.";
// Until a poll says what kind of game this is, assume the strictest.
export const UNKNOWN_LOCK = "The copilot has not yet seen what kind of game this is; edits wait until it has.";

// factsOk only claims the getters' own pcalls succeeded - it says nothing
// about whether they actually returned real booleans. A value that
// round-tripped through JSON as something else (nil -> null/undefined, a
// stray number, an empty string) is not a confirmed fact either, even
// though some such values happen to coerce "safely" by accident; the type
// itself is the only reliable signal that the read produced what it
// claims to. A missing factsOk (every caller before that field existed)
// is treated as reliable, so this stays backward compatible with callers
// that only ever passed well-typed booleans. Both multiplayerLock and
// game.mjs's #ensureCoreLockEstablished need this same judgment call, so
// it lives here once.
export function hasReliableFacts(poll) {
  return !!poll && poll.factsOk !== false && typeof poll.mp === "boolean" && typeof poll.cloud === "boolean";
}

// poll: { mp, cloud, humans, factsOk } read in the game (GameConfiguration).
// Returns the lock text, or null when edits are allowed. A poll without the
// facts keeps the current lock - and so does one that is not reliable
// (hasReliableFacts): both server.mjs's POLL_LUA and game.mjs's
// MP_FACTS_LUA default mp/cloud to false and would otherwise look identical
// to a confirmed single-player read, which could unlock (or un-stick an
// already-locked) multiplayer game on a read that never actually happened.
//
// "Keep the current lock" is only safe when current is already
// restrictive. If current is null - a *previous* reliable read confirmed
// single player - that confirmation does not keep being true on its own;
// losing the ability to re-verify it must mean "unknown" again, not "still
// trusted", or a core edit could land while the real status is genuinely
// unverified. current || UNKNOWN_LOCK keeps any existing restrictive lock
// exactly as before and only changes the null case.
export function multiplayerLock(poll, current) {
  if (!poll || poll.mp === undefined) return current;
  if (!hasReliableFacts(poll)) return current || UNKNOWN_LOCK;
  // Not networked: one machine, nothing to desync. Networked with an unknown
  // or unparseable head-count: assume other people are there, the same
  // conservative default as the documented undefined/null case.
  const shared = poll.mp || poll.cloud;
  const humansCount = Number(poll.humans);
  const unknownHumans = poll.humans === undefined || poll.humans === null || !Number.isFinite(humansCount);
  const others = shared && (unknownHumans || humansCount > 1);
  if (!others) return null;
  return poll.cloud ? CLOUD_LOCK : MP_LOCK;
}

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
// is deliberately excused, so this stays backward compatible with callers
// that only ever passed well-typed booleans - but that is not the same as
// a *present but malformed* marker (null, 0, a stray string): only an
// explicit true, or no marker at all, counts as reliable. Both
// multiplayerLock and game.mjs's #ensureCoreLockEstablished need this same
// judgment call, so it lives here once.
export function hasReliableFacts(poll) {
  return !!poll && (poll.factsOk === undefined || poll.factsOk === true) && typeof poll.mp === "boolean" && typeof poll.cloud === "boolean";
}

// Stricter than hasReliableFacts: requires factsOk to be the explicit
// boolean true - an omitted marker does not count here either.
// hasReliableFacts's leniency toward a missing factsOk exists for backward
// compatibility with callers (and tests) that predate the field - game.
// mjs's own direct reads always explicitly set factsOk one way or the
// other, so there is no legacy-caller case there, and anything other than
// an explicit true (omitted, null, 0, or any other value reaching this
// point) must not count as a confirmed read worth marking "established" on.
export function isConfirmedFacts(poll) {
  return poll?.factsOk === true && typeof poll.mp === "boolean" && typeof poll.cloud === "boolean";
}

// poll: { mp, cloud, humans, factsOk } read in the game (GameConfiguration).
// Returns the lock text, or null when edits are allowed. A poll without
// reliable facts (hasReliableFacts - covers a poll missing entirely, one
// missing mp, or one whose mp/cloud are not real booleans) keeps the
// current lock, falling back to UNKNOWN_LOCK rather than null: both
// server.mjs's POLL_LUA and game.mjs's MP_FACTS_LUA default mp/cloud to
// false and would otherwise look identical to a confirmed single-player
// read, which could unlock (or un-stick an already-locked) multiplayer
// game on a read that never actually happened.
//
// "Keep the current lock" is only safe when current is already
// restrictive. If current is null - a *previous* reliable read confirmed
// single player - that confirmation does not keep being true on its own;
// losing the ability to re-verify it must mean "unknown" again, not "still
// trusted", or a core edit could land while the real status is genuinely
// unverified. current || UNKNOWN_LOCK keeps any existing restrictive lock
// exactly as before and only changes the null case.
export function multiplayerLock(poll, current) {
  if (!hasReliableFacts(poll)) return current || UNKNOWN_LOCK;
  // Not networked: one machine, nothing to desync. Networked with an
  // unknown or unparseable head-count: assume other people are there, the
  // same conservative default as the documented undefined/null case.
  // typeof must be checked directly - Number("") and Number(false) are
  // both the finite number 0, which would otherwise read as a confirmed
  // "alone" headcount instead of "not actually a count".
  const shared = poll.mp || poll.cloud;
  const unknownHumans = poll.humans === undefined || poll.humans === null || typeof poll.humans !== "number" || !Number.isFinite(poll.humans);
  const others = shared && (unknownHumans || poll.humans > 1);
  if (!others) return null;
  return poll.cloud ? CLOUD_LOCK : MP_LOCK;
}

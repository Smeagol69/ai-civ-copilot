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

// poll: { mp, cloud, humans } read in the game (GameConfiguration).
// Returns the lock text, or null when edits are allowed. A poll without the
// facts keeps the current lock.
export function multiplayerLock(poll, current) {
  if (!poll || poll.mp === undefined) return current;
  const shared = !!(poll.mp || poll.cloud);
  // Not networked: one machine, nothing to desync. Networked with an unknown
  // head-count: assume other people are there.
  const others = shared && (poll.humans === undefined || poll.humans === null || Number(poll.humans) > 1);
  if (!others) return null;
  return poll.cloud ? CLOUD_LOCK : MP_LOCK;
}

# Game kit

This page owns `game-kit` and `platform-client`: game-facing modules and the
platform clock. The service repository's `docs/game-kit-design.md` owns the
shared behavior and wire contract. Package READMEs carry the detailed options.

## Start with one session

```ts
import { createGameKit } from "@yingyeothon/game-kit";
const kit = createGameKit({ config: kitConfig });
await kit.session.fromToken(channelJwt);
const tuning = await kit.content.get("tuning");
await kit.save.update<{ level: number }>("progress", (previous) => ({
  ...previous,
  level: 2,
}));
```

The config is the public block printed by `yyt project kit-config`. Collection
values are console names, and their keys are game aliases. Missing modules fail
on first use instead of construction. The session token stays in memory unless
the host explicitly supplies secure storage. Reading JWT metadata in
`fromToken` is not signature verification; the service verifies every request.
For browser OAuth use `session.signIn` with an allowed callback URL; see
[Authentication](auth.md) and [auth-client](../packages/auth-client/README.md).

`session.now()` uses platform time and monotonic elapsed time, even with a
wrong device wall clock. It is in milliseconds; `expiresAt` is in seconds.
Until a `/time` read succeeds, `now()` fails rather than inventing a time.
Listen for `expiring` to offer sign-in again and for `signedOut` to replace the
game screen. A 401 stops every module. Wire browser visibility or mobile
lifecycle into `setForeground`; call `dispose` when the game is destroyed.

## Save without losing another writer

`load` retains a version; `store` and `update` use it for conditional writes.
A collision reports `conflict` unless a merge policy combines local and remote
values. `counter(name).add(delta, { min, max })` guards the result on the server.
`claimOnce(name, ttl)` creates a TTL-bound marker once, without a racing
read-before-write. These are game conveniences over [the key-value store](kvstore.md).

Offline store/remove is opt-in with a durable queue adapter. Queue only after
reading a base, register save-name merge policies again when restoring, and
call `flush` on connectivity recovery. The adapter's namespace separates users;
a new login cannot replay the previous user's saves. An unresolved conflict
stops the queue with the pending record retained. Claims and counters require
an online response because replaying them could apply an effect twice.

Content keeps published values in memory. Subscriptions compare entry ETag
versions using full GETs, because the current server has no 304 reads. The
`content.pollIntervalMs` default is 60000 and polling pauses in the background.

## Share a host room

```ts
kit.room.on("invited", (invitation) => {
  // The game presents invitation.accept() and invitation.decline().
});
kit.room.becomeHost(({ lastKnown }) => resumeSimulation(lastKnown));
await kit.room.create();
await kit.room.invite(friendId);
await kit.room.state.publish(snapshot);
```

The party leader is the host by agreement. Members retain its most recent
snapshot, reconnecting members request it automatically, and a successor
receives that last state. This does not make host decisions trustworthy rewards.
Only publish full states that fit the 8192-byte envelope including kit metadata;
use game-defined delta events for larger states.

## Replay a turn game

```ts
const game = kit.turns.start({
  room: kit.room,
  initial: initialState,
  apply: (state, move, by) => applyLegalMove(state, move, by),
  persist: true,
  saveResultAs: "last-game",
});
game.on("mismatch", () => showDesync());
await game.submit(move);
```

All players use the same initial state, player order and pure `apply`. Move
hashes make disagreement observable; they do not arbitrate who is right. A
mismatch freezes the game. Reconnection validates a complete log before
replacing state, with large logs split into paced chunks. Persistence commits
immutable chunks before their manifest, so incomplete revisions cannot appear
as a complete game. Only the host finishes; every player's result is its own
save copy. Clocks are informational and do not enforce time controls.

## Leaderboards and mail

Board aliases resolve through config's boards mapping. Submit a score to every
server-configured period and display the returned server rank and endsAt; use
session.now for countdowns. A server-only board returns server_only. Around clamps
at the first rank and returns an empty page for an unranked player.

Mail reads the signed-in inbox and its platform writer stamps. Claim uses a
conditional delete that also refuses a missing row, so exactly one concurrent caller gets the letter; that caller
applies its reward. Missing or concurrently claimed mail returns already_claimed.
Player send requires a project-writable inbox; caps map to inbox_full. Arrivals
are emitted only after complete pagination. Mail and friend-request polling use
30-second defaults and pause in background.

## Friends and matchmaking

Friends combines state relations with gateway presence. Profile and presence
batches contain at most 50 players, and profile cache lasts 30 seconds per session.
Blocking retains the service's visibility rules; invite reports offline before
trying the room invitation.

Live matching requires a connected lobby. Callback-less matching forms one room:
the lowest matched user creates it, matched members accept only each other's
invites for 30 seconds, and an incomplete room yields partial with the joined
roster. Set matchmaking.callback explicitly for a callback channel; a null result
alone cannot distinguish one. Missing match mode means live.

Deferred matching needs no lobby. Submit, status, accept, decline and cancel use
HTTP tickets; stateChanged carries waiting/proposed/confirmed/expired/declined/failed.
Foreground polling defaults to four seconds. Push and resume discover tickets,
with reads coalesced at a one-second minimum gap. Cooldown uses server retryAfter,
confirming waits 1.5 seconds, and throttles back off to 30 seconds. State conflicts
cause a status read rather than another submission.

## Android push lifecycle

The app owns the FCM SDK and supplies the token and topic adapter. Registration
subscribes to the configured topic. Sign-out cleans up using the old JWT and token,
and failures cannot prevent local sign-out. Classification verifies the match
channel; even an expired hint with an empty matchId only requests a status read.
A topic message grants nothing. The [push guide](push.md) owns standalone client
registration and server sending.

All new asynchronous modules isolate session generations and cancel observers,
polls or retries on sign-out/dispose. Missing optional config fails on module use.

## Run the scenarios locally

[The game-kit example](../examples/game-kit/README.md) demonstrates time, merge,
claims, bounds, invitations, shared state, host succession and a two-player
turn log against in-memory auth/state/gateway fakes. It needs no AWS credentials,
Docker, deployed gateway or real tokens. Its smoke test imports built workspace
packages and covers scenarios 5–10: board submission, exactly-once mail claim,
friendship/presence, live room formation, deferred confirmation and push cleanup. The package tests also cover reconnect, tampered turns, durable queue
restoration, user-switch races and partial log revisions.

For every option and limit, read [game-kit](../packages/game-kit/README.md) and
[platform-client](../packages/platform-client/README.md). Next:
[The realtime client](realtime-client.md) owns the underlying socket behavior.

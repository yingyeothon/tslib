# Troubleshooting

Symptom first, because that is what you have. Almost everything below fails
**silently** — no exception, no log line — which is why the symptom is usually
"nothing happened" rather than an error.

One cause, one check, one link each. The explanation lives on the page that owns
it.

## The actor never receives anything, and nothing errors

**Your queue key is not the one the actor drains.** `createRedisSubsystem`
appends a `queue:` segment to its prefix; `createActorSubsystem` and
`handleConnect` do not.

Check the exact key with
[`examples/gateway-contract`](../examples/gateway-contract/README.md), then
compare it with what your producer writes.
[Actor system § The Redis layouts](actor-system.md#the-redis-layouts-and-the-queue-segment)

## `poll()` returns items that are all undefined

**You pushed a bare payload instead of a `UserMessage` envelope.**

Check that the pushed JSON has `messageId`, `awaitPolicy`, `awaitTimeoutMillis`
and `item`, and that `awaitPolicy` is the number `0`.
[Game actor § The inbound envelope](game-actor.md#the-inbound-envelope)

## Replies arrive but broadcasts never do

**Your gateway reads `command.connectionId` and branched on `op`.** A broadcast
publishes `connectionIds` instead, so that field is `undefined` and the frame is
dropped.

Check that the consumer branches on whether `connectionIds` is present.
[Game actor § The outbound command](game-actor.md#the-outbound-command)

## The first frames of a run are missing

**You subscribed after the first push.** Outbound is pub/sub and has no
redelivery.

Check the order: `SUBSCRIBE` the outbound channel before the first `RPUSH` for
that `gameId`.
[Game actor § The three Redis keys](game-actor.md#the-three-redis-keys)

## The game ends and the party never sees the result

**`endRepeatCount` is 1 over a gateway transport.** The end frame is published
exactly once; a subscriber gap swallows it and nothing later heals it.

Set it to 2 or more with `createRedisPubSubTransport`.
[Game actor § Ending so the party hears about it](game-actor.md#ending-so-the-party-hears-about-it)

## The last frame is lost exactly as the socket closes

**`endDropDelayMillis` is 0.** API Gateway can lose a message posted immediately
before `DeleteConnection`.

Leave it at its default of 1000.
[Game actor § Ending so the party hears about it](game-actor.md#ending-so-the-party-hears-about-it)

## Everyone is dropped at the end of a run

**You paired `dropUndeliveredConnections` with `createRedisPubSubTransport`.**
That transport's boolean means "a gateway was subscribed", not "the client
received it", so a gateway restart evicts the whole party.

[Game actor § Ending so the party hears about it](game-actor.md#ending-so-the-party-hears-about-it)

## Messages sent before the game starts are ignored

**The wait stage drains the queue for `enter` and `leave` and discards
everything else.** This is by design; a client cannot act before the game runs.

[Game actor § Wait, running, end](game-actor.md#wait-running-end)

## Every Redis command answers NOPERM

**Your prefix is outside the ACL's pattern**, usually because it was retyped
rather than copied.

Copy the prefixes from the console as one block.
[Operations § Key prefixes and the Redis ACL](operations.md#key-prefixes-and-the-redis-acl)

## Writes succeed but nothing can find the key afterwards

**Your prefix is inside the ACL but still wrong.** A retyped prefix usually
stays within the pattern, so it does not fail at all — and key enumeration is
denied, so you cannot search for what you wrote.

[Operations § Key prefixes and the Redis ACL](operations.md#key-prefixes-and-the-redis-acl)

## Two actors are simulating the same game

**No heartbeat.** The lease expired mid-run and a second invocation acquired it.

Pass `lockRenewIntervalMillis` whenever the lease is shorter than the work.
[Actor system § The lease, and why a short one is safe](actor-system.md#the-lease-and-why-a-short-one-is-safe)

## `createRedisQueue` throws at startup

**`ttlSeconds` is missing, zero, or fractional.** `EXPIRE` takes whole seconds,
so a fraction would floor to 0 and delete the key after every push.

[Operations § Every TTL](operations.md#every-ttl)

## The actor never restarts after a crash

**`createRedisLock` was given no `lockTimeout`**, so the lease never expires and
the dead holder owns the actor forever.

[Operations § Every TTL](operations.md#every-ttl)

## `repository-redis` `set()` throws

**By design.** Every key carries a TTL.

Call `setWithExpire`, or pass `expiresInMillis` to `compareAndSet` and to the
document factories.
[Storage § Redis refuses a write with no TTL](storage.md#redis-refuses-a-write-with-no-ttl)

## `compareAndSet` keeps returning false

**You are retrying with the value you already had.** A retry must re-read: the
token you hold is the one that just lost.

[Storage § Revisions and compare-and-set](storage.md#revisions-and-compare-and-set)

## One writer's changes keep disappearing

**Your backend has no conditional write**, so documents are last-writer-wins and
there is no silent fallback pretending otherwise.

Check with `isCasRepository`, or serialize the writers behind an actor lock.
[Storage § Revisions and compare-and-set](storage.md#revisions-and-compare-and-set)

## The client connects, then stops after about five tries

**The handshake is being refused** — an expired token, a wrong channel, a
deleted channel. A browser cannot tell 401 from 404 here, so the SDK stops
rather than retrying a dead token forever.

[Realtime client § The connection state machine](realtime-client.md#the-connection-state-machine)

## A `pos` frame is refused as `bad_message`

**`dir` is a number.** It is an opaque string of at most 16 bytes, and Go parses
the field as a string, so the whole frame is rejected.

[Realtime client § Two wire details that silently drop a frame](realtime-client.md#two-wire-details-that-silently-drop-a-frame)

## Other players never move

**Your `pos` frame has no `zone`.** Frames for another zone are ignored, so it
never reaches the peer map and the peer stays where the snapshot put it.

[Realtime client § Two wire details that silently drop a frame](realtime-client.md#two-wire-details-that-silently-drop-a-frame)

## A retry after a run was aborted is refused

**Close 4001 means the actor died and the gateway deleted the queue key.** The
old `gameId` is gone for good.

Allocate a new one.
[Realtime client § Close codes](realtime-client.md#close-codes)

## The authorizer works on REST and not on `$connect`

**A WebSocket API accepts only a REQUEST authorizer**, and only there.

Use `createJwtRequestAuthorizer`.
[Authentication § TOKEN or REQUEST is decided by the API, not by preference](auth.md#token-or-request-is-decided-by-the-api-not-by-preference)

## The browser aborts the handshake even though the authorizer allowed it

**Your `$connect` integration did not echo the selected subprotocol.**

Pass `selectSubprotocol` to `handleConnect`.
[Authentication § `$connect`, end to end](auth.md#connect-end-to-end)

## A revoked or expired token still gets in

**The authorizer's result cache is on.** A cached allow outlives the credential.

Set the `$connect` cache TTL to 0.
[Authentication § Set the `$connect` cache TTL to 0](auth.md#set-the-connect-cache-ttl-to-0)

## Lambdas start failing on database connections

**`reservedConcurrency` is unset somewhere.** Each container pins a connection
and a frozen one keeps it.

[Operations § The concurrency ceiling](operations.md#the-concurrency-ceiling)

## A run dies at fifteen minutes

**That is the Lambda ceiling**, and a game is capped at one invocation.

Budget the run well under it.
[Operations § Sizing a run](operations.md#sizing-a-run)

## Every command times out after a Redis restart, until the container recycles

This one is **fixed**, and the fix is in `naive-redis`: the socket is dropped on
`-NOAUTH` or `-WRONGPASS` and the command is retried once. If you see it, you
are on an old version.

[Redis and sockets § When authentication fails](redis-and-sockets.md#when-authentication-fails)

## Still stuck

Read the page that owns the area — the guide [index](README.md) routes by task —
and then the package README, whose `## Migrating from the legacy package` and
`## Behavior changes` sections are where a surprise usually already has a name.

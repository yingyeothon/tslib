# gateway-contract

The **gateway half** of the actor bridge: what a WebSocket gateway must push,
where it must push it, and what it must handle coming back. Runs with no Redis;
`YYT_EXAMPLE_REDIS_HOST` runs the same code against a real one.

The deployable counterpart is the `q` channel in the `service` repository's Go
gateway. This example exists because all three mistakes below **fail silently** —
no exception, no log line, just a game that never sees an input or a party that
never sees a frame.

```bash
pnpm --filter yyt-example-gateway-contract start
```

```
queue key the actor drains:  game:dev:demo:queue:bridge-1
channel to subscribe first: game:out:dev:demo:bridge-1
  inbound is a durable list, outbound pub/sub is lossy, so the
  subscribe must happen before the first push or frames vanish
  a UserMessage envelope -> [{"type":"move","connectionId":"c1","x":3}]
  a bare payload         -> [undefined]
    ^ one undefined, no error: the game simply never sees it
outbound, both send shapes:
  -> c1  {"type":"stage"}
  -> c1,c2  {"type":"tick"}
  closed: c2
```

## 1. The inbound value is an envelope, not a payload

`RPUSH` a `UserMessage<T>`, which is what `enqueue` writes:

```json
{
  "messageId": "61f2e6f5-…",
  "awaitPolicy": 0,
  "awaitTimeoutMillis": 0,
  "item": { "type": "move", "connectionId": "c1", "x": 3 }
}
```

`awaitPolicy` is a **numeric** enum and `AwaitPolicy.Forget` is `0` — a gateway
pushes and moves on. Push the payload by itself and `poll()` hands the game an
array of `undefined` items, which is the second line of output above.

`item` is the game's own message, stamped with the `connectionId` it came from.
`enter` and `leave` are reserved: the actor decides which member a connection
speaks for from them, so a gateway synthesises them itself and refuses them from
clients.

## 2. The key has no `queue:` segment

The actor drains `{queueKeyPrefix}{gameId}` and nothing else.
`createRedisSubsystem` appends a `queue:` segment to the prefix it is given;
`createActorSubsystem` in `lambda-gamebase` and `handleConnect` do **not**. A
gateway that copies the subsystem layout pushes into a key nobody reads.

Verified against a real Redis — the key, its TTL, and the bytes:

```
$ redis-cli keys '*'
game:dev:demo:queue:bridge-1
$ redis-cli ttl game:dev:demo:queue:bridge-1
60
```

The TTL is the producer's job. The actor only drains, so the `ttlSeconds` on
`createRedisQueue` is required and re-applied on every push: a queue abandoned
by a dead actor must expire, and on a shared `allkeys-lru` Redis a key that
never expires evicts someone else's first.

`push` resolves the list depth, which `RPUSH` returns for free — that is how a
gateway notices the actor stopped consuming without a second round trip.

## 3. There are two `send` shapes, and `op` does not separate them

```json
{ "op": "send", "connectionId": "c1", "message": { … } }
{ "op": "send", "connectionIds": ["c1", "c2"], "message": { … } }
{ "op": "drop", "connectionId": "c2" }
```

`reply` publishes the first, `broadcast` the second so the gateway does the
fan-out it is already positioned to do — at eight players and a fixed tick that
is one publish per tick instead of eight. **Branch on whether `connectionIds` is
present**, not on `op`: a gateway reading `command.connectionId` alone gets
`undefined` for every broadcast and drops the frame.

## Ordering: subscribe before you push

Inbound is a durable Redis list, so the gateway may push before the actor is
running. Outbound is pub/sub, so a publish with no subscriber is simply lost.
Nothing bridges that asymmetry except order:

> Subscribe to `{channelPrefix}{gameId}` **before** pushing the first inbound
> message for that `gameId`, and unsubscribe when its last connection closes.

That is sufficient because the actor learns connection ids only from `enter`, so
it cannot publish before the first inbound message exists.

`RPUSH` is **not** a trigger — pushing does not start a Lambda. The actor is
invoked explicitly, and `readyCall` is the handshake that says the loop is up.

## Against a real Redis

```bash
docker run --rm -d -p 6399:6379 redis:7-alpine
YYT_EXAMPLE_REDIS_HOST=127.0.0.1 YYT_EXAMPLE_REDIS_PORT=6399 \
  pnpm --filter yyt-example-gateway-contract start
```

Namespaced on purpose: a plain `REDIS_HOST` is already exported to a real store
in the environments this repository is developed in.

## Read next

[`@yingyeothon/lambda-gamebase`](../../packages/lambda-gamebase/README.md), whose
`## Gateway integration contract` is the normative version of this page, and
[`@yingyeothon/actor-system-redis`](../../packages/actor-system-redis/README.md)
for the queue, lock and awaiter layouts.

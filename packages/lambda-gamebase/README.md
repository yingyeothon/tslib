# @yingyeothon/lambda-gamebase

Serverless WebSocket game framework on AWS Lambda: an actor-based game loop backed by Redis, API Gateway WebSocket connection handling (`$connect`, `$disconnect`, `$default`), broadcasting/replying to connections, and the base game context/user/observer models shared by game implementations.

## Install

```bash
npm install @yingyeothon/lambda-gamebase
```

AWS SDK v3 clients are peer dependencies:

```bash
npm install @aws-sdk/client-apigatewaymanagementapi @aws-sdk/client-lambda
```

Library code never reads `process.env`. Configuration is injected as a `GamebaseOptions` object; the `gamebaseOptionsFromEnv()` helper reads the documented variables (`REDIS_HOST`, `REDIS_PORT`, `REDIS_USER` (ACL user, optional), `REDIS_PASSWORD` (optional), `REDIS_TLS` (any non-empty value wraps the Redis connection in TLS; unset is cleartext), `WS_ENDPOINT` (API Gateway management endpoint), `GAME_ACTOR_LAMBDA_NAME`, and `IS_OFFLINE` for serverless-offline development) if you want to keep configuring via environment.

## Usage

ESM:

```ts
import {
  broadcast,
  createGamebaseContext,
  gamebaseOptionsFromEnv,
  handleActor,
  handleConnect,
  handleDisconnect,
  handleMessages,
  setupBaseGameContext,
  type BaseGameRequest,
  type GameActorStartEvent,
} from "@yingyeothon/lambda-gamebase";
import type { APIGatewayProxyEvent } from "aws-lambda";

// One context per Lambda container: it owns the lazily created shared
// Redis connection and API Gateway management client.
const context = createGamebaseContext(gamebaseOptionsFromEnv());

// Game actor Lambda: runs the game loop as an actor.
export async function actor(event: GameActorStartEvent) {
  await handleActor<BaseGameRequest>({
    event,
    context,
    eventKeyPrefix: "game:event:",
    awaiterKeyPrefix: "game:awaiter:",
    queueKeyPrefix: "game:queue:",
    lockKeyPrefix: "game:lock:",
    lifetimeSeconds: 300,
    gameMain: async ({ gameId, members, pollMessages }) => {
      const gameContext = setupBaseGameContext(members);
      const messages = await pollMessages();
      await broadcast(
        Object.keys(gameContext.connectedUsers),
        { type: "tick" },
        { context },
      );
    },
  });
}

// WebSocket $connect handler. `resolveMemberId` and `selectSubprotocol`
// are what make this safe to expose — see Security below.
export const connect = (event: APIGatewayProxyEvent) =>
  handleConnect({
    event,
    context,
    connectionIdAndGameIdKeyPrefix: "game:conn:",
    actorEventKeyPrefix: "game:event:",
    actorQueueKeyPrefix: "game:queue:",
    resolveMemberId: (connecting) => {
      const memberId: unknown =
        connecting.requestContext.authorizer?.["memberId"];
      return typeof memberId === "string" ? memberId : undefined;
    },
    selectSubprotocol: (offered) =>
      offered.includes("bearer") ? "bearer" : undefined,
  });
```

Without `resolveMemberId` the member id is whatever the client put in
`x-member-id`, which is not authentication. Read **Security** before
deploying a `$connect` handler.

CJS:

```js
const {
  createGamebaseContext,
  dropConnection,
  gamebaseOptionsFromEnv,
  reply,
} = require("@yingyeothon/lambda-gamebase");

const context = createGamebaseContext(gamebaseOptionsFromEnv());
exports.hello = async (connectionId) => {
  await reply(connectionId, { type: "hello" }, { context }); // false when undeliverable
  await dropConnection(connectionId, { context });
};
```

## Public API

Actor loop

- `handleActor` / `HandleActorOptions` — game actor Lambda entry point: persists the start event, acquires the actor lock, signals the lobby, runs the actor loop. The lock lease is `lockTimeoutSeconds` (default 30) and is heartbeated while the game runs, so a crashed actor frees its `gameId` in seconds rather than for the game's whole lifetime
- `startActorLoop` / `StartActorLoopOptions` — runs `gameMain` inside the actor event loop and clears the start event at the end
- `createActorSubsystem` / `ActorSubsystemOptions` / `ActorSubsystem` — Redis-backed queue/lock/awaiter with per-component key prefixes
- `saveActorStartEvent`, `loadActorStartEvent`, `clearActorStartEvent` — start-event persistence helpers
- `authorizeGameConnection` / `AuthorizeGameConnectionOptions` / `GameConnectionAuthorization` (types) — the "may this member speak for this game" check `handleConnect` makes, exported so a custom gateway runs the same one instead of re-deriving it
- `readyCall` — HTTP PUT ready signal to the lobby callback URL
- `GameActorStartEvent` (type)

API Gateway handlers

- `handleConnect` / `HandleConnectOptions` — resolves the member id (`resolveMemberId`, default `x-member-id`), validates it against `x-game-id`'s start event, maps the connection, enqueues `enter`, and optionally echoes a `Sec-WebSocket-Protocol` (`selectSubprotocol`)
- `handleDisconnect` / `HandleDisconnectOptions` — enqueues `leave` and removes the mapping
- `handleMessages` / `HandleMessagesOptions` — validates the client message and enqueues it stamped with the connection id. Messages whose `type` is reserved are refused with `400`
- `handleDebugStart` / `HandleDebugStartOptions` — serverless-offline only: breaks the actor lock and invokes the actor Lambda locally
- `defaultConnectionMappingTtlMillis` — the default `connectionId -> gameId` mapping lifetime (900000). `handleMessages` refreshes it on every inbound message, so it bounds idle time rather than session length; pass the same `connectionMappingTtlMillis` to both handlers if you change it

Networking

- `reply`, `broadcast`, `dropConnection`, `fakeConnectionId`, `RespondResult` (type) — the calls a game loop makes; each resolves a `Transport` from its `NetworkOptions`
- `Transport` (type) — `{ send(connectionId, message), sendMany?(connectionIds, message), drop(connectionId) }`. Encoding belongs to the implementation: `reply`/`broadcast` never serialize, so a transport may use JSON, a binary codec, or an envelope of its own. `broadcast` prefers `sendMany` when a transport offers it and falls back to one `send` per connection otherwise
- `NetworkOptions` (type) — `{ transport?, client?, context?, logger?, sendTimeoutMillis? }`; an explicit `transport` wins, otherwise the API Gateway transport is built from `client` or `context`
- `resolveTransport(functionName, options)` — the resolution above, exposed for custom network helpers
- `createApiGatewayTransport(options)` / `ApiGatewayTransportOptions` (type) / `isGoneException` — the default transport: JSON over `PostToConnection`, `DeleteConnection` to drop, and `sendTimeoutMillis` to abort a delivery so one unresponsive connection cannot stall a game tick
- `createRedisPubSubTransport(options)` / `RedisPubSubTransportOptions` (type) / `GatewayCommand` (type) — publishes `{ op: "send" | "drop", ... }` on `{channelPrefix}{gameId}` for deployments that terminate WebSockets in their own gateway process. Subscribe with `createRedisSubscriber` from `@yingyeothon/naive-redis`. It implements `sendMany`, so one broadcast is one `PUBLISH` carrying `connectionIds` and the gateway does the fan-out — see the contract below. Its boolean means "a gateway was subscribed", not "the client received it", so do not pair it with `gamebase-all-together`'s `dropUndeliveredConnections` — a gateway restart would evict the whole party

Infrastructure

- `GamebaseOptions` (type) / `gamebaseOptionsFromEnv()` — injected configuration and the explicit env reader
- `createGamebaseContext` / `GamebaseContext` / `GamebaseContextOptions` — owns the lazily created shared Redis connection and API Gateway management client (both injectable for tests)
- `useRedis(work, connectionOptions)` — short-lived Redis connection helper

Models and requests (types)

- `BaseGameContext`, `BaseGameUser`, `BaseGameObserver`, `GameStartMember`, `GameMainOptions`
- `BaseGameRequest`, `BaseGameEnterRequest`, `BaseGameLeaveRequest`, `BaseGameConnectionIdRequest`
- `reservedRequestTypes` / `isReservedRequestType(type)` — `enter` and `leave` are produced by the connection handlers and decide which member a connection speaks for, so a client may never send them

Support

- `setupBaseGameContext`, `sleep`, `createTicker` / `Ticker` / `TickerOptions`, `createTimeDelta` / `TimeDelta`

## Gateway integration contract

Replacing API Gateway with your own WebSocket gateway means using only the
actor half of this package: `handleConnect` / `handleDisconnect` /
`handleMessages` are bypassed, and the gateway takes over what they did.
A gateway written in another language cannot import `UserMessage` or call
`enqueue()`, so this section is the contract rather than a summary of one.

### Keys

Three keys, each `{prefix}{gameId}`, with the prefixes coming from your
configuration on both sides:

| key                        | direction                   | who writes                                  |
| -------------------------- | --------------------------- | ------------------------------------------- |
| `{eventKeyPrefix}{gameId}` | the game's start event      | the actor writes, the gateway reads         |
| `{queueKeyPrefix}{gameId}` | inbound, a Redis list       | the gateway `RPUSH`es, the actor drains     |
| `{channelPrefix}{gameId}`  | outbound, a pub/sub channel | the actor publishes, the gateway subscribes |

**The queue key has no `queue:` segment.** `createRedisSubsystem` appends
one to its prefix, but this package does not: `createActorSubsystem` and
`handleConnect` pass `queueKeyPrefix` straight through. A gateway that
copies the subsystem layout pushes into a key nobody reads, and nothing
anywhere reports an error.

### The inbound envelope

A pushed value is a JSON `UserMessage<T>`, not a bare payload:

```json
{
  "messageId": "6a1f…",
  "awaitPolicy": 0,
  "item": { "type": "move", "connectionId": "i-1:9f2…", "x": 3 },
  "awaitTimeoutMillis": 0
}
```

`awaitPolicy` is a **numeric** enum — `AwaitPolicy.Forget === 0`, which is
what a gateway wants. Push a bare payload and `poll()` returns an array of
`undefined` items with no error anywhere.

`item` is the game's own message, stamped with the `connectionId` it came
from. `enter` and `leave` are reserved: the actor decides which member a
connection speaks for from them, so a gateway must synthesise them itself
and refuse them from clients (`isReservedRequestType`).

### The outbound envelope

The actor publishes JSON `GatewayCommand`s on `{channelPrefix}{gameId}`. The
gateway unwraps them; `message` is the game's own payload and reaches the
client verbatim.

```json
{ "op": "send", "connectionId": "i-1:9f2…", "message": { "type": "stage" } }
{ "op": "send", "connectionIds": ["i-1:9f2…", "i-1:3ab…"], "message": { … } }
{ "op": "drop", "connectionId": "i-1:9f2…" }
```

**There are two `send` shapes and a gateway must handle both.** `reply`
sends to one connection; `broadcast` sends to many in a single command, so
the gateway does the fan-out it is already positioned to do — at 8 players
and a fixed tick that is the difference between one publish per tick and
eight. `op` alone does not tell them apart: branch on whether
`connectionIds` is present.

`drop` and the end-of-game frames are published once and pub/sub has no
redelivery, which is why `gamebase-all-together`'s `endRepeatCount` exists.

### Ordering

Inbound is a list, so it is durable — the gateway may push before the actor
is running. Outbound is pub/sub, so a publish with no subscriber is simply
lost. Nothing bridges that asymmetry except order:

> **Subscribe to `{channelPrefix}{gameId}` before pushing the first inbound
> message for that `gameId`, and unsubscribe when its last connection
> closes.**

That is sufficient because the actor learns connection ids only from
`enter`, so it cannot publish before the first inbound message exists.

`RPUSH` is **not a trigger**: pushing does not start a Lambda. The actor is
invoked explicitly, and `readyCall` — fired only when the start event
carries a `callbackUrl` — is the handshake that says the loop is up. It
fires after the lock is acquired, so it means "this invocation owns the
game", and a duplicate invocation stays silent.

`RPUSH` replies with the list depth, so a gateway learns the queue depth on
every push for free. A depth that stops falling is how a gateway notices the
actor died; `createRedisQueue`'s `ttlSeconds` is the backstop for the case
where the _gateway_ is what died.

### Authorization

The gateway owns it, because it replaced the only place that did it. A token
proves who the caller is, not which game they belong to, and `gameId` comes
from the client:

```ts
import { authorizeGameConnection } from "@yingyeothon/lambda-gamebase";
import { redisGet } from "@yingyeothon/naive-redis";

const result = await authorizeGameConnection({
  gameId, // client-supplied
  memberId, // from the verified token
  eventKeyPrefix: "gamebase:event:",
  get: (key) => redisGet(connection, key),
  logger,
});
if (!result.authorized) {
  // result.reason is "unknownGame" or "notAMember"
  return refuse();
}
```

Skipping it lets anyone push messages into any game's queue. Keep the
logging discipline too: the start event carries names and e-mail addresses,
so log `memberCount`, never `members`.

### What this package does not do

- **A game is capped at one Lambda invocation.** The actor loop has no
  `shift` and no hand-off, so the game ends when the Lambda times out.
  `createLambdaShift` in `@yingyeothon/actor-system-lambda` belongs to the
  `tryToProcess` path and is not reachable from here.
- **Message delivery to the actor is at-most-once.** The loop flushes the
  queue before the game acts on the batch, so a crash in between loses it
  silently. A game that cannot lose input needs an ack of its own.
- **Nothing snapshots actor state.** Redis holds the queue, the lock, and
  the start event; game state lives in the actor's heap and is discarded
  when the invocation ends.

## Security

By default `handleConnect` reads `memberId` from the client's `x-member-id`
header or query string and only checks that it appears in the game's start
event. That is not authentication: **anyone who knows another member's id
can connect as that member** — and `gamebase-all-together` broadcasts every
member id to every player by default, so ids are not secret.

Close it with `resolveMemberId`. Put a REQUEST authorizer on `$connect`
(see [`@yingyeothon/lambda-authorizer-jwt`](../lambda-authorizer-jwt) —
a WebSocket API supports no other _Lambda_ authorizer type) and read the
verified identity from its context:

```ts
await handleConnect({
  event,
  ...prefixes,
  resolveMemberId: (event) => {
    const memberId: unknown = event.requestContext.authorizer?.["memberId"];
    return typeof memberId === "string" ? memberId : undefined;
  },
  selectSubprotocol: (offered) =>
    offered.includes("bearer") ? "bearer" : undefined,
  context,
});
```

`resolveMemberId` returning `undefined` rejects the connection, so the
authenticated path fails closed. The `x-member-id` header is then ignored
entirely; only `x-game-id` still comes from the client, and membership is
still checked against the start event, so a verified member can only enter
a game it was actually invited to.

`selectSubprotocol` echoes the `Sec-WebSocket-Protocol` value the server
selected. A browser cannot set headers on a WebSocket handshake, so a token
usually travels as `new WebSocket(url, ["bearer", token])`; the browser
then aborts the handshake unless the server names the subprotocol it chose.
A selection the client did not offer is dropped and logged rather than
sent, because a browser would abort on that too.

Note what the callback receives: with the arrangement above the `offered`
array is `["bearer", "<the raw JWT>"]`. **It carries the credential — never
log it.**

`handleMessages` refuses `enter`/`leave` from a client so that `$default`
cannot be used to rebind a connection to another member. It otherwise
routes purely by `connectionId`, and the member that connection speaks for
was decided at `$connect`.

Two things this does **not** close, because neither is an identity
question:

- **A member may hold several connections at once.** Nothing caps them, and
  each `$connect` enqueues an `enter`, whose default `onMemberEntered`
  broadcasts to everyone. Rate-limit connections per member upstream.
- **A superseded connection keeps its mapping.** When a member reconnects,
  `processEnter` rebinds the game slot to the new connection id, but the
  old connection's `connectionId` → `gameId` entry lives until it
  disconnects or the entry expires, so `$default` still accepts messages
  from it. Close the old socket, or have the game ignore a message whose
  connection is no longer the member's current one.

Once a connection is established no authorizer can revoke it. Dropping a
player mid-game is the game loop's job, through `Transport.drop`.

## Behavior changes

- **A short, heartbeated actor lock.** The lease was the game's whole
  lifetime (`lifetimeSeconds + 10`, up to ~730 s), so a crash at t=30s left
  the `gameId` unstartable for the remaining minutes. It is now
  `lockTimeoutSeconds` (default 30), extended by a heartbeat while the game
  runs. Pass `lockTimeoutSeconds: lifetimeSeconds + 10` for the old shape.
- **`readyCall` fires after the lock is acquired.** It used to fire before,
  so a duplicate invocation told the lobby a game was ready that it would
  never run.
- **A broadcast is one call when the transport supports it.** `Transport`
  gained an optional `sendMany`, which `broadcast` prefers; the per-connection
  loop is still the fallback and the `RespondResult` shape is unchanged.
- **`GatewayCommand` gained a second `send` shape, and this is a wire
  change.** `broadcast` over `createRedisPubSubTransport` now publishes
  `{ op: "send", connectionIds: [...], message }` instead of one command per
  recipient. **An existing gateway that reads `command.connectionId` gets
  `undefined` for every broadcast and drops the frame, with no error
  anywhere** — update it to branch on `connectionIds` first. See the gateway
  contract above.
- **The actor's queue key TTL belongs to whoever pushes.** `handleConnect`,
  `handleDisconnect`, and `handleMessages` take `queueTtlSeconds`; the actor
  only drains its queue, so configuring a TTL on its subsystem never applies
  one.
- **`broadcast` logs at `debug`, and logs counts.** It used to log the
  connection id list and the whole response body at `info`, which is a game
  payload in the logs several times a second at a fixed tick.
- **The `connectionId -> gameId` mapping is refreshed.** `handleMessages`
  extends it on every inbound message, so a session longer than the mapping's
  TTL no longer loses its routing entry.
- **`Transport` seam.** `reply`/`broadcast`/`dropConnection` now go through a
  `Transport` instead of calling the API Gateway SDK directly. Passing
  `client` or `context` behaves exactly as before; `NetworkOptions.transport`
  replaces it, and the "requires either client or context" error became
  "requires either transport, client, or context".
- **Reserved message types.** `handleMessages` answers `400` for a client
  message whose `type` is `enter` or `leave`. Those are produced by
  `handleConnect`/`handleDisconnect` and decide which member a connection is
  bound to, so accepting one from a client let an authenticated member bind
  another member's game slot to its own connection.
- **Authenticated identity.** `handleConnect` takes `resolveMemberId`, which
  defaults to today's `x-member-id` header or query string read, so unset it
  behaves exactly as before. Pass a resolver reading the authorizer's context
  to close the identity gap described under Security.
- **Subprotocol echo.** `handleConnect` takes `selectSubprotocol`, and returns
  a `Sec-WebSocket-Protocol` response header when it selects one. Unset, the
  response is unchanged.
- **Case-insensitive headers.** `x-game-id` and `x-member-id` are now matched
  regardless of header casing; a client sending `X-GAME-ID` used to be
  rejected. Query string lookup is still exact. A header present but empty
  now falls through to the query string, where it used to win and fail the
  request; and `event.headers` being absent no longer throws. Two headers
  differing only in case resolve to the first one declared.
- **Less in the logs.** Neither `handleConnect` nor `handleDebugStart` logs a
  whole start event any more — it carries every member's name and email.
  `handleMessages` logs a parse failure's `Error.name` rather than the error,
  whose message quotes the body it choked on. The membership rejection still
  names the member and the connection, which under `resolveMemberId` is a
  verified principal and the only way to attribute a probe.
- **Distinct refusal messages.** A missing member id (which is what a
  `resolveMemberId` finding no identity produces) and a missing game id are
  now logged apart, instead of both as "invalid gameId".

## Migrating from the legacy package

- All exports are named; there are no default exports. Interfaces (`BaseGameContext`, `GameActorStartEvent`, ...) are type-only exports.
- **AWS SDK v2 → v3.** `reply` and `dropConnection` now use `ApiGatewayManagementApiClient` with `PostToConnectionCommand` / `DeleteConnectionCommand`, and `handleDebugStart` uses `LambdaClient` with `InvokeCommand`. A disconnected WebSocket client no longer surfaces as an error with `statusCode === 410`; SDK v3 throws `GoneException` instead. `reply` still returns `false` for a gone client so disconnect processing is unchanged, and the new `isGoneException(error)` helper detects this case (`error instanceof GoneException` or `error.name === "GoneException"`). `dropConnection` now treats an already-gone connection as success.
- **No environment reads, no module singletons.** The `env` lazy getter, `getRedisConnection` / `setRedisConnection`, and `getApiGatewayManagementClient` / `setApiGatewayManagementClient` were removed. Build a `GamebaseOptions` (or call `gamebaseOptionsFromEnv()`), pass it to `createGamebaseContext(options)`, and hand that context to the handlers (`context` option) and network functions (`NetworkOptions.context`). The context owns the lazily created shared Redis connection and management client; explicit `redisConnection` / `client` overrides still win. The `GamebaseEnv` type became `GamebaseOptions` with a nested `redis: RedisConnectionOptions`.
- **Renames per the v2 API conventions:**
  - `newActorSubsys` → `createActorSubsystem`, `NewActorSubsysArgs` → `ActorSubsystemOptions`
  - `HandleActorArgs` → `HandleActorOptions`, `StartActorLoopArgs` → `StartActorLoopOptions`, `HandleConnectArgs` → `HandleConnectOptions`, `HandleDebugStartArgs` → `HandleDebugStartOptions`, `HandleDisconnectArgs` → `HandleDisconnectOptions`, `HandleMessagesArgs` → `HandleMessagesOptions`
  - the `subsys` option of `handleActor` / `startActorLoop` → `subsystem`
  - `GameMainArguments` → `GameMainOptions`
  - `Ticker` class → `createTicker({ stage, aliveMillis })` returning the `Ticker` interface; `TimeDelta` class → `createTimeDelta()` returning the `TimeDelta` interface
- **Logger defaults.** Every optional `logger` now defaults to `nullLogger` instead of a console logger, and the `STAGE`-based default severity in `broadcast` / `reply` is gone — pass the logger (e.g. `createConsoleLogger("info")`) you want via options.
- `useRedis(work, { host, password })` with env fallbacks became `useRedis(work, connectionOptions)` with required, explicit `RedisConnectionOptions`.
- `handleDebugStart` now requires a `context`; it reads `isOffline` and `gameActorLambdaName` from `context.options` instead of `IS_OFFLINE` / `GAME_ACTOR_LAMBDA_NAME`.
- Handlers and the actor loop accept optional injection points (`redisConnection`, `subsystem`, `lambdaClient`, `logger`, `saveStartEvent`, `deleteStartEvent`, `NetworkOptions.client`) for testing; defaults preserve the legacy behavior.
- `createActorSubsystem` builds the queue/lock/awaiter with the `createRedisQueue` / `createRedisLock` / `createRedisAwaiter` factories from `@yingyeothon/actor-system-redis`.
- Bug fixes: `dropConnection` now actually awaits the SDK call (the legacy version forgot to), and `broadcast` returns the documented `{ [connectionId]: delivered }` map (the legacy version accidentally merged `{ connectionId, success }` objects).
- `handleDebugStart` no longer lets a fire-and-forget invocation reject unhandled; the failure is logged.

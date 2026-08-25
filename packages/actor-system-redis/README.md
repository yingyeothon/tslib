# @yingyeothon/actor-system-redis

Redis-backed queue, lock, and awaiter implementations for [`@yingyeothon/actor-system`](../actor-system), built on the minimal [`@yingyeothon/naive-redis`](../naive-redis) client. It lets multiple processes (for example, concurrent AWS Lambda invocations) share one actor's message queue, exclusive lock, and message-completion signals through a single Redis server.

## Install

```bash
npm install @yingyeothon/actor-system-redis
```

## Usage

ESM:

```ts
import { post, singleConsumer, tryToProcess } from "@yingyeothon/actor-system";
import { createRedisSubsystem } from "@yingyeothon/actor-system-redis";
import { createRedisConnection } from "@yingyeothon/naive-redis";

const connection = createRedisConnection({ host: "localhost", port: 6379 });
const env = {
  ...singleConsumer,
  ...createRedisSubsystem({
    connection,
    keyPrefix: "my-app:",
    lockTimeout: 30_000,
  }),
  id: "adder",
  onMessage: ({ delta }: { delta: number }) => {
    total += delta;
  },
};
let total = 0;

await post(env, { item: { delta: 1 } });
await tryToProcess(env);
```

Each part can also be used on its own:

```ts
import {
  createRedisAwaiter,
  createRedisLock,
  createRedisQueue,
} from "@yingyeothon/actor-system-redis";

const queue = createRedisQueue({
  connection,
  keyPrefix: "queue:",
  ttlSeconds: 900, // an abandoned queue disappears instead of growing
});
await queue.push("actor-1", { hello: "world" });
console.log(await queue.size("actor-1")); // 1
console.log(await queue.pop("actor-1")); // { hello: "world" }

const lock = createRedisLock({ connection, lockTimeout: 30_000 });
if (await lock.tryAcquire("actor-1")) {
  try {
    // ...exclusive work...
  } finally {
    await lock.release("actor-1");
  }
}

const awaiter = createRedisAwaiter({ connection });
await awaiter.resolve("actor-1", "message-1");
console.log(await awaiter.wait("actor-1", "message-1", 1000)); // true
```

CJS:

```js
const { createRedisSubsystem } = require("@yingyeothon/actor-system-redis");
const { createRedisConnection } = require("@yingyeothon/naive-redis");

const connection = createRedisConnection({ host: "localhost" });
const { queue, lock, awaiter } = createRedisSubsystem({
  connection,
  lockTimeout: 30_000,
});
```

## Public API

- `createRedisQueue` — creates a Redis list-backed queue implementing `QueueProducer`, `QueueSingleConsumer`, `QueueBulkConsumer`, and `QueueLength` (`push`, `pop`, `peek`, `flush`, `size`); values are encoded with a `Codec<string>` (default `jsonCodec`)
- `RedisQueue` — the return type of `createRedisQueue` (type)
- `RedisQueueOptions` — `{ connection, keyPrefix?, codec?, logger?, ttlSeconds? }` (type). `push` resolves with the queue depth after the push, which `RPUSH` gives back for free, so a producer can notice that nobody is consuming without a second round trip. `ttlSeconds` is re-applied on every push; without it an abandoned queue grows forever, and on a shared `allkeys-lru` Redis that evicts someone else's keys first
- `createRedisLock` — creates a `SET NX`-based per-actor lock implementing `LockAcquire`, `LockRelease`, and `LockRenew`. Every acquisition writes a random token as the value and keeps it in process, so `release` compares before deleting and `renew` compares before extending: a holder whose lease expired cannot delete the lock its successor took, and a process that never acquired cannot touch it at all. `renew` returning false means the lock is gone
  `lockTimeout` (milliseconds) is **required**: a lock that never expires deadlocks its actor forever when the holder crashes, so no-expiry has to be an explicit choice — pass a non-positive value to make it
- `RedisLock` — the return type of `createRedisLock` (type)
- `RedisLockOptions` — `{ connection, keyPrefix?, logger?, lockTimeout }` (type)
- `createRedisAwaiter` — creates an awaiter implementing `AwaiterResolve` and `AwaiterWait`; `resolve` writes a 1-second `actorId/messageId` marker key and `wait` polls it every 50ms until it appears or the timeout elapses (`resolve` swallows Redis errors; `wait` propagates them). **Short in-request waits only**: the marker lives 1 second, so a resolver that fires while a slow waiter is between polls can be missed entirely
- `RedisAwaiter` — the return type of `createRedisAwaiter` (type)
- `RedisAwaiterOptions` — `{ connection, keyPrefix?, logger? }` (type)
- `createRedisSubsystem` — builds `{ queue, lock, awaiter }` sharing one connection, appending `queue:`, `lock:`, and `awaiter:` to the given key prefix
- `RedisSubsystem` — the return type of `createRedisSubsystem` (type)
- `RedisSubsystemOptions` — `{ connection, keyPrefix?, logger?, lockTimeout, queueTtlSeconds? }` (type)

Every factory accepts an optional `logger?: Logger` (from [`@yingyeothon/logger`](../logger), default `nullLogger`). All methods are own properties, so results can be spread into an actor environment (`{ ...singleConsumer, ...createRedisSubsystem(...), ...actor }`).

## Behavior changes

- **`lockTimeout` is required.** It used to default to `-1`, i.e. a lock that
  never expires, which deadlocks its actor forever when the holder crashes.
  Existing `createRedisLock({ connection })` and
  `createRedisSubsystem({ connection })` calls no longer compile; pass a
  finite millisecond lease, or a non-positive value to choose no expiry
  deliberately.
- **`release` is conditional and can return false.** The lock value is now a
  per-acquisition token and `release` compares before deleting, so a holder
  whose lease expired can no longer delete its successor's lock — and a
  process that never acquired gets `false` instead of silently deleting
  someone else's key. Code that used `release` to _break_ a stale lock must
  use `redisDel` on the lock key and mean it.
- **`renew` is new**, and `RedisLock` now extends `LockRenew`. A long-running
  loop should heartbeat it; see `eventLoop`'s `lockRenewIntervalMillis`.
- **`push` resolves the queue depth** instead of `void`.

## Migrating from the legacy package

- The npm package was renamed: `@yingyeothon/actor-system-redis-support` → `@yingyeothon/actor-system-redis`.
- Classes became factory functions returning interfaces: `new RedisQueue(options)` → `createRedisQueue(options)`, `new RedisLock(options)` → `createRedisLock(options)`, `new RedisAwaiter(options)` → `createRedisAwaiter(options)`. `RedisQueue`, `RedisLock`, and `RedisAwaiter` remain as the returned interface types.
- `newRedisSubsystem` → `createRedisSubsystem` (the `RedisSubsystem` return type is unchanged).
- Get connections from `@yingyeothon/naive-redis`'s root export: `createRedisConnection` (legacy `redisConnect`, previously `connect` from `naive-redis/lib/connection`).
- Deep imports are gone; everything is exported from the package root, and option interfaces are exported (`RedisQueueOptions`, `RedisLockOptions`, `RedisAwaiterOptions`, `RedisSubsystemOptions`).
- Key layouts are unchanged. Runtime behavior and defaults are **not** — see Behavior changes above.

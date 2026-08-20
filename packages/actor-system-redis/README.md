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
  ...createRedisSubsystem({ connection, keyPrefix: "my-app:" }),
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

const queue = createRedisQueue({ connection, keyPrefix: "queue:" });
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
const { queue, lock, awaiter } = createRedisSubsystem({ connection });
```

## Public API

- `createRedisQueue` — creates a Redis list-backed queue implementing `QueueProducer`, `QueueSingleConsumer`, `QueueBulkConsumer`, and `QueueLength` (`push`, `pop`, `peek`, `flush`, `size`); values are encoded with a `Codec<string>` (default `jsonCodec`)
- `RedisQueue` — the return type of `createRedisQueue` (type)
- `RedisQueueOptions` — `{ connection, keyPrefix?, codec?, logger? }` (type)
- `createRedisLock` — creates a `SET NX`-based per-actor lock implementing `LockAcquire` and `LockRelease`; `lockTimeout` (milliseconds) sets an expiry on the lock key, non-positive means no expiry
- `RedisLock` — the return type of `createRedisLock` (type)
- `RedisLockOptions` — `{ connection, keyPrefix?, logger?, lockTimeout? }` (type)
- `createRedisAwaiter` — creates an awaiter implementing `AwaiterResolve` and `AwaiterWait`; `resolve` writes a 1-second `actorId/messageId` marker key and `wait` polls it every 50ms until it appears or the timeout elapses (`resolve` swallows Redis errors; `wait` propagates them)
- `RedisAwaiter` — the return type of `createRedisAwaiter` (type)
- `RedisAwaiterOptions` — `{ connection, keyPrefix?, logger? }` (type)
- `createRedisSubsystem` — builds `{ queue, lock, awaiter }` sharing one connection, appending `queue:`, `lock:`, and `awaiter:` to the given key prefix
- `RedisSubsystem` — the return type of `createRedisSubsystem` (type)
- `RedisSubsystemOptions` — `{ connection, keyPrefix?, logger? }` (type)

Every factory accepts an optional `logger?: Logger` (from [`@yingyeothon/logger`](../logger), default `nullLogger`). All methods are own properties, so results can be spread into an actor environment (`{ ...singleConsumer, ...createRedisSubsystem(...), ...actor }`).

## Migrating from the legacy package

- The npm package was renamed: `@yingyeothon/actor-system-redis-support` → `@yingyeothon/actor-system-redis`.
- Classes became factory functions returning interfaces: `new RedisQueue(options)` → `createRedisQueue(options)`, `new RedisLock(options)` → `createRedisLock(options)`, `new RedisAwaiter(options)` → `createRedisAwaiter(options)`. `RedisQueue`, `RedisLock`, and `RedisAwaiter` remain as the returned interface types.
- `newRedisSubsystem` → `createRedisSubsystem` (the `RedisSubsystem` return type is unchanged).
- Get connections from `@yingyeothon/naive-redis`'s root export: `createRedisConnection` (legacy `redisConnect`, previously `connect` from `naive-redis/lib/connection`).
- Deep imports are gone; everything is exported from the package root, and option interfaces are exported (`RedisQueueOptions`, `RedisLockOptions`, `RedisAwaiterOptions`, `RedisSubsystemOptions`).
- Runtime behavior, key layouts, and defaults are unchanged.

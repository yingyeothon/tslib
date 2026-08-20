# @yingyeothon/actor-system-redis-support

Redis-backed queue, lock, and awaiter implementations for [`@yingyeothon/actor-system`](../actor-system), built on the minimal [`@yingyeothon/naive-redis`](../naive-redis) client. It lets multiple processes (for example, concurrent AWS Lambda invocations) share one actor's message queue, exclusive lock, and message-completion signals through a single Redis server.

## Install

```bash
npm install @yingyeothon/actor-system-redis-support
```

## Usage

ESM:

```ts
import { post, singleConsumer, tryToProcess } from "@yingyeothon/actor-system";
import { newRedisSubsystem } from "@yingyeothon/actor-system-redis-support";
import { redisConnect } from "@yingyeothon/naive-redis";

const connection = redisConnect({ host: "localhost", port: 6379 });
const env = {
  ...singleConsumer,
  ...newRedisSubsystem({ connection, keyPrefix: "my-app:" }),
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
  RedisAwaiter,
  RedisLock,
  RedisQueue,
} from "@yingyeothon/actor-system-redis-support";

const queue = new RedisQueue({ connection, keyPrefix: "queue:" });
await queue.push("actor-1", { hello: "world" });
console.log(await queue.size("actor-1")); // 1
console.log(await queue.pop("actor-1")); // { hello: "world" }

const lock = new RedisLock({ connection, lockTimeout: 30_000 });
if (await lock.tryAcquire("actor-1")) {
  try {
    // ...exclusive work...
  } finally {
    await lock.release("actor-1");
  }
}

const awaiter = new RedisAwaiter({ connection });
await awaiter.resolve("actor-1", "message-1");
console.log(await awaiter.wait("actor-1", "message-1", 1000)); // true
```

CJS:

```js
const {
  newRedisSubsystem,
} = require("@yingyeothon/actor-system-redis-support");
const { redisConnect } = require("@yingyeothon/naive-redis");

const connection = redisConnect({ host: "localhost" });
const { queue, lock, awaiter } = newRedisSubsystem({ connection });
```

## Public API

- `RedisQueue` — Redis list-backed queue implementing `QueueProducer`, `QueueSingleConsumer`, `QueueBulkConsumer`, and `QueueLength` (`push`, `pop`, `peek`, `flush`, `size`); values are encoded with a `Codec<string>` (default `JsonCodec`)
- `RedisQueueOptions` — `{ connection, keyPrefix?, codec?, logger? }` (type)
- `RedisLock` — `SET NX`-based per-actor lock implementing `LockAcquire` and `LockRelease`; `lockTimeout` (milliseconds) sets an expiry on the lock key, non-positive means no expiry
- `RedisLockOptions` — `{ connection, keyPrefix?, logger?, lockTimeout? }` (type)
- `RedisAwaiter` — implements `AwaiterResolve` and `AwaiterWait`; `resolve` writes a 1-second `actorId/messageId` marker key and `wait` polls it every 50ms until it appears or the timeout elapses (`resolve` swallows Redis errors; `wait` propagates them)
- `RedisAwaiterOptions` — `{ connection, keyPrefix?, logger? }` (type)
- `newRedisSubsystem` — builds `{ queue, lock, awaiter }` sharing one connection, appending `queue:`, `lock:`, and `awaiter:` to the given key prefix
- `RedisSubsystem` — the return type of `newRedisSubsystem` (type)
- `RedisSubsystemOptions` — `{ connection, keyPrefix?, logger? }` (type)

All methods are arrow-function own properties, so instances can be spread into an actor environment (`{ ...singleConsumer, ...newRedisSubsystem(...), ...actor }`).

## Migrating from the legacy package

- Deep imports are gone; everything is exported from the package root, and option interfaces are now exported (`RedisQueueOptions`, `RedisLockOptions`, `RedisAwaiterOptions`, `RedisSubsystemOptions`, `RedisSubsystem`).
- `newRedisSubsystem` now has an explicit `RedisSubsystem` return type.
- Get connections from `@yingyeothon/naive-redis`'s root export: `redisConnect` (legacy `connect` from `naive-redis/lib/connection`).
- Runtime behavior, key layouts, and defaults are unchanged.

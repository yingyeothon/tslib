# @yingyeothon/naive-redis

Minimal Redis client built on [`@yingyeothon/naive-socket`](../naive-socket): strings, lists, sets, INCR, and a "simple" layer that opens a connection per operation and adds JSON-encoded caching helpers. It speaks a small subset of the RESP protocol directly, so it stays tiny enough for serverless bundles.

## Install

```bash
npm install @yingyeothon/naive-redis
```

## Usage

ESM:

```ts
import {
  createRedisConnection,
  redisGet,
  redisSet,
  redisDel,
  redisRpush,
  redisLpop,
} from "@yingyeothon/naive-redis";

const connection = createRedisConnection({
  host: "localhost",
  port: 6379,
  password: "optional-password",
  timeoutMillis: 1000,
});

await redisSet(connection, "greeting", "hello", { expirationMillis: 60_000 });
console.log(await redisGet(connection, "greeting")); // "hello"
await redisRpush(connection, "queue", "job-1", "job-2");
console.log(await redisLpop(connection, "queue")); // "job-1"
await redisDel(connection, "greeting", "queue");

connection.socket.disconnect();
```

CJS:

```js
const { redisSimpleWork, redisGet } = require("@yingyeothon/naive-redis");

redisSimpleWork({ host: "localhost" }, async (connection) => {
  return await redisGet(connection, "greeting");
}).then(console.log);
```

The simple layer manages connections for you and (de)serializes values as JSON:

```ts
import { createRedisSimple, redisSimpleCache } from "@yingyeothon/naive-redis";

const simple = createRedisSimple({ config: { host: "localhost" } });
await simple.set("stuff", { a: 100, b: "world" });
console.log(await simple.get<{ a: number; b: string }>("stuff"));
await simple.del("stuff");

// Cache an async function's result in Redis.
const cachedAnswer = redisSimpleCache(async (q: string) => q.length, {
  config: { host: "localhost" },
  cacheKey: (q) => `answer:${q}`,
  expirationMillis: 60_000,
});
console.log(await cachedAnswer("universe")); // computed, then cached
console.log(await cachedAnswer.peek("universe")); // read without computing
await cachedAnswer.refresh("universe"); // recompute and store
await cachedAnswer.clear("universe"); // drop the cached entry
```

## Public API

- `createRedisConnection(options)` — create a `RedisConnection`; authenticates automatically when `password` is set
- `redisAuth(connection, password)` — send `AUTH` explicitly
- `redisSend({ connection, commands, match, transform, urgent? })` — low-level RESP exchange for commands not covered below
- `redisGet(connection, key)` — read a string value (`null` when missing)
- `redisSet(connection, key, value, options?)` — write a string value; `RedisSetOptions`: `expirationMillis`, `onlySet: "nx" | "xx"`
- `redisDel(connection, ...keys)` — delete keys
- `redisExists(connection, key)` — key existence check
- `redisIncr(connection, key)` — atomic increment
- `redisRpush(connection, key, ...values)` — append to a list
- `redisLpop(connection, key)` — pop the head of a list
- `redisLrange(connection, key, start, stop)` — read a list range
- `redisLlen(connection, key)` — list length
- `redisLindex(connection, key, index)` — read one list element
- `redisLtrim(connection, key, start, stop)` — trim a list to a range
- `redisSadd(connection, key, ...members)` — add set members
- `redisSrem(connection, key, ...members)` — remove set members
- `redisSmembers(connection, key)` — read all set members
- `createRedisSimple(options)` — returns a `RedisSimple` (`get`/`set`/`del`/`cache` with a shared `keyPrefix` and codec)
- `redisSimpleWork(options, work)` — connect, run `work`, always disconnect
- `redisSimpleCache(fn, options)` — cache an async function's result in Redis (with `peek`/`refresh`/`clear` friends)
- Types: `RedisConnection`, `RedisConnectionOptions`, `RedisSendOptions`, `RedisSetOptions`, `RedisSimple`, `RedisSimpleFn`, `RedisSimpleCacheFriends`, `RedisSimpleCacheOptions`, `RedisSimpleOptions`

## Migrating from the legacy package

The legacy package exposed one default export per deep-imported module (for example `import get from "@yingyeothon/naive-redis/lib/get"`); everything is now a named export from the package root with a `redis` prefix:

- `lib/connection` (default) → `createRedisConnection`
- `lib/get`, `lib/set`, `lib/del`, ... (defaults) → `redisGet`, `redisSet`, `redisDel`, ...
- `lib/simple` (default `RedisSimple` class) → `createRedisSimple` (with `RedisSimple` remaining as the returned interface)
- `lib/simple/work`, `lib/simple/cache` → `redisSimpleWork`, `redisSimpleCache`
- `redisConnect` (previous named-export API) → `createRedisConnection`
- `RedisConfig` (type) → `RedisConnectionOptions`

Function parameters, return types, and RESP behavior are otherwise unchanged.

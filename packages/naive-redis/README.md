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
  redisConnect,
  redisGet,
  redisSet,
  redisDel,
  redisRpush,
  redisLpop,
} from "@yingyeothon/naive-redis";

const connection = redisConnect({
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
import { RedisSimple, redisSimpleCache } from "@yingyeothon/naive-redis";

const simple = new RedisSimple({ config: { host: "localhost" } });
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

- `redisConnect(config)` — create a `RedisConnection`; authenticates automatically when `password` is set.
- `redisAuth(connection, password)` — send `AUTH` explicitly.
- `redisSend({ connection, commands, match, transform, urgent? })` — low-level RESP exchange for commands not covered below.
- Strings and keys: `redisGet`, `redisSet` (with `RedisSetOptions`: `expirationMillis`, `onlySet: "nx" | "xx"`), `redisDel`, `redisExists`, `redisIncr`.
- Lists: `redisRpush`, `redisLpop`, `redisLrange`, `redisLlen`, `redisLindex`, `redisLtrim`.
- Sets: `redisSadd`, `redisSrem`, `redisSmembers`.
- Simple layer: `RedisSimple` class (`get`/`set`/`del`/`cache` with a shared `keyPrefix` and codec), `redisSimpleWork(config, work)` (connect, run, always disconnect), `redisSimpleCache(fn, options)`.
- Types: `RedisConfig`, `RedisConnection`, `RedisSendOptions`, `RedisSetOptions`, `RedisSimpleFn`, `RedisSimpleCacheFriends`, `RedisSimpleCacheOptions`, `RedisSimpleOptions`.

## Migrating from the legacy package

The legacy package exposed one default export per deep-imported module (for example `import get from "@yingyeothon/naive-redis/lib/get"`). Everything is now a named export from the package root with a `redis` prefix:

| Legacy import                         | Now                                     |
| ------------------------------------- | --------------------------------------- |
| `lib/connection` (default)            | `redisConnect`                          |
| `lib/get`, `lib/set`, `lib/del`, ...  | `redisGet`, `redisSet`, `redisDel`, ... |
| `lib/simple` (default `RedisSimple`)  | `RedisSimple`                           |
| `lib/simple/work`, `lib/simple/cache` | `redisSimpleWork`, `redisSimpleCache`   |

Function parameters, return types, and RESP behavior are unchanged.

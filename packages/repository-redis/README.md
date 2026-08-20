# @yingyeothon/repository-redis

Redis-backed implementation of the `@yingyeothon/repository` abstractions: a `Repository` that stores each value as one Redis string (key = `repo:` + optional prefix + repository key), encodes values with a pluggable `Codec` (JSON by default), and supports per-key expiration via `setWithExpire`. Because it extends `SimpleRepository`, versioned list/map documents work out of the box. Redis I/O goes through `@yingyeothon/naive-redis`, so a single lightweight socket connection is shared by everything.

## Install

```bash
npm install @yingyeothon/repository-redis
```

## Usage

ESM:

```ts
import { redisConnect } from "@yingyeothon/naive-redis";
import { RedisRepository } from "@yingyeothon/repository-redis";

const repo = new RedisRepository({
  redisConnection: redisConnect({
    host: "localhost",
    port: 6379,
    password: "optional-password",
  }),
  prefix: "session", // optional; keys become "repo:session:<key>"
});

await repo.set("hello", { value: 42 });
const stored = await repo.get<{ value: number }>("hello"); // { value: 42 }
await repo.get("missing"); // undefined
await repo.setWithExpire("hello", { value: 42 }, 30 * 60 * 1000); // TTL in millis
await repo.set("hello", undefined); // same as repo.delete("hello")
await repo.delete("hello");

// Versioned documents from @yingyeothon/repository:
const mapDoc = repo.getMapDocument<string>("map-doc");
await mapDoc.insertOrUpdate("key", "value");

// Derive a repository that shares the connection/codec but uses another prefix:
const nested = repo.withPrefix("nested");
```

CJS:

```js
const { redisConnect } = require("@yingyeothon/naive-redis");
const { RedisRepository } = require("@yingyeothon/repository-redis");

const repo = new RedisRepository({
  redisConnection: redisConnect({ host: "localhost" }),
});
```

## Public API

- `RedisRepository` — `SimpleRepository` backed by Redis, implementing `ExpirableRepository`:
  - `get<T>(key)` — reads and decodes the value; returns `undefined` when the key does not exist or has expired; a Redis/socket error is logged with `console.error` and also yields `undefined`.
  - `set<T>(key, value)` — encodes and writes the value; `set(key, undefined)` deletes instead.
  - `setWithExpire<T>(key, value, expiresInMillis)` — like `set` but with a TTL (`SET ... PX`); throws when `expiresInMillis <= 0`; `undefined` deletes instead.
  - `delete(key)` — removes the key.
  - `withPrefix(prefix)` — new `RedisRepository` sharing the same connection and codec.
  - `getListDocument<V>(key)` / `getMapDocument<V>(key)` — inherited versioned documents.
  - Key layout: `repo:<key>`, or `repo:<prefix>:<key>` when a prefix is set.
- `RedisRepositoryArguments` — constructor options `{ redisConnection, prefix?, codec? }` (type)

## Migrating from the legacy package

- The package now ships dual ESM/CJS with types; deep imports (`@yingyeothon/repository-redis/lib/...`) are no longer supported — import everything from the package root.
- `@yingyeothon/naive-redis` now exposes root named exports as well: use `import { redisConnect } from "@yingyeothon/naive-redis"` instead of `@yingyeothon/naive-redis/lib/connection`.
- `RedisRepositoryArguments` is now exported (type-only). Behavior and the key layout are unchanged.

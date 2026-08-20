# @yingyeothon/repository-redis

Redis-backed implementation of the `@yingyeothon/repository` abstractions: a `Repository` that stores each value as one Redis string (key = `repo:` + optional prefix + repository key), encodes values with a pluggable `Codec` (JSON by default), and supports per-key expiration via `setWithExpire`. Because it satisfies the `Repository` contract, versioned list/map documents from `@yingyeothon/repository` work out of the box. Redis I/O goes through `@yingyeothon/naive-redis`, so a single lightweight socket connection is shared by everything.

## Install

```bash
npm install @yingyeothon/repository-redis
```

## Usage

ESM:

```ts
import { createRedisConnection } from "@yingyeothon/naive-redis";
import { createRedisRepository } from "@yingyeothon/repository-redis";

const repo = createRedisRepository({
  redisConnection: createRedisConnection({
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
import { createMapDocument } from "@yingyeothon/repository";
const mapDoc = createMapDocument<string>({ repository: repo, key: "map-doc" });
await mapDoc.insertOrUpdate("key", "value");

// Derive a repository that shares the connection/codec but uses another prefix:
const nested = repo.withPrefix("nested");
```

CJS:

```js
const { createRedisConnection } = require("@yingyeothon/naive-redis");
const { createRedisRepository } = require("@yingyeothon/repository-redis");

const repo = createRedisRepository({
  redisConnection: createRedisConnection({ host: "localhost" }),
});
```

## Public API

- `createRedisRepository(options)` — builds a `RedisRepository` backed by Redis:
  - `get<T>(key)` — reads and decodes the value; returns `undefined` when the key does not exist or has expired; a Redis/socket error is logged via the injected `logger` and also yields `undefined`.
  - `set<T>(key, value)` — encodes and writes the value; `set(key, undefined)` deletes instead.
  - `setWithExpire<T>(key, value, expiresInMillis)` — like `set` but with a TTL (`SET ... PX`); throws when `expiresInMillis <= 0`; `undefined` deletes instead.
  - `delete(key)` — removes the key.
  - `withPrefix(prefix)` — new `RedisRepository` sharing the same connection and codec.
  - Key layout: `repo:<key>`, or `repo:<prefix>:<key>` when a prefix is set.
- `RedisRepository` — `ExpirableRepository` plus `withPrefix` (type)
- `RedisRepositoryOptions` — factory options `{ redisConnection, prefix?, codec?, logger? }`; `logger` is a `Logger` from `@yingyeothon/logger` and defaults to `nullLogger` (type)

## Migrating from the legacy package

- The package now ships dual ESM/CJS with types; deep imports (`@yingyeothon/repository-redis/lib/...`) are no longer supported — import everything from the package root.
- The `RedisRepository` class is gone: call `createRedisRepository(options)` instead of `new RedisRepository(args)`. The returned object implements `ExpirableRepository` and keeps `withPrefix`; `getListDocument`/`getMapDocument` moved to `createListDocument`/`createMapDocument` in `@yingyeothon/repository`.
- `RedisRepositoryArguments` is now `RedisRepositoryOptions`.
- `@yingyeothon/naive-redis` renamed `redisConnect` to `createRedisConnection`; import it from the package root instead of `@yingyeothon/naive-redis/lib/connection`.
- Redis read errors are no longer reported with `console.error`; pass `logger` (from `@yingyeothon/logger`) in the options to observe them. Behavior and the key layout are unchanged.

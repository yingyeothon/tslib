# @yingyeothon/repository

Key-value repository abstractions for asynchronous storage backends: a minimal `Repository` interface, an `ExpirableRepository` extension for TTL-based entries, a `SimpleRepository` base class that adds versioned list/map document helpers on top of any key-value store, and an `InMemoryRepository` implementation useful for tests and local development.

## Install

```bash
npm install @yingyeothon/repository
```

## Usage

ESM:

```ts
import { InMemoryRepository } from "@yingyeothon/repository";

const repo = new InMemoryRepository();
await repo.set("greeting", { hi: "there" });
const value = await repo.get<{ hi: string }>("greeting");

// TTL entries
await repo.setWithExpire("session", "token", 60_000);

// Versioned document helpers
const list = repo.getListDocument<string>("todo");
await list.insert("write docs");
const doc = await list.read(); // { version: 1, content: ["write docs"] }

const map = repo.getMapDocument<number>("scores");
await map.insertOrUpdate("alice", 10);
await map.delete("alice");
```

CJS:

```js
const { InMemoryRepository } = require("@yingyeothon/repository");

const repo = new InMemoryRepository();
repo.set("key", "value").then(() => repo.get("key"));
```

## Public API

- `Repository` (type) — async key-value interface: `get<T>(key)`, `set<T>(key, value)`, `delete(key)`.
- `ExpirableRepository` (type) — extends `Repository` with `setWithExpire<T>(key, value, expiresInMillis)`; a non-positive TTL means "never expires".
- `SimpleRepository` — abstract base class implementing `Repository`, providing `getListDocument<V>(key)` and `getMapDocument<V>(key)` factories.
- `InMemoryRepository` — `SimpleRepository` subclass and `ExpirableRepository` implementation backed by an in-process `Map`.
- `ListDocument<V>` — versioned list stored under a single key: `insert`, `deleteIf`, `truncate`, `read`, `edit`, `view`.
- `MapDocument<V>` — versioned string-keyed map stored under a single key: `insertOrUpdate`, `delete`, `truncate`, `read`, `edit`, `view`.
- `Versioned<T>` (type) — `{ version: number; content: T }` envelope used by the document helpers.
- `Values<V>` (type) — alias for `V[]`, the content type of `ListDocument`.
- `KeyValues<V>` (type) — alias for `Record<string, V>`, the content type of `MapDocument`.

## Migrating from the legacy package

The API is unchanged apart from two additive exports: `Versioned<T>` and `KeyValues<V>` are now exported (they were internal in the legacy package). `InMemoryRepository` now uses a `Map` internally, which removes prototype-key pitfalls of the old plain-object store; observable behavior is identical.

# @yingyeothon/repository

Key-value repository abstractions for asynchronous storage backends: a minimal `Repository` interface, an `ExpirableRepository` extension for TTL-based entries, a `createRepositoryFromKV` building block that turns primitive string get/set/delete operations into a full JSON repository, versioned list/map document helpers, and a `createInMemoryRepository` implementation useful for tests and local development.

## Install

```bash
npm install @yingyeothon/repository
```

## Usage

ESM:

```ts
import {
  createInMemoryRepository,
  createListDocument,
  createMapDocument,
} from "@yingyeothon/repository";

const repo = createInMemoryRepository();
await repo.set("greeting", { hi: "there" });
const value = await repo.get<{ hi: string }>("greeting");

// TTL entries
await repo.setWithExpire("session", "token", 60_000);

// Versioned document helpers
const list = createListDocument<string>({ repository: repo, key: "todo" });
await list.insert("write docs");
const doc = await list.read(); // { version: 1, content: ["write docs"] }

const map = createMapDocument<number>({ repository: repo, key: "scores" });
await map.insertOrUpdate("alice", 10);
await map.delete("alice");
```

CJS:

```js
const { createInMemoryRepository } = require("@yingyeothon/repository");

const repo = createInMemoryRepository();
repo.set("key", "value").then(() => repo.get("key"));
```

Building a repository from primitive string operations (how backends like Redis or S3 plug in):

```ts
import { createRepositoryFromKV } from "@yingyeothon/repository";

const repo = createRepositoryFromKV({
  get: (key) => backend.read(key), // Promise<string | undefined>
  set: (key, serialized) => backend.write(key, serialized),
  delete: (key) => backend.remove(key),
  // Optional; providing it makes the result an ExpirableRepository.
  setWithExpire: (key, serialized, expiresInMillis) =>
    backend.writeWithTTL(key, serialized, expiresInMillis),
});
```

## Public API

- `Repository` (type) — async key-value interface: `get<T>(key)`, `set<T>(key, value)`, `delete(key)`.
- `ExpirableRepository` (type) — extends `Repository` with `setWithExpire<T>(key, value, expiresInMillis)`; a non-positive TTL means "never expires".
- `createRepositoryFromKV(primitives)` — builds a `Repository` from primitive string-valued operations. The primitives contract (`KVPrimitives`): `get(key): Promise<string | undefined>` (`undefined` means "no value"), `set(key, serialized): Promise<void>`, `delete(key): Promise<void>`, and optionally `setWithExpire(key, serialized, expiresInMillis): Promise<void>`. Values are serialized with `JSON.stringify` before `set`/`setWithExpire` and parsed with `JSON.parse` after `get`. When `setWithExpire` is provided the returned object is an `ExpirableRepository`; otherwise the result has no `setWithExpire` member.
- `KVPrimitives` (type) — the primitives contract accepted by `createRepositoryFromKV`.
- `createInMemoryRepository()` — returns an `InMemoryRepository` (an `ExpirableRepository`) backed by an in-process `Map`.
- `InMemoryRepository` (type) — alias for `ExpirableRepository`, the return type of `createInMemoryRepository`.
- `createListDocument<V>(options: ListDocumentOptions)` — returns a `ListDocument<V>`, a versioned list stored under `options.key` in `options.repository`: `insert`, `deleteIf`, `truncate`, `read`, `edit`, `view`.
- `createMapDocument<V>(options: MapDocumentOptions)` — returns a `MapDocument<V>`, a versioned string-keyed map stored under `options.key` in `options.repository`: `insertOrUpdate`, `delete`, `truncate`, `read`, `edit`, `view`.
- `ListDocument<V>` / `MapDocument<V>` (types) — the document interfaces returned by the factories.
- `ListDocumentOptions` / `MapDocumentOptions` (types) — `{ repository: Repository; key: string }`.
- `Versioned<T>` (type) — `{ version: number; content: T }` envelope used by the document helpers.
- `Values<V>` (type) — alias for `V[]`, the content type of `ListDocument`.
- `KeyValues<V>` (type) — alias for `Record<string, V>`, the content type of `MapDocument`.

## Migrating from the legacy package

Classes are gone; every construct is now a factory returning an interface:

- `new InMemoryRepository()` → `createInMemoryRepository()`. `InMemoryRepository` remains exported as a type (equal to `ExpirableRepository`).
- `new ListDocument(repository, key)` → `createListDocument({ repository, key })`. `ListDocument<V>` is now an interface with the same methods.
- `new MapDocument(repository, key)` → `createMapDocument({ repository, key })`. `MapDocument<V>` is now an interface with the same methods.
- `SimpleRepository` (abstract class) is removed. Its `getListDocument`/`getMapDocument` helpers are replaced by the standalone `createListDocument`/`createMapDocument` factories, which work with any `Repository`. Backends that previously subclassed `SimpleRepository` should instead implement primitive string operations and call `createRepositoryFromKV(primitives)`.

Behavior is otherwise unchanged. `Versioned<T>` and `KeyValues<V>` remain exported, and the in-memory store still uses a `Map`, avoiding prototype-key pitfalls of the old plain-object store.

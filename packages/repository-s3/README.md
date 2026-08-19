# @yingyeothon/repository-s3

S3-backed implementation of the `@yingyeothon/repository` abstractions: a `Repository` that stores each value as one S3 object (key = optional prefix + repository key), encodes values with a pluggable `Codec` (JSON by default), and treats a missing key (`NoSuchKey`) as `undefined`. Because it extends `SimpleRepository`, versioned list/map documents work out of the box.

## Install

```bash
npm install @yingyeothon/repository-s3 @aws-sdk/client-s3
```

`@aws-sdk/client-s3` is a peer dependency.

## Usage

ESM:

```ts
import { S3Repository } from "@yingyeothon/repository-s3";

const repo = new S3Repository({
  bucketName: "my-bucket",
  prefix: "app-state/", // optional; prepended verbatim to every key
});

await repo.set("hello", { value: 42 });
const stored = await repo.get<{ value: number }>("hello"); // { value: 42 }
await repo.get("missing"); // undefined (NoSuchKey is swallowed)
await repo.set("hello", undefined); // same as repo.delete("hello")
await repo.delete("hello");

// Versioned documents from @yingyeothon/repository:
const mapDoc = repo.getMapDocument<string>("map-doc");
await mapDoc.insertOrUpdate("key", "value");

// Derive a repository that shares the client/codec but uses another prefix:
const nested = repo.withPrefix("app-state/nested/");
```

CJS:

```js
const { S3Repository } = require("@yingyeothon/repository-s3");
const { S3 } = require("@aws-sdk/client-s3");

const repo = new S3Repository({
  bucketName: "my-bucket",
  s3: new S3({ region: "ap-northeast-2" }), // optional; defaults to new S3()
});
```

## Public API

- `S3Repository` — `SimpleRepository` backed by an S3 bucket:
  - `get<T>(key)` — reads and decodes the object; returns `undefined` when the key does not exist (`NoSuchKey`) or the object has no body; other errors are rethrown (note: without `listObject` permission S3 reports missing keys as `Access Denied`, which is rethrown).
  - `set<T>(key, value)` — encodes and writes the object; `set(key, undefined)` deletes instead.
  - `delete(key)` — removes the object.
  - `withPrefix(prefix)` — new `S3Repository` sharing the same bucket, client, and codec.
  - `getListDocument<V>(key)` / `getMapDocument<V>(key)` — inherited versioned documents.
- `S3RepositoryArguments` — constructor options `{ bucketName, s3?, prefix?, codec? }` (type)

## Migrating from the legacy package

- The package now ships dual ESM/CJS with types; deep imports (`@yingyeothon/repository-s3/lib/...`) are no longer supported — import everything from the package root.
- `S3RepositoryArguments` is now exported (type-only). Behavior is unchanged.

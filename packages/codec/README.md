# @yingyeothon/codec

Tiny codec abstraction: a generic `Codec<B>` interface for encoding domain values into a base representation `B` (and decoding them back), plus a `JsonCodec` implementation that uses JSON strings.

## Install

```bash
npm install @yingyeothon/codec
```

## Usage

ESM:

```ts
import { JsonCodec, type Codec } from "@yingyeothon/codec";

interface Context {
  a: number;
  b: string;
}

const codec: Codec<string> = new JsonCodec();
const encoded = codec.encode<Context>({ a: 10, b: "hello" });
const decoded = codec.decode<Context>(encoded);
```

CJS:

```js
const { JsonCodec } = require("@yingyeothon/codec");

const codec = new JsonCodec();
const encoded = codec.encode({ a: 10, b: "hello" });
const decoded = codec.decode(encoded);
```

## Public API

- `Codec<B>` — interface with `encode<T>(item: T): B` and `decode<T>(value: B): T`.
- `JsonCodec` — `Codec<string>` backed by `JSON.stringify`/`JSON.parse`. Encoding `undefined` returns the literal string `"undefined"`; decoding `undefined` throws; decoding invalid JSON throws a `SyntaxError`.

## Migrating from the legacy package

Same API as the legacy `@yingyeothon/codec` (`Codec<B>` and `JsonCodec` named exports); only the packaging changed (dual ESM/CJS, Node >= 20).

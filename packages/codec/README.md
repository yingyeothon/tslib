# @yingyeothon/codec

Tiny codec abstraction: a generic `Codec<B>` interface for encoding domain values into a base representation `B` (and decoding them back), plus a `jsonCodec` implementation that uses JSON strings.

## Install

```bash
npm install @yingyeothon/codec
```

## Usage

ESM:

```ts
import { jsonCodec, type Codec } from "@yingyeothon/codec";

interface Context {
  a: number;
  b: string;
}

const codec: Codec<string> = jsonCodec;
const encoded = codec.encode<Context>({ a: 10, b: "hello" });
const decoded = codec.decode<Context>(encoded);
```

CJS:

```js
const { jsonCodec } = require("@yingyeothon/codec");

const encoded = jsonCodec.encode({ a: 10, b: "hello" });
const decoded = jsonCodec.decode(encoded);
```

## Public API

- `Codec<B>` — interface with `encode<T>(item: T): B` and `decode<T>(value: B): T`.
- `jsonCodec` — stateless `Codec<string>` singleton backed by `JSON.stringify`/`JSON.parse`. Encoding `undefined` returns the literal string `"undefined"`; decoding `undefined` throws; decoding invalid JSON throws a `SyntaxError`.

## Migrating from the legacy package

The legacy `JsonCodec` class is replaced by the stateless `jsonCodec` const: replace `new JsonCodec()` with `jsonCodec`. The `Codec<B>` interface is unchanged; packaging is dual ESM/CJS, Node >= 20.

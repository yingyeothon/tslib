# @yingyeothon/logger

Minimal structured logger with severity filtering, writer composition, and pluggable log writers. Built for tiny serverless bundles: zero dependencies, a few hundred bytes of code.

## Install

```bash
npm install @yingyeothon/logger
```

## Usage

ESM:

```ts
import {
  ConsoleLogger,
  FilteredLogger,
  combine,
  nullLogger,
} from "@yingyeothon/logger";

const logger = new ConsoleLogger("info");
logger.debug("dropped: below severity");
logger.info("hello", { requestId: "r-1" });
logger.error("boom", new Error("bad"));

// Compose multiple writers and filter them together.
const buffered: string[] = [];
const audit = new FilteredLogger(
  "debug",
  combine(
    {
      debug: () => {},
      info: (...a) => buffered.push(a.join(" ")),
      error: console.error,
    },
    nullLogger, // combine() skips the null logger
  ),
);
audit.info("stored");
```

CJS:

```js
const { ConsoleLogger } = require("@yingyeothon/logger");
const logger = new ConsoleLogger("debug");
logger.debug("visible now");
```

## Public API

- `LogSeverity` — `"none" | "debug" | "info" | "error"` (type)
- `LogWriter` — `{ debug, info, error }` sink interface (type)
- `Logger` — `LogWriter` plus a mutable `severity` field (type)
- `FilteredLogger` — writes to a `LogWriter` only when the record's severity is at or above `severity`
- `ConsoleLogger` — `FilteredLogger` bound to the console writer (default severity `"info"`)
- `consoleWriter` — `LogWriter` backed by `console.debug/info/error`
- `combine(...writers)` — fan-out writer; skips `nullLogger`
- `nullLogger` — a `Logger` that drops everything

## Migrating from the legacy package

- The package now ships dual ESM/CJS with types; deep imports (`@yingyeothon/logger/lib/...`) are no longer supported — import everything from the package root.
- `Logger`, `LogSeverity`, and `LogWriter` are type-only exports.

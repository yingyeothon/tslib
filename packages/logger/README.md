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
  combine,
  createConsoleLogger,
  createFilteredLogger,
  nullLogger,
} from "@yingyeothon/logger";

const logger = createConsoleLogger("info");
logger.debug("dropped: below severity");
logger.info("hello", { requestId: "r-1" });
logger.error("boom", new Error("bad"));

// Compose multiple writers and filter them together.
const buffered: string[] = [];
const audit = createFilteredLogger({
  severity: "debug",
  writer: combine(
    {
      debug: () => {},
      info: (...a) => buffered.push(a.join(" ")),
      warn: console.warn,
      error: console.error,
    },
    nullLogger, // combine() skips the null logger
  ),
});
audit.info("stored");
```

CJS:

```js
const { createConsoleLogger } = require("@yingyeothon/logger");
const logger = createConsoleLogger("debug");
logger.debug("visible now");
```

## Public API

- `createConsoleLogger(severity?)` — `Logger` filtering the console writer (default severity `"info"`)
- `createFilteredLogger(options)` — `Logger` that writes to `options.writer` only when the record's severity is at or above the logger's (mutable) `severity`
- `combine(...writers)` — fan-out writer; skips `nullLogger`
- `consoleWriter` — `LogWriter` backed by `console.debug/info/warn/error`
- `nullLogger` — a `Logger` that drops everything
- Types: `LogSeverity` (`"none" | "debug" | "info" | "warn" | "error"`), `LogWriter` (`{ debug, info, warn, error }` sink interface), `Logger` (`LogWriter` plus a mutable `severity` field), `FilteredLoggerOptions` (`{ severity, writer }`)

## Migrating from the legacy package

- The exported classes are gone: `new ConsoleLogger(severity)` becomes `createConsoleLogger(severity)` and `new FilteredLogger(severity, writer)` becomes `createFilteredLogger({ severity, writer })`. The returned objects are plain `Logger` values with the same behavior, including the mutable `severity` field.
- `warn` was added to the contract: `LogWriter` sinks must provide `debug/info/warn/error`, and `LogSeverity` gained `"warn"`.
- The package now ships dual ESM/CJS with types; deep imports (`@yingyeothon/logger/lib/...`) are no longer supported — import everything from the package root.
- `Logger`, `LogSeverity`, and `LogWriter` are type-only exports.

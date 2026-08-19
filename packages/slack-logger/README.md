# @yingyeothon/slack-logger

Structured logger that writes leveled records to the console and batches them onto a single promise chain that posts each record to a Slack incoming webhook, so serverless handlers can `flushSlack()` before exiting. Configuration comes from environment variables (`SLACK_WEBHOOK_URL`, `SLACK_CHANNEL`, `SLACK_USER_NAME`, `CONSOLE_LOG_LEVEL`, `SLACK_LOG_LEVEL`); when `SLACK_WEBHOOK_URL` is missing, Slack delivery is silently skipped.

## Install

```bash
npm install @yingyeothon/slack-logger
```

## Usage

ESM:

```ts
import {
  getLogger,
  useLogger,
  flushSlack,
  LogLevel,
} from "@yingyeothon/slack-logger";

const logger = getLogger("api", "handler.ts");
logger.info({ requestId: "r-1" }, "request accepted");
logger.error({ error: new Error("boom") }, "request failed"); // Error values are serialized.

// Custom levels instead of the env-driven defaults (console: trace, slack: warn).
const verbose = useLogger({
  componentName: "api",
  fileName: "handler.ts",
  consoleLevel: LogLevel.debug,
  slackLevel: LogLevel.error,
  maxSlackTextLength: 24 * 1024,
});

// Wait for all queued Slack posts before the process exits.
await logger.flushSlack(); // or the module-level flushSlack()
```

CJS:

```js
const { getLogger } = require("@yingyeothon/slack-logger");
const logger = getLogger("worker", "index.js");
logger.warn({ jobId: 7 }, "retrying");
logger.flushSlack().then(() => process.exit(0));
```

Each Slack message looks like `[WARN] retrying` followed by a fenced JSON block containing `timestamp`, `componentName`, `fileName`, and `context`.

## Public API

- `getLogger(componentName, fileName)` — logger with env-driven defaults.
- `useLogger({ componentName, fileName, consoleLevel?, slackLevel?, maxSlackTextLength? })` — logger with explicit configuration.
- `flushSlack()` — awaits every Slack post queued so far (also available as `logger.flushSlack`).
- `asYlogger(logger)` — adapts a slack logger to the `@yingyeothon/logger` `Logger` interface.
- `LogLevel` — level constants (`trace`=1 … `fatal`=6, `silent`=99).
- `parseLogLevel(input?)` — level name to value, defaults to `info`.
- `toLogLevelName(level)` — level value back to its name.
- Types: `Logger`, `LogLevels`, `LogLevelValue`, `FlushSlack`, `LogWriter`, `LogWritePosition`, `LogWriteConfig`.

## Migrating from the legacy package

- Named exports only; `import getLogger from ...` becomes `import { getLogger } from ...`.
- `LogLevel` is now a plain `as const` object instead of a `const enum`; values are unchanged, and the level type for parameters is `LogLevelValue`.
- Environment variables are read lazily at call time instead of being captured at import time.
- `node-fetch` was replaced by the global `fetch` (Node >= 20); the webhook payload and record format are unchanged.
- `asYlogger`, `parseLogLevel`, and `toLogLevelName` are now part of the public API.

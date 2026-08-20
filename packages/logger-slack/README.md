# @yingyeothon/logger-slack

Slack incoming-webhook backend for the `@yingyeothon/logger` contract. `createSlackLogWriter` returns a `LogWriter` that batches every record onto a single promise chain posting to the webhook, plus a `flush()` handle so serverless handlers can await delivery before exiting. `createSlackLogger` wraps it in a severity-filtered `Logger`. When `webhookUrl` is missing, Slack delivery is silently skipped; library code reads no environment variables — use `slackLogWriterOptionsFromEnv()` if you want the classic env-based configuration.

## Install

```bash
npm install @yingyeothon/logger-slack
```

## Usage

ESM:

```ts
import {
  createSlackLogger,
  slackLogWriterOptionsFromEnv,
} from "@yingyeothon/logger-slack";

const logger = createSlackLogger({
  webhookUrl: "https://hooks.slack.com/services/T000/B000/XXX",
  channel: "#alerts",
  userName: "yyt-bot",
  severity: "warn", // default; debug/info are filtered out
  withConsole: true, // also mirror records to the console
});

logger.info("request accepted", { requestId: "r-1" });
logger.error("request failed", { error: new Error("boom") }); // Error values are serialized.

// Or take webhookUrl/channel/userName from SLACK_WEBHOOK_URL etc.:
// const logger = createSlackLogger(slackLogWriterOptionsFromEnv());

// Wait for all queued Slack posts before the process exits.
await logger.flush();
```

CJS:

```js
const { createSlackLogWriter } = require("@yingyeothon/logger-slack");
const writer = createSlackLogWriter({
  webhookUrl: process.env.SLACK_WEBHOOK_URL,
});
writer.warn("retrying", { jobId: 7 });
writer.flush().then(() => process.exit(0));
```

Each Slack message looks like `[WARN] retrying` followed by a fenced JSON block containing `timestamp` and `context` (the arguments after the message; omitted when there are none).

## Public API

- `createSlackLogWriter(options?)` — `LogWriter` (`debug`/`info`/`warn`/`error`, variadic) plus `flush(): Promise<void>`; options: `webhookUrl?`, `channel?`, `userName?` (default `"Logger"`), `maxTextLength?` (default 24 KiB), `onDeliveryError?`.
- `createSlackLogger(options?)` — severity-filtered `Logger` plus `flush()`; adds `severity?` (default `"warn"`) and `withConsole?` (combine with `consoleWriter`) to the writer options.
- `slackLogWriterOptionsFromEnv()` — opt-in helper reading `SLACK_WEBHOOK_URL`, `SLACK_CHANNEL`, `SLACK_USER_NAME`.
- Types: `SlackLogWriter`, `SlackLogWriterOptions`, `SlackLogger`, `SlackLoggerOptions`.

## Migrating from the legacy package

The package was renamed on npm: `@yingyeothon/slack-logger` → `@yingyeothon/logger-slack`, and the API was redesigned around the shared `@yingyeothon/logger` contract.

- Seven levels (`trace`…`silent`) became the shared four (`debug`, `info`, `warn`, `error`) with a `severity` filter (`"none"` disables everything); `LogLevel`, `parseLogLevel`, and `toLogLevelName` are gone.
- Call style flipped from `(context, message)` to message-first variadic: `logger.error("failed", { requestId })`.
- `getLogger`/`useLogger`/`flushSlack`/`asYlogger` were replaced by `createSlackLogWriter`/`createSlackLogger`; the adapter is unnecessary because the writer _is_ a `@yingyeothon/logger` `LogWriter`.
- Configuration is injected via options instead of read from `process.env`; use `slackLogWriterOptionsFromEnv()` to keep the env-driven behavior. `CONSOLE_LOG_LEVEL`/`SLACK_LOG_LEVEL` have no replacement — pass `severity`.
- Pending Slack sends are stored per writer instead of in a module-global chain; call `flush()` on the writer/logger you created. Webhook failures are swallowed (report them via `onDeliveryError`), and the caller's context objects are no longer mutated when errors are serialized.
- A typical port: `getLogger("api", "handler.ts")` + `logger.error({ error }, "request failed")` + `await logger.flushSlack()` becomes `createSlackLogger(slackLogWriterOptionsFromEnv())` + `logger.error("request failed", { error })` + `await logger.flush()`.

# @yingyeothon/logger-s3

Buffered log writer that flushes structured JSON log records into S3 through an [s3-cache-bridge](https://github.com/yingyeothon/s3-cache-bridge) server. Records are buffered in memory, auto-flushed by time or buffer size, aggregated per S3 key, and appended as JSON lines — with a Lambda-flavored variant that stamps each record with system/handler/lambda identity.

## Install

```bash
npm install @yingyeothon/logger-s3
```

## Usage

ESM:

```ts
import { getS3Logger } from "@yingyeothon/logger-s3";

const { logger, flush } = getS3Logger({
  apiUrl: "https://s3cb.example.com/",
  apiId: "id",
  apiPassword: "password",
  asKey: (date, severity) => `logging/myapp/${severity}`,
  severity: "info",
  autoFlushIntervalMillis: 10_000,
  autoFlushMaxBufferSize: 1024,
  withConsole: true,
});

logger.info("hello", { requestId: "r-1" });
logger.error("boom", new Error("bad")); // Errors are serialized with serialize-error.
await flush(); // Appends buffered records to S3, one JSON line per record.
```

Lambda variant (CJS shown):

```js
const { getLambdaS3Logger } = require("@yingyeothon/logger-s3");

const { logger, flush, updateSystemId } = getLambdaS3Logger({
  systemName: "HelloWorld",
  handlerName: "testHandler",
  lambdaId: context.awsRequestId,
  logKeyPrefix: "logging",
  apiUrl: process.env.S3CB_URL, // also read from S3CB_URL/S3CB_ID/S3CB_PASSWORD by default
});

logger.info("started");
updateSystemId("game-1234"); // Applies to all records still in the buffer.
await flush(); // Call before the Lambda handler returns.
```

## Record format

Default serializer (`serializeAsJSON`), one line per record:

```json
{
  "level": "info",
  "timestamp": "2026-08-20T00:00:00.000Z",
  "args": ["hello", { "requestId": "r-1" }]
}
```

Lambda serializer:

```json
{
  "timestamp": "...",
  "level": "info",
  "systemName": "HelloWorld",
  "systemId": "game-1234",
  "handlerName": "testHandler",
  "lambdaId": "...",
  "args": ["started"]
}
```

Records sharing the same key are concatenated and sent as a single `append` call per flush.

## Public API

- `getS3Logger(env)` — buffered S3 logger; returns `{ logger, flush }` (`S3Logger`)
- `getLambdaS3Logger(env)` — Lambda-flavored logger; returns `{ logger, flush, updateSystemId }` (`LambdaS3Logger`)
- `getS3LogWriter(env)` — the underlying `LogWriter` plus `flush` (`S3LogWriter`)
- `buffered(env)` — in-memory buffering with auto-flush by interval/size (`BufferedEnv`, `BufferedWriter`)
- `s3cbLogFlush(env)` — flush function that appends aggregated records via s3-cache-bridge (`S3cbLogFlushEnv`, `LogFlush`)
- `serializeAsJSON` — default record serializer
- Types: `S3Logger`, `S3LoggerEnv`, `LambdaS3Logger`, `LambdaS3LoggerEnv`, `S3LogWriter`, `S3LogWriterEnv`, `BufferedEnv`, `BufferedWriter`, `S3cbLogFlushEnv`, `LogFlush`, `LogSerializer`, `LogTuple`, `WritableLogSeverity`

## Migrating from the legacy package

- Named exports only: the default export `getS3Logger` is now `import { getS3Logger }`, and `LambdaS3Logger` (function) is now `getLambdaS3Logger`; the `ILambdaS3Logger` interface is renamed to `LambdaS3Logger`.
- Deep imports (`@yingyeothon/logger-s3/lib/...`) are no longer supported — import everything from the package root.
- `S3cbLogFlushEnv` (formerly `S3CBLogFlushEnv`) accepts an optional `client: S3cbClient` to inject a preconfigured or fake s3-cache-bridge client; `apiUrl`/`S3CB_URL` is only required when no client is given.
- Record format, flush semantics (aggregation per key, chained sequential flushes, auto-flush triggers), and environment variable defaults (`S3CB_URL`, `S3CB_ID`, `S3CB_PASSWORD`) are unchanged.

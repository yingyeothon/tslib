import type {
  S3cbClient,
  S3cbClientOptions,
} from "@yingyeothon/s3-cache-bridge-client";
import {
  createS3cbClient,
  s3cbClientOptionsFromEnv,
} from "@yingyeothon/s3-cache-bridge-client";

import { aggregate, createDebugPrint } from "./internal.js";
import { serializeAsJSON } from "./serialize.js";
import type { LogSerializer, LogTuple } from "./types.js";

export type S3cbLogFlushOptions = Partial<S3cbClientOptions> & {
  serializer?: LogSerializer;
  /** Injectable client for testing; defaults to `S3cb` built from the options. */
  client?: S3cbClient;
  /** Prints internal flush diagnostics to the console when true. */
  debug?: boolean;
};

export type LogFlush = (
  logs: LogTuple[],
  timestamp: number,
) => Promise<unknown>;

/**
 * Reads the documented environment variables (`S3CB_URL`, `S3CB_ID`,
 * `S3CB_PASSWORD`) and returns the corresponding connection options.
 * Calling this is the caller's explicit choice; library code itself never
 * reads `process.env`.
 */
export function s3cbLogFlushOptionsFromEnv(): S3cbClientOptions {
  return s3cbClientOptionsFromEnv();
}

export function createS3cbLogFlush({
  apiUrl,
  apiId,
  apiPassword,
  serializer = serializeAsJSON,
  client,
  debug = false,
}: S3cbLogFlushOptions): LogFlush {
  const debugPrint = createDebugPrint(debug);
  let s3cb: S3cbClient;
  if (client !== undefined) {
    s3cb = client;
  } else if (apiUrl !== undefined) {
    s3cb = createS3cbClient({ apiUrl, apiId, apiPassword });
  } else {
    throw new Error("No URL for S3CB");
  }
  let promise: Promise<void> = Promise.resolve();

  return function flush(logs: LogTuple[], timestamp: number) {
    if (logs.length === 0) {
      debugPrint("S3CB", "Nothing to flush", timestamp);
      return Promise.resolve();
    }
    const tuples = logs.map((log) => ({
      key: log.key,
      body: serializer(log.timestamp, log.severity, log.args),
    }));

    const bag = aggregate(tuples);
    return (promise = promise.then(async () => {
      debugPrint("S3CB", "Do flush", timestamp, bag);
      await Promise.all(
        Object.entries(bag).map(([key, body]) => s3cb.append(key, body)),
      );
    }));
  };
}

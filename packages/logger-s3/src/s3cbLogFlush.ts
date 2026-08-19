import type { S3cbClient, S3cbEnv } from "@yingyeothon/s3-cache-bridge-client";
import { S3cb } from "@yingyeothon/s3-cache-bridge-client";

import { aggregate, debugPrint } from "./internal.js";
import { serializeAsJSON } from "./serialize.js";
import type { LogSerializer, LogTuple } from "./types.js";

export type S3cbLogFlushEnv = Partial<S3cbEnv> & {
  serializer?: LogSerializer;
  /** Injectable client for testing; defaults to `S3cb` built from the env. */
  client?: S3cbClient;
};

export type LogFlush = (
  logs: LogTuple[],
  timestamp: number,
) => Promise<unknown>;

export function s3cbLogFlush({
  apiUrl = process.env.S3CB_URL,
  apiId = process.env.S3CB_ID,
  apiPassword = process.env.S3CB_PASSWORD,
  serializer = serializeAsJSON,
  client,
}: S3cbLogFlushEnv): LogFlush {
  let s3cb: S3cbClient;
  if (client !== undefined) {
    s3cb = client;
  } else if (apiUrl !== undefined) {
    s3cb = S3cb({ apiUrl, apiId, apiPassword });
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

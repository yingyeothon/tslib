import { serializeError } from "serialize-error";

import { yyyyMMdd } from "./internal.js";
import type { S3Logger, S3LoggerOptions } from "./logger.js";
import { createS3Logger } from "./logger.js";
import type { LogTuple, WritableLogSeverity } from "./types.js";

interface LambdaInfo {
  systemName?: string;
  systemId?: string;
  handlerName?: string;
  lambdaId?: string;
}

export type LambdaS3LoggerOptions = Omit<S3LoggerOptions, "asKey"> &
  LambdaInfo & {
    logKeyPrefix?: string;
    asKey?: S3LoggerOptions["asKey"];
  };

export interface LambdaS3Logger extends S3Logger {
  updateSystemId: (systemId: string) => void;
}

export function createLambdaS3Logger(
  options: LambdaS3LoggerOptions,
): LambdaS3Logger {
  const { systemName, handlerName, lambdaId } = options;
  function serialize(
    timestamp: Date,
    level: WritableLogSeverity,
    args: unknown[],
  ) {
    return (
      JSON.stringify({
        timestamp: timestamp.toISOString(),
        level,
        systemName,
        systemId: options.systemId,
        handlerName,
        lambdaId,
        args: args.map((arg) =>
          arg instanceof Error ? serializeError(arg) : arg,
        ),
      }) + "\n"
    );
  }

  function writeConsole({ timestamp, severity, args }: Omit<LogTuple, "key">) {
    console[severity](
      timestamp.toISOString(),
      severity.toUpperCase(),
      ...[systemName, options.systemId, handlerName, lambdaId].map((v) =>
        v === undefined ? "null" : v,
      ),
      ...args,
    );
  }

  function updateSystemId(systemId: string) {
    options.systemId = systemId;
  }

  if (!options.asKey && !options.logKeyPrefix && !options.systemName) {
    throw new Error(
      "Please set one of `asKey`, `logKeyPrefix` and `systemName` at least",
    );
  }

  const s3Logger = createS3Logger({
    asKey: () =>
      [options.logKeyPrefix, systemName, yyyyMMdd()].filter(Boolean).join("/"),
    serializer: serialize,
    withConsole: writeConsole,
    ...options,
  });
  return { ...s3Logger, updateSystemId };
}

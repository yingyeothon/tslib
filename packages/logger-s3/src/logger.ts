import type { Logger, LogSeverity } from "@yingyeothon/logger";
import { FilteredLogger } from "@yingyeothon/logger";

import type { S3LogWriterEnv } from "./writer.js";
import { getS3LogWriter } from "./writer.js";

export type S3LoggerEnv = S3LogWriterEnv & {
  severity?: LogSeverity;
};

export interface S3Logger {
  logger: Logger;
  flush: () => Promise<unknown>;
}

export function getS3Logger(env: S3LoggerEnv): S3Logger {
  const s3Writer = getS3LogWriter(env);
  return {
    logger: new FilteredLogger(env.severity ?? "info", s3Writer),
    flush: s3Writer.flush,
  };
}

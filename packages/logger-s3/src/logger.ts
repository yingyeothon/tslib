import type { Logger, LogSeverity } from "@yingyeothon/logger";
import { createFilteredLogger } from "@yingyeothon/logger";

import type { S3LogWriterOptions } from "./writer.js";
import { createS3LogWriter } from "./writer.js";

export type S3LoggerOptions = S3LogWriterOptions & {
  severity?: LogSeverity;
};

export interface S3Logger {
  logger: Logger;
  flush: () => Promise<unknown>;
}

export function createS3Logger(options: S3LoggerOptions): S3Logger {
  const s3Writer = createS3LogWriter(options);
  return {
    logger: createFilteredLogger({
      severity: options.severity ?? "info",
      writer: s3Writer,
    }),
    flush: s3Writer.flush,
  };
}

import type { LogWriter } from "@yingyeothon/logger";

import type { BufferedWriterOptions } from "./buffered.js";
import { createBufferedWriter } from "./buffered.js";
import type { S3cbLogFlushOptions } from "./s3cbLogFlush.js";
import { createS3cbLogFlush } from "./s3cbLogFlush.js";

export type S3LogWriterOptions = S3cbLogFlushOptions &
  Omit<BufferedWriterOptions, "onAutoFlush">;

export interface S3LogWriter extends LogWriter {
  flush: () => Promise<unknown>;
}

export function createS3LogWriter(options: S3LogWriterOptions): S3LogWriter {
  const s3cbFlush = createS3cbLogFlush(options);
  const { write: bufferWrite, flush: bufferFlush } = createBufferedWriter({
    ...options,
    onAutoFlush: s3cbFlush,
  });
  return {
    debug: bufferWrite("debug"),
    info: bufferWrite("info"),
    warn: bufferWrite("warn"),
    error: bufferWrite("error"),
    flush: () => s3cbFlush(bufferFlush(), Date.now()),
  };
}

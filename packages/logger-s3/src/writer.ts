import type { LogWriter } from "@yingyeothon/logger";

import type { BufferedEnv } from "./buffered.js";
import { buffered } from "./buffered.js";
import type { S3cbLogFlushEnv } from "./s3cbLogFlush.js";
import { s3cbLogFlush } from "./s3cbLogFlush.js";

export type S3LogWriterEnv = S3cbLogFlushEnv & Omit<BufferedEnv, "onAutoFlush">;

export interface S3LogWriter extends LogWriter {
  flush: () => Promise<unknown>;
}

export function getS3LogWriter(env: S3LogWriterEnv): S3LogWriter {
  const s3cbFlush = s3cbLogFlush(env);
  const { write: bufferWrite, flush: bufferFlush } = buffered({
    ...env,
    onAutoFlush: s3cbFlush,
  });
  return {
    debug: bufferWrite("debug"),
    info: bufferWrite("info"),
    error: bufferWrite("error"),
    flush: () => s3cbFlush(bufferFlush(), Date.now()),
  };
}

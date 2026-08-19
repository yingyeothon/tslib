import type { LogSeverity } from "@yingyeothon/logger";

/** Severities that can actually be written (everything except `"none"`). */
export type WritableLogSeverity = Exclude<LogSeverity, "none">;

/** A single buffered log record before it is serialized and flushed. */
export interface LogTuple {
  key: string;
  timestamp: Date;
  severity: WritableLogSeverity;
  args: unknown[];
}

/** Serializes one log record into the string appended to its S3 object. */
export type LogSerializer = (
  timestamp: Date,
  level: WritableLogSeverity,
  args: unknown[],
) => string;

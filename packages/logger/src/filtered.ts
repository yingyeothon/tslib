import type { Logger, LogSeverity, LogWriter } from "./types.js";

const levels: Record<LogSeverity, number> = {
  none: Number.POSITIVE_INFINITY,
  debug: 100,
  info: 500,
  warn: 700,
  error: 900,
};

export interface FilteredLoggerOptions {
  severity: LogSeverity;
  writer: LogWriter;
}

export function createFilteredLogger({
  severity,
  writer,
}: FilteredLoggerOptions): Logger {
  const write =
    (level: Exclude<LogSeverity, "none">) =>
    (...args: unknown[]): void => {
      if (levels[level] >= levels[logger.severity]) {
        writer[level](...args);
      }
    };
  const logger: Logger = {
    severity,
    debug: write("debug"),
    info: write("info"),
    warn: write("warn"),
    error: write("error"),
  };
  return logger;
}

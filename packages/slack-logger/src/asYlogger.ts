import type {
  Logger as YLogger,
  LogSeverity as YLogSeverity,
} from "@yingyeothon/logger";
import type { Logger } from "./Logger.js";
import type { LogLevels } from "./logLevel.js";

export function asYlogger(logger: Logger): YLogger {
  function adapter(level: Extract<LogLevels, "debug" | "info" | "error">) {
    return function (...args: unknown[]): void {
      logger[level]({}, args.join(" "));
    };
  }
  return {
    severity: (process.env.SLACK_LOG_LEVEL ??
      process.env.CONSOLE_LOG_LEVEL ??
      "info") as YLogSeverity,
    debug: adapter("debug"),
    info: adapter("info"),
    error: adapter("error"),
  };
}

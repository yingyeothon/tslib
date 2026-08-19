import { envs } from "./envs.js";
import { flushSlack } from "./flushSlack.js";
import type { Logger } from "./Logger.js";
import { LogLevel, parseLogLevel } from "./logLevel.js";
import type { LogWriteConfig, LogWritePosition } from "./writeLogWith.js";
import { writeLogWith } from "./writeLogWith.js";

export function useLogger({
  componentName,
  fileName,
  consoleLevel = envs.consoleLogLevel
    ? parseLogLevel(envs.consoleLogLevel)
    : LogLevel.trace,
  slackLevel = envs.slackLogLevel
    ? parseLogLevel(envs.slackLogLevel)
    : LogLevel.warn,
  maxSlackTextLength = 24 * 1024,
}: LogWritePosition & Partial<LogWriteConfig>): Logger {
  const writeLogWithLevel = writeLogWith({
    componentName,
    fileName,
    consoleLevel,
    slackLevel,
    maxSlackTextLength,
  });
  return {
    trace: writeLogWithLevel(LogLevel.trace),
    debug: writeLogWithLevel(LogLevel.debug),
    info: writeLogWithLevel(LogLevel.info),
    warn: writeLogWithLevel(LogLevel.warn),
    error: writeLogWithLevel(LogLevel.error),
    fatal: writeLogWithLevel(LogLevel.fatal),
    silent: writeLogWithLevel(LogLevel.silent),
    flushSlack,
  };
}

import { createFilteredLogger } from "./filtered.js";
import type { Logger, LogSeverity, LogWriter } from "./types.js";

export const consoleWriter: LogWriter = {
  debug: (...args) => console.debug(...args),
  info: (...args) => console.info(...args),
  warn: (...args) => console.warn(...args),
  error: (...args) => console.error(...args),
};

export function createConsoleLogger(severity: LogSeverity = "info"): Logger {
  return createFilteredLogger({ severity, writer: consoleWriter });
}

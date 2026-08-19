import { FilteredLogger } from "./filtered.js";
import type { LogSeverity, LogWriter } from "./types.js";

export const consoleWriter: LogWriter = {
  debug: (...args) => console.debug(...args),
  info: (...args) => console.info(...args),
  error: (...args) => console.error(...args),
};

export class ConsoleLogger extends FilteredLogger {
  constructor(severity: LogSeverity = "info") {
    super(severity, consoleWriter);
  }
}

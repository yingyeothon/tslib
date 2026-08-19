export type LogSeverity = "none" | "debug" | "info" | "error";

export interface LogWriter {
  debug: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

export interface Logger extends LogWriter {
  severity: LogSeverity;
}

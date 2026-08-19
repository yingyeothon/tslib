import type { Logger, LogSeverity, LogWriter } from "./types.js";

const levels: Record<LogSeverity, number> = {
  none: Number.POSITIVE_INFINITY,
  debug: 100,
  info: 500,
  error: 900,
};

export class FilteredLogger implements Logger {
  constructor(
    public severity: LogSeverity,
    private readonly writer: LogWriter,
  ) {}

  public debug = (...args: unknown[]): void => this.write("debug", ...args);
  public info = (...args: unknown[]): void => this.write("info", ...args);
  public error = (...args: unknown[]): void => this.write("error", ...args);

  private write(severity: Exclude<LogSeverity, "none">, ...args: unknown[]) {
    if (levels[severity] >= levels[this.severity]) {
      this.writer[severity](...args);
    }
  }
}

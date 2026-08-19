import { nullLogger } from "./null.js";
import type { LogWriter } from "./types.js";

export function combine(...writers: LogWriter[]): LogWriter {
  const targets = writers.filter((writer) => writer !== nullLogger);
  const write =
    (severity: keyof LogWriter) =>
    (...args: unknown[]): void => {
      for (const writer of targets) {
        writer[severity](...args);
      }
    };
  return { debug: write("debug"), info: write("info"), error: write("error") };
}

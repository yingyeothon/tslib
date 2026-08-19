import { debugPrint } from "./internal.js";
import type { LogTuple, WritableLogSeverity } from "./types.js";

export interface BufferedEnv {
  asKey: (date: Date, severity: WritableLogSeverity) => string;
  autoFlushIntervalMillis?: number;
  autoFlushMaxBufferSize?: number;
  onAutoFlush: (tuples: LogTuple[], timestamp: number) => unknown;
  withConsole?: boolean | ((tuple: Omit<LogTuple, "key">) => void);
}

export interface BufferedWriter {
  write: (severity: WritableLogSeverity) => (...args: unknown[]) => void;
  flush: () => LogTuple[];
}

export function buffered({
  asKey,
  autoFlushIntervalMillis = 10 * 1000,
  autoFlushMaxBufferSize = 1024,
  onAutoFlush,
  withConsole = false,
}: BufferedEnv): BufferedWriter {
  let lastFlushed = Date.now();
  let buffer: LogTuple[] = [];

  function isAutoFlushable() {
    return (
      Date.now() - lastFlushed > autoFlushIntervalMillis ||
      buffer.length > autoFlushMaxBufferSize
    );
  }

  function write(severity: WritableLogSeverity) {
    return (...args: unknown[]) => {
      const now = new Date();
      buffer.push({
        key: asKey(now, severity),
        timestamp: now,
        severity,
        args,
      });

      // Support console bypass.
      if (typeof withConsole === "boolean") {
        if (withConsole) {
          console[severity](now.toISOString(), severity, ...args);
        }
      } else {
        withConsole({ timestamp: now, severity, args });
      }

      if (isAutoFlushable()) {
        const timestamp = Date.now();
        debugPrint("BUFFERED", "Try to auto flush", timestamp);
        const flushed = flush();
        if (flushed.length > 0) {
          debugPrint("BUFFERED", "Do auto flush", timestamp);
          onAutoFlush(flushed, timestamp);
        } else {
          debugPrint("BUFFERED", "Nothing to auto flush", timestamp);
        }
      }
    };
  }

  function flush() {
    const logs = buffer;
    buffer = [];
    lastFlushed = Date.now();
    return logs;
  }

  return { write, flush };
}

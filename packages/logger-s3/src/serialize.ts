import { serializeError } from "serialize-error";

import type { LogSerializer, WritableLogSeverity } from "./types.js";

export const serializeAsJSON: LogSerializer = (
  timestamp: Date,
  level: WritableLogSeverity,
  args: unknown[],
): string =>
  JSON.stringify({
    level,
    timestamp: timestamp.toISOString(),
    args: args.map((arg) => (arg instanceof Error ? serializeError(arg) : arg)),
  }) + "\n";

import type { LogWriter } from "@yingyeothon/logger";
import type { TracerClient, TracerLevel } from "./types.js";

export interface TracerLogWriterOptions {
  /** Also remember each line as a breadcrumb in category `log`; default `true`. */
  breadcrumbs?: boolean;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

/**
 * The `logger` call style (message first, structured context after) as a
 * message and attributes: plain objects are merged, an `Error` becomes
 * `error.type`/`error.message`, anything else is `arg1`, `arg2`, ….
 */
function split(args: unknown[]): {
  message: string;
  attributes: Record<string, unknown>;
} {
  const attributes: Record<string, unknown> = {};
  let message = "";
  args.forEach((arg, i) => {
    if (i === 0 && typeof arg === "string") {
      message = arg;
    } else if (arg instanceof Error) {
      attributes["error.type"] = arg.name;
      attributes["error.message"] = arg.message;
      if (message === "") message = `${arg.name}: ${arg.message}`;
    } else if (isPlainObject(arg)) {
      Object.assign(attributes, arg);
    } else {
      attributes[`arg${i}`] = arg;
    }
  });
  return { message, attributes };
}

/**
 * A `@yingyeothon/logger` `LogWriter` that forwards every line to `client`
 * as a log line (and, by default, a breadcrumb in category `log`). Compose
 * it with `combine` and `createFilteredLogger`. Do not hand the logger it
 * feeds to the same client's `logger` option: the client ignores its own
 * lines, but the loop is still pointless.
 */
export function createTracerLogWriter(
  client: TracerClient,
  options: TracerLogWriterOptions = {},
): LogWriter {
  const breadcrumbs = options.breadcrumbs !== false;
  const write =
    (level: TracerLevel) =>
    (...args: unknown[]): void => {
      try {
        if (!client.enabled) return;
        const { message, attributes } = split(args);
        if (breadcrumbs) {
          client.breadcrumb("log", message, { data: attributes, level });
        }
        client.log(level, message, attributes);
      } catch {
        // A log line must never fail the caller.
      }
    };
  return {
    debug: write("debug"),
    info: write("info"),
    warn: write("warning"),
    error: write("error"),
  };
}

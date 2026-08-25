import type { Logger } from "@yingyeothon/logger";

/**
 * Captures every log line as text, for "this must never be logged" tests.
 *
 * Errors are flattened to name + message + stack wherever they appear,
 * including nested inside a context object: `JSON.stringify(new Error(s))`
 * is `{}`, so a stringified haystack hides exactly the leak these tests
 * exist to catch — and `logger.error("…", { error })` is the shape that
 * actually occurs.
 */
export function capturingLogger(): { logger: Logger; text: () => string } {
  const lines: string[] = [];
  const capture = (...args: unknown[]): void => {
    lines.push(args.map(flatten).join(" "));
  };
  return {
    logger: {
      severity: "debug",
      debug: capture,
      info: capture,
      warn: capture,
      error: capture,
    },
    text: () => lines.join("\n"),
  };
}

function flatten(value: unknown): string {
  if (value instanceof Error) {
    return `${value.name}: ${value.message} ${value.stack ?? ""}`;
  }
  return JSON.stringify(value, (_key, nested: unknown) =>
    nested instanceof Error
      ? `${nested.name}: ${nested.message} ${nested.stack ?? ""}`
      : nested,
  );
}

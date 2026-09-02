import { quoteArg } from "./quote.js";

/**
 * Builds a hand-quoted inline-form command: string arguments are quoted
 * through `quoteArg` so they cannot break the argument boundary, numeric
 * arguments (list positions, ranges) are written bare.
 *
 * `list` is a trailing variadic argument list (`RPUSH key v1 v2`,
 * `DEL k1 k2`). It is always preceded by a separator, even when empty, so
 * the bytes match the template literals this replaced.
 */
export function inlineCommand(
  name: string,
  args: (string | number)[],
  list?: string[],
): string {
  const head = [name, ...args.map(formatArg)].join(" ");
  return list === undefined ? head : `${head} ${list.map(quoteArg).join(" ")}`;
}

function formatArg(arg: string | number): string {
  return typeof arg === "number" ? String(arg) : quoteArg(arg);
}

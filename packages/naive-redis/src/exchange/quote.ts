// Quote an inline-protocol argument with escaping so embedded quotes,
// backslashes, or whitespace cannot break out of the argument boundary.
export function quoteArg(value: string): string {
  return JSON.stringify(value);
}

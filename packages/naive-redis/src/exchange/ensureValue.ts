function ensureGet(result: string[], index: number): string {
  const value = result[index];
  if (!value) {
    throw new Error("Error: empty response");
  }
  if (value.startsWith("-")) {
    throw new Error(`Error: ${result[0] ?? ""}`);
  }
  return value;
}

export function ensureValue(
  result: string[],
  index: number,
  expected: RegExp,
): string {
  const value = ensureGet(result, index);
  const match = expected.exec(value);
  if (!match || match[1] === undefined) {
    throw new Error(`Not expected: ${value}`);
  }
  return match[1];
}

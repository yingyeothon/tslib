export type DebugPrint = (...args: unknown[]) => void;

/** Builds an internal diagnostics printer gated by an explicit flag. */
export function createDebugPrint(enabled: boolean | undefined): DebugPrint {
  if (!enabled) {
    return () => undefined;
  }
  return (...args: unknown[]) => {
    console.debug(...args);
  };
}

export function yyyyMMdd(now = new Date()): string {
  return (
    now.getFullYear() + zeroPad(now.getMonth() + 1) + zeroPad(now.getDate())
  );
}

function zeroPad(value: number): string {
  return `0${value}`.slice(-2);
}

/** Concatenates serialized bodies that share the same S3 key. */
export function aggregate(
  buffer: Array<{ key: string; body: string }>,
): Record<string, string> {
  const bag: Record<string, string> = {};
  for (const { key, body } of buffer) {
    bag[key] = (bag[key] ?? "") + body;
  }
  return bag;
}

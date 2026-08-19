import { serializeError } from "serialize-error";

export function serializeErrorInContext(context: unknown): void {
  if (!(context instanceof Object)) {
    return;
  }
  const record = context as Record<string, unknown>;
  for (const [key, value] of Object.entries(record)) {
    if (value instanceof Error) {
      record[key] = serializeError(value);
    }
  }
}

import { failure, invalid, record } from "./http.js";

type Check = (value: unknown) => boolean;
export const string: Check = (v) => typeof v === "string";
export const bool: Check = (v) => typeof v === "boolean";
export const integer: Check = (v) =>
  Number.isSafeInteger(v) && (v as number) >= 0;
export const nullable =
  (check: Check): Check =>
  (v) =>
    v === null || check(v);
export const strings: Check = (v) =>
  record(v) && Object.values(v).every(string);
export const shape =
  (fields: Record<string, Check>): Check =>
  (v) =>
    record(v) &&
    Object.entries(fields).every(
      ([key, check]) => Object.hasOwn(v, key) && check(v[key]),
    );
export function checked<T>(value: unknown, check: Check, status = 200): T {
  if (!check(value)) throw failure(status, "malformed_response");
  return value as T;
}
const delivery: Check = (v) =>
  record(v) &&
  (v.priority === undefined ||
    v.priority === "high" ||
    v.priority === "normal") &&
  (v.ttlSec === undefined ||
    (integer(v.ttlSec) && (v.ttlSec as number) <= 2419200)) &&
  (v.collapseKey === undefined ||
    (typeof v.collapseKey === "string" &&
      /^[\x21-\x7e]{1,64}$/.test(v.collapseKey)));
export const jobCheck = shape({
  id: string,
  channelId: string,
  kind: (v) => v === "campaign" || v === "broadcast",
  dryRun: bool,
  status: (v) => ["queued", "running", "done", "failed"].includes(v as string),
  error: nullable(string),
  errorDetails: nullable(record),
  cancelRequested: bool,
  idempotencyKey: string,
  templateId: nullable(string),
  uploadId: nullable(string),
  message: shape({ title: string, body: string, data: strings }),
  options: delivery,
  author: string,
  total: nullable(integer),
  processed: integer,
  counts: shape(
    Object.fromEntries(
      [
        "resolved",
        "sent",
        "noToken",
        "unregistered",
        "failed",
        "skipped",
        "duplicates",
        "missingVariables",
        "invalid",
      ].map((k) => [k, integer]),
    ),
  ),
  report: nullable(shape({ available: bool, expiresAt: integer })),
  createdAt: integer,
  startedAt: nullable(integer),
  finishedAt: nullable(integer),
});
export const uploadEntryCheck = shape({
  id: string,
  size: integer,
  createdBy: string,
  createdByLogin: nullable(string),
  createdAt: integer,
  usableUntil: integer,
  pending: bool,
  inUse: bool,
});
export const jobs: Check = (v) => Array.isArray(v) && v.every(jobCheck);
export const uploads: Check = (v) =>
  Array.isArray(v) && v.every(uploadEntryCheck);
export const httpUrl: Check = (value) => {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return /^https?:$/.test(url.protocol) && !url.username && !url.password;
  } catch {
    return false;
  }
};
export function deliveryOptions(value: unknown): void {
  if (!delivery(value)) throw invalid("Invalid push delivery options");
}
export function idempotencyKey(value: string): void {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(value)
  )
    throw invalid("Invalid push idempotencyKey");
}
export function query(options: {
  limit?: number;
  cursor?: string;
  idempotencyKey?: string;
}): string {
  const result = new URLSearchParams();
  if (options.idempotencyKey !== undefined) {
    idempotencyKey(options.idempotencyKey);
    if (options.limit !== undefined || options.cursor !== undefined)
      throw invalid("Job lookup cannot include pagination");
    result.set("idempotencyKey", options.idempotencyKey);
  }
  if (options.limit !== undefined) {
    if (
      !Number.isInteger(options.limit) ||
      options.limit < 1 ||
      options.limit > 100
    )
      throw invalid("Invalid push list limit");
    result.set("limit", String(options.limit));
  }
  if (options.cursor !== undefined) {
    if (typeof options.cursor !== "string" || !options.cursor)
      throw invalid("Invalid push cursor");
    result.set("cursor", options.cursor);
  }
  const encoded = result.toString();
  return encoded ? `?${encoded}` : "";
}
export function message(value: {
  data?: Record<string, string>;
  notification?: { title: string; body: string };
}): void {
  if (value.data === undefined && value.notification === undefined)
    throw invalid("A push message is required");
  if (
    value.data !== undefined &&
    (!strings(value.data) ||
      Object.keys(value.data).length > 64 ||
      Object.keys(value.data).some(
        (k) =>
          !k ||
          ["from", "notification", "message_type"].includes(k) ||
          k.startsWith("google.") ||
          k.startsWith("gcm."),
      ))
  )
    throw invalid("Invalid push data");
  if (
    value.notification !== undefined &&
    (!shape({ title: string, body: string })(value.notification) ||
      !value.notification.title)
  )
    throw invalid("Invalid push notification");
}

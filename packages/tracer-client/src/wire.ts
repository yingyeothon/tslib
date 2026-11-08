import packageJson from "../package.json" with { type: "json" };
import type { TracerLevel } from "./types.js";

/**
 * The version this library reports in the envelope header (`sdk.version`)
 * and in `X-Sentry-Auth` (`sentry_client=yyt-ts/<version>`): the package
 * version, stamped by the Release workflow.
 */
export const tracerSdkVersion: string = packageJson.version;

/**
 * Limits the client keeps under, from the service's tracer ingest
 * (`docs/tracer.md`, _Wire contract for client libraries_ and _Ingest_).
 * Every size is UTF-8 bytes.
 */
export const tracerLimits = Object.freeze({
  /** A body over 20 MiB is refused, compressed or not. */
  maxEnvelopeBytes: 20 * 1024 * 1024,
  /** Each JSON item (event, feedback, log container) is dropped over 1 MiB. */
  maxJsonItemBytes: 1024 * 1024,
  /** JSON items one envelope may hold until the ingest commits it. */
  maxJsonBytesPerEnvelope: 2 * 1024 * 1024,
  /** Entries in one log container. */
  maxLogsPerContainer: 1000,
  /** Attachments per envelope. */
  maxAttachmentsPerEnvelope: 20,
  /** Breadcrumbs kept per event; the default ring size. */
  maxBreadcrumbs: 500,
  /** Text kept of a message, log body or breadcrumb message. */
  maxTextBytes: 8 * 1024,
  /** A log line's attributes, a breadcrumb's data or a report's extra as JSON. */
  maxDataBytes: 16 * 1024,
  /** Tags kept per event. */
  maxTags: 64,
});

export const sdkName = "yyt.ts";

/** `sdk` of every envelope header and event. */
export const sdkInfo = Object.freeze({
  name: sdkName,
  version: tracerSdkVersion,
});

/** Content type of a log container item. */
export const logContentType = "application/vnd.sentry.items.log+json";

/** Room left for an item header line and newlines when sizing an envelope. */
export const itemOverhead = 512;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function utf8(text: string): Uint8Array {
  return encoder.encode(text);
}

/** `bytes` random bytes as lowercase hex. */
export function hexId(random: (length: number) => Uint8Array, bytes: number) {
  let out = "";
  for (const b of random(bytes)) out += b.toString(16).padStart(2, "0");
  return out;
}

/** RFC 3339 in UTC with milliseconds, as event and breadcrumb timestamps are. */
export function rfc3339(millis: number): string {
  return new Date(millis).toISOString();
}

/** Float seconds, as log entry timestamps are written. */
export function epochSeconds(millis: number): number {
  return millis / 1000;
}

/** The log `level` of a level (`warning` is `warn` there). */
export function logLevel(level: TracerLevel): string {
  return level === "warning" ? "warn" : level;
}

/** The log `severity_number` of a level (OpenTelemetry's ranges). */
export function severityNumber(level: TracerLevel): number {
  switch (level) {
    case "debug":
      return 5;
    case "info":
      return 9;
    case "warning":
      return 13;
    case "error":
      return 17;
    case "fatal":
      return 21;
  }
}

const levels = new Set<string>(["debug", "info", "warning", "error", "fatal"]);

/** A caller's level, or `fallback` when it is not one of ours. */
export function checkLevel(level: unknown, fallback: TracerLevel): TracerLevel {
  if (level === "warn") return "warning";
  return typeof level === "string" && levels.has(level)
    ? (level as TracerLevel)
    : fallback;
}

/** `text` cut to at most `maxBytes` UTF-8 bytes on a character boundary. */
export function clipUtf8(text: string, maxBytes: number): string {
  if (text.length * 3 <= maxBytes) return text;
  const bytes = encoder.encode(text);
  if (bytes.length <= maxBytes) return text;
  let cut = maxBytes;
  while (cut > 0 && ((bytes[cut] ?? 0) & 0xc0) === 0x80) cut--;
  return decoder.decode(bytes.subarray(0, cut));
}

/** A caller's string, or its `String()` form, never throwing. */
export function text(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return String(value);
  } catch {
    return "<unprintable>";
  }
}

interface Budget {
  left: number;
}

/**
 * A JSON-safe copy of `value`: objects get clipped string keys, iterables
 * become arrays, non-finite numbers, bigints and unknown values become
 * strings, strings are clipped, nesting stops at depth 8, collections at 200
 * entries and the whole copy at 2000 values (a cyclic or wide graph stays
 * cheap). `undefined` members are left out, as `JSON.stringify` does. Never
 * throws.
 */
export function jsonSafe(value: unknown): unknown {
  return safe(value, 0, { left: 2000 });
}

function safe(value: unknown, depth: number, budget: Budget): unknown {
  if (--budget.left < 0) return "…";
  try {
    switch (typeof value) {
      case "undefined":
        return null;
      case "boolean":
        return value;
      case "number":
        return Number.isFinite(value) ? value : String(value);
      case "string":
        return clipUtf8(value, tracerLimits.maxTextBytes);
      case "bigint":
        return value.toString();
      case "symbol":
      case "function":
        return clipUtf8(text(value), 200);
    }
    if (value === null) return null;
    if (value instanceof Date) {
      return Number.isFinite(value.getTime()) ? value.toISOString() : null;
    }
    if (value instanceof Error) {
      return clipUtf8(
        `${text(value.name)}: ${text(value.message)}`,
        tracerLimits.maxTextBytes,
      );
    }
    if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
      return `<${value.constructor.name} ${value.byteLength} bytes>`;
    }
    if (depth >= 8) return "…";
    if (value instanceof Map) {
      const out: Record<string, unknown> = {};
      let n = 0;
      for (const [k, v] of value as Map<unknown, unknown>) {
        if (n++ >= 200 || budget.left <= 0) break;
        if (v === undefined) continue;
        out[clipUtf8(text(k), 200)] = safe(v, depth + 1, budget);
      }
      return out;
    }
    if (
      Array.isArray(value) ||
      value instanceof Set ||
      (typeof (value as { [Symbol.iterator]?: unknown })[Symbol.iterator] ===
        "function" &&
        typeof (value as { toJSON?: unknown }).toJSON !== "function")
    ) {
      const out: unknown[] = [];
      for (const v of value as Iterable<unknown>) {
        if (out.length >= 200 || budget.left <= 0) break;
        out.push(safe(v, depth + 1, budget));
      }
      return out;
    }
    const toJSON = (value as { toJSON?: unknown }).toJSON;
    if (typeof toJSON === "function") {
      return safe(toJSON.call(value), depth + 1, budget);
    }
    const out: Record<string, unknown> = {};
    let n = 0;
    for (const key of Object.keys(value as object)) {
      if (n++ >= 200 || budget.left <= 0) break;
      const v = (value as Record<string, unknown>)[key];
      if (v === undefined) continue;
      out[clipUtf8(key, 200)] = safe(v, depth + 1, budget);
    }
    return out;
  } catch {
    return "<unprintable>";
  }
}

export interface TypedAttribute {
  value: string | number | boolean;
  type: "string" | "integer" | "double" | "boolean";
}

/** A typed log attribute `{value, type}`; `undefined` for a null value. */
export function typedAttribute(value: unknown): TypedAttribute | undefined {
  const s = jsonSafe(value);
  switch (typeof s) {
    case "boolean":
      return { value: s, type: "boolean" };
    case "number":
      return Number.isSafeInteger(s)
        ? { value: s, type: "integer" }
        : { value: s, type: "double" };
    case "string":
      return { value: s, type: "string" };
  }
  if (s === null) return undefined;
  return {
    value: clipUtf8(JSON.stringify(s), tracerLimits.maxTextBytes),
    type: "string",
  };
}

/** UTF-8 JSON of an already JSON-safe value. */
export function jsonBytes(value: unknown): Uint8Array {
  return encoder.encode(JSON.stringify(value));
}

/** One envelope item: its header fields (without `length`) and payload. */
export interface WireItem {
  header: Record<string, unknown>;
  payload: Uint8Array;
}

/**
 * Encodes an envelope: the header line, then per item a header line with an
 * explicit `length` and the payload, each followed by a newline.
 */
export function encodeEnvelope(
  header: Record<string, unknown>,
  items: WireItem[],
): Uint8Array {
  const parts: Uint8Array[] = [jsonBytes(header), newline];
  for (const item of items) {
    parts.push(
      jsonBytes({ ...item.header, length: item.payload.length }),
      newline,
      item.payload,
      newline,
    );
  }
  return concat(parts);
}

const newline = new Uint8Array([0x0a]);

export function concat(parts: Uint8Array[]): Uint8Array {
  let size = 0;
  for (const p of parts) size += p.length;
  const out = new Uint8Array(size);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

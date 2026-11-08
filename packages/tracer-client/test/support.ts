import { gunzipSync } from "node:zlib";
import type { LogWriter, Logger } from "@yingyeothon/logger";
import type {
  TracerFetchLike,
  TracerFetchRequest,
  TracerFetchResponse,
} from "../src/index.js";

/** The fixture DSN of the service repository's golden envelopes. */
export const fixtureKey = "fixturewritekeyfixturewritekey00";
export const fixtureDsn = `https://${fixtureKey}@trace.invalid/trc_fixture01`;

export interface ParsedItem {
  header: Record<string, unknown>;
  payload: Uint8Array;
  /** The payload as JSON, for JSON items. */
  json: Record<string, unknown>;
}

export interface ParsedEnvelope {
  header: Record<string, unknown>;
  items: ParsedItem[];
}

/**
 * Parses an envelope the way tracer's `envelope.Reader` does: a header line,
 * then per item a header line and `length` bytes (or up to the next newline).
 */
export function parseEnvelope(body: Uint8Array): ParsedEnvelope {
  const decoder = new TextDecoder();
  let at = 0;
  const line = () => {
    let end = body.indexOf(0x0a, at);
    if (end < 0) end = body.length;
    const out = body.subarray(at, end);
    at = end + 1;
    return out;
  };
  const header = JSON.parse(decoder.decode(line())) as Record<string, unknown>;
  const items: ParsedItem[] = [];
  while (at < body.length) {
    const raw = line();
    if (raw.length === 0) continue;
    const itemHeader = JSON.parse(decoder.decode(raw)) as Record<
      string,
      unknown
    >;
    let payload: Uint8Array;
    if (typeof itemHeader["length"] === "number") {
      payload = body.subarray(at, at + itemHeader["length"]);
      at += itemHeader["length"];
      if (body[at] === 0x0a) at++;
    } else {
      payload = line();
    }
    let json: Record<string, unknown> = {};
    try {
      json = JSON.parse(decoder.decode(payload)) as Record<string, unknown>;
    } catch {
      // binary
    }
    items.push({ header: itemHeader, payload, json });
  }
  return { header, items };
}

export interface Sent {
  url: string;
  init: TracerFetchRequest;
  /** The body as the client meant it, decompressed when gzipped. */
  body: Uint8Array;
  envelope: ParsedEnvelope;
}

export type Answer =
  | { status: number; headers?: Record<string, string>; type?: string }
  | { reject: Error }
  | { hang: true };

/**
 * A scripted `fetch`: each call takes the next answer (default `200`) and
 * records what was sent, decompressed and parsed.
 */
export function createFakeFetch(
  answers: Answer[] = [],
  fallback: Answer = { status: 200 },
) {
  const sent: Sent[] = [];
  const queue = [...answers];
  const fetch: TracerFetchLike = (url, init) => {
    const body =
      init.headers["Content-Encoding"] === "gzip"
        ? new Uint8Array(gunzipSync(init.body))
        : init.body;
    sent.push({ url, init, body, envelope: parseEnvelope(body) });
    const next = queue.shift() ?? fallback;
    if ("reject" in next) return Promise.reject(next.reject);
    if ("hang" in next) {
      return new Promise<TracerFetchResponse>((_, reject) => {
        const signal = init.signal as
          { addEventListener(t: string, l: () => void): void } | undefined;
        signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    }
    const headers = new Map(
      Object.entries(next.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
    );
    const response: TracerFetchResponse = {
      status: next.status,
      ...(next.type !== undefined ? { type: next.type } : {}),
      headers: { get: (name) => headers.get(name.toLowerCase()) ?? null },
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
    };
    return Promise.resolve(response);
  };
  return { fetch, sent, queue };
}

/** A clock that advances one millisecond per read, from a fixed start. */
export function steppingClock(start = Date.UTC(2026, 10, 8, 6, 42, 16, 0)) {
  let t = start;
  return () => t++;
}

/** Deterministic "random" bytes: start, start + 1, … */
export function sequenceRandom(start = 0) {
  let n = start;
  return (length: number) => {
    const out = new Uint8Array(length);
    for (let i = 0; i < length; i++) out[i] = n++ & 0xff;
    return out;
  };
}

/** A logger that keeps every line, errors flattened to name + message + stack. */
export function createCapturingLogger(): Logger & { lines: string[] } {
  const lines: string[] = [];
  const flat = (v: unknown) =>
    v instanceof Error
      ? `${v.name} ${v.message} ${v.stack ?? ""}`
      : typeof v === "string"
        ? v
        : JSON.stringify(v);
  const write =
    (level: string) =>
    (...args: unknown[]) => {
      lines.push(`${level} ${args.map(flat).join(" ")}`);
    };
  const writer: LogWriter = {
    debug: write("debug"),
    info: write("info"),
    warn: write("warn"),
    error: write("error"),
  };
  return { severity: "debug", ...writer, lines };
}

/** Lets the microtask queue (and a send loop on resolved fakes) drain. */
export async function settle(rounds = 10): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

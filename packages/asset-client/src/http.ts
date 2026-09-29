import type { Logger } from "@yingyeothon/logger";
import { createAssetClientError } from "./errors.js";
import type {
  AssetCacheMode,
  AssetFetchLike,
  AssetFetchResponse,
  AssetStreamReader,
} from "./types.js";

/** What a request was for; the only thing besides the status that is logged. */
export type RequestKind = "whole" | "head" | "header" | "segments" | "range";

export interface Answer {
  status: number;
  /** A strong or weak ETag as sent, when the host exposed one. */
  etag: string | undefined;
  /** `Content-Range`, when the host sent one and the caller may read it. */
  range: ContentRange | undefined;
  /** The length a 416 states (`bytes *\/L`), when the caller may read it. */
  unsatisfiedTotal: number | undefined;
  /** `Content-Length`, when present and numeric. */
  length: number | undefined;
  /** Whether the host said the body is content-encoded. */
  encoded: boolean;
  body: BodyReader;
}

export interface ContentRange {
  start: number;
  end: number;
  /** `undefined` for `bytes a-b/*`. */
  total: number | undefined;
}

/**
 * `bytes a-b/total` or `bytes a-b/*`. Anything else (including the `*\/total`
 * of a 416) is `undefined`.
 */
export function parseContentRange(
  raw: string | null,
): ContentRange | undefined {
  if (raw === null) return undefined;
  const match = /^bytes (\d{1,16})-(\d{1,16})\/(\d{1,16}|\*)$/.exec(raw.trim());
  if (match === null) return undefined;
  const start = Number(match[1]);
  const end = Number(match[2]);
  const total = match[3] === "*" ? undefined : Number(match[3]);
  if (end < start || (total !== undefined && end >= total)) return undefined;
  return { start, end, total };
}

function parseUnsatisfied(raw: string | null): number | undefined {
  const match = raw === null ? null : /^bytes \*\/(\d{1,16})$/.exec(raw.trim());
  return match === null ? undefined : Number(match[1]);
}

function parseLength(raw: string | null): number | undefined {
  if (raw === null || !/^\d{1,16}$/.test(raw.trim())) return undefined;
  return Number(raw.trim());
}

/** A strong ETag may go into `If-Range`; a weak one never matches there. */
export function isStrongEtag(etag: string | undefined): etag is string {
  return etag !== undefined && etag !== "" && !etag.startsWith("W/");
}

/**
 * Reads a body in exact-sized pieces without holding more of it than one
 * piece: a download of 256 MiB keeps one 64 KiB segment in memory.
 */
export interface BodyReader {
  /** Exactly `n` bytes; a body that ends first is `network`. */
  readExactly(n: number): Promise<Uint8Array>;
  /** The next piece as the transport delivered it; `undefined` at the end. */
  next(): Promise<Uint8Array | undefined>;
  /** Everything that is left. */
  rest(): Promise<Uint8Array>;
  /** Stops the transfer; safe to call more than once. */
  cancel(): Promise<void>;
}

function concat(chunks: Uint8Array[], size: number): Uint8Array {
  if (chunks.length === 1 && chunks[0]!.length === size) return chunks[0]!;
  const out = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

export function createBodyReader(
  response: AssetFetchResponse,
  status: number,
): BodyReader {
  let reader: AssetStreamReader | undefined;
  let whole: Promise<ArrayBuffer> | undefined;
  let pending: Uint8Array | undefined;
  let finished = false;

  const failed = (cause: unknown) =>
    createAssetClientError({
      code: "network",
      status,
      detail: "the body failed mid-transfer",
      cause,
    });

  async function pull(): Promise<Uint8Array | undefined> {
    if (pending !== undefined) {
      const out = pending;
      pending = undefined;
      return out;
    }
    if (finished) return undefined;
    try {
      if (response.body !== null) {
        reader ??= response.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value !== undefined && value.length > 0) return value;
        }
      } else if (whole === undefined) {
        whole = response.arrayBuffer();
        const bytes = new Uint8Array(await whole);
        finished = true;
        return bytes.length > 0 ? bytes : undefined;
      }
    } catch (cause) {
      finished = true;
      throw failed(cause);
    }
    finished = true;
    return undefined;
  }

  return {
    async readExactly(n) {
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (size < n) {
        const chunk = await pull();
        if (chunk === undefined) {
          throw createAssetClientError({
            code: "network",
            status,
            detail: "the body ended early",
          });
        }
        const take = Math.min(chunk.length, n - size);
        chunks.push(chunk.subarray(0, take));
        if (take < chunk.length) pending = chunk.subarray(take);
        size += take;
      }
      return concat(chunks, size);
    },
    next: pull,
    async rest() {
      const chunks: Uint8Array[] = [];
      let size = 0;
      for (;;) {
        const chunk = await pull();
        if (chunk === undefined) return concat(chunks, size);
        chunks.push(chunk);
        size += chunk.length;
      }
    },
    async cancel() {
      if (finished) return;
      finished = true;
      pending = undefined;
      try {
        if (reader !== undefined) await reader.cancel();
        else if (response.body !== null)
          await response.body.getReader().cancel();
      } catch {
        // The transfer is being abandoned either way.
      }
    },
  };
}

export interface RequestSpec {
  method: "GET" | "HEAD";
  kind: RequestKind;
  /** Inclusive byte range; `to` omitted = open-ended. */
  range?: { from: number; to?: number };
  ifRange?: string;
  cache?: AssetCacheMode;
}

/**
 * The single request choke point: one header assembly, one log line per
 * request. Logged are the request kind, the path, the status and the range
 * — never the key, a byte of the body, or a header value.
 */
export function createRequester(fetchImpl: AssetFetchLike, logger: Logger) {
  return async function request(
    url: string,
    path: string,
    spec: RequestSpec,
  ): Promise<Answer> {
    const headers: Record<string, string> = {};
    if (spec.range !== undefined) {
      headers.range = `bytes=${spec.range.from}-${spec.range.to ?? ""}`;
    }
    if (spec.ifRange !== undefined) headers["if-range"] = spec.ifRange;
    let response: AssetFetchResponse;
    try {
      response = await fetchImpl(url, {
        method: spec.method,
        headers,
        ...(spec.cache === undefined ? {} : { cache: spec.cache }),
      });
    } catch (cause) {
      logger.warn("asset request failed", { kind: spec.kind, path });
      throw createAssetClientError({ code: "network", cause });
    }
    const { status } = response;
    logger.debug("asset request", {
      kind: spec.kind,
      path,
      status,
      ...(spec.range === undefined ? {} : { range: headers.range }),
    });
    const body = createBodyReader(response, status);
    if (status === 403 || status === 404) {
      await body.cancel();
      throw createAssetClientError({ code: "not_found", status });
    }
    if (status !== 200 && status !== 206 && status !== 416) {
      await body.cancel();
      throw createAssetClientError({ code: "http", status });
    }
    const encoding = response.headers.get("content-encoding");
    return {
      status,
      etag: response.headers.get("etag") ?? undefined,
      range: parseContentRange(response.headers.get("content-range")),
      unsatisfiedTotal: parseUnsatisfied(response.headers.get("content-range")),
      length: parseLength(response.headers.get("content-length")),
      encoded:
        encoding !== null && encoding.trim().toLowerCase() !== "identity",
      body,
    };
  };
}

export type Requester = ReturnType<typeof createRequester>;

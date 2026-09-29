import type { Logger } from "@yingyeothon/logger";

/**
 * Structural view of the WHATWG `fetch` the client needs. Declared here rather
 * than taken from the DOM lib or `undici-types` so the public `.d.ts` stays
 * dependency-free and the same code runs in browsers and Node >= 20.
 */
export interface AssetFetchRequest {
  method: "GET" | "HEAD";
  headers: Record<string, string>;
  /** Passed through only when the caller asked for one. */
  cache?: AssetCacheMode;
}

export interface AssetStreamReader {
  read(): Promise<{ done: boolean; value?: Uint8Array }>;
  cancel(reason?: unknown): Promise<void>;
}

export interface AssetFetchResponse {
  status: number;
  headers: { get(name: string): string | null };
  arrayBuffer(): Promise<ArrayBuffer>;
  /** A streaming body; `null` makes the client fall back to `arrayBuffer()`. */
  body: { getReader(): AssetStreamReader } | null;
}

export type AssetFetchLike = (
  url: string,
  init: AssetFetchRequest,
) => Promise<AssetFetchResponse>;

/** The WHATWG `RequestInit.cache` values a read may ask for. */
export type AssetCacheMode =
  "default" | "no-store" | "reload" | "no-cache" | "force-cache";

export interface AssetBundleClientOptions {
  /**
   * `https://{cdn}/assets/{bundleId}/` for a live bundle, plus `{version}/`
   * for one version of a versioned bundle. The CDN is `d.yyt.life` on prod
   * and `dev-d.yyt.life` on dev; there is no default.
   */
  baseUrl: string;
  /**
   * The bundle key of an encrypted bundle: `yak1.` + 43 base64url characters,
   * or its 32 raw bytes. Copied and imported into WebCrypto at create time,
   * never logged; omit it for a plain bundle.
   */
  key?: string | Uint8Array;
  /**
   * Send only CORS-safelisted request headers (`Range`, never `If-Range`)
   * and read only the response headers the yyt CDN exposes to scripts
   * (`ETag`, `Content-Length`). A ranged read then costs a `HEAD` first.
   * Defaults to `true` in a browser window or worker and `false` elsewhere.
   */
  corsSafe?: boolean;
  /** Defaults to the global `fetch`. */
  fetch?: AssetFetchLike;
  logger?: Logger;
}

export interface AssetReadOptions {
  /**
   * The fetch cache mode for this read. A mutable file (a manifest) is served
   * `no-cache`, so the default already revalidates; `no-store` also keeps it
   * out of the browser cache.
   */
  cache?: AssetCacheMode;
}

export interface AssetRangeOptions extends AssetReadOptions {
  /** First plaintext byte, inclusive. */
  start: number;
  /** Plaintext offset after the last byte; omitted = to the end of the file. */
  end?: number;
}

/** Where `download` puts the plaintext, one verified piece at a time. */
export interface AssetSink {
  /** The next plaintext bytes, in order. Awaited before the next piece. */
  write(chunk: Uint8Array): void | Promise<void>;
  /**
   * The object changed since the bytes already written (or since `resume`):
   * drop everything, the download starts again from byte 0.
   */
  reset(): void | Promise<void>;
}

export interface AssetDownloadProgress {
  /** Plaintext bytes the sink holds, a resumed `offset` included. */
  written: number;
  /**
   * The file's plaintext length; absent only for a plain file whose response
   * did not state it (a compressed or unsized body).
   */
  total?: number;
  /** The object's ETag; keep it with `written` to resume later. */
  etag?: string;
}

export interface AssetResume {
  /** Plaintext bytes the sink already holds from an earlier download. */
  offset: number;
  /** The ETag that earlier download reported; another one starts over. */
  etag: string;
}

export interface AssetDownloadOptions extends AssetReadOptions {
  sink: AssetSink;
  resume?: AssetResume;
  onProgress?: (progress: AssetDownloadProgress) => void;
}

export interface AssetDownloadResult {
  /** The file's plaintext length, now all in the sink. */
  bytes: number;
  etag?: string;
}

export interface AssetBundleClient {
  /** The whole file, verified before any byte is returned. */
  read(path: string, options?: AssetReadOptions): Promise<Uint8Array>;
  /** The whole file as UTF-8 JSON; anything else is `asset_corrupt`. */
  readJson<T = unknown>(path: string, options?: AssetReadOptions): Promise<T>;
  /**
   * Plaintext bytes `[start, end)`, clamped to the file like
   * `Uint8Array.slice`. An encrypted file fetches only the segments the
   * range covers.
   */
  readRange(path: string, options: AssetRangeOptions): Promise<Uint8Array>;
  /**
   * Streams the file into `sink`, each encrypted segment verified before a
   * byte of it is written, and resumes from `resume` when the object is
   * unchanged.
   */
  download(
    path: string,
    options: AssetDownloadOptions,
  ): Promise<AssetDownloadResult>;
  /** Drops the key. Reads after `close()` reject. */
  close(): void;
}

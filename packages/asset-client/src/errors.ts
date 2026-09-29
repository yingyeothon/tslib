/**
 * What went wrong, in the vocabulary the three client libraries share:
 *
 * - `bad_key`: the key is not `yak1.` + 43 base64url characters of 32 bytes
 *   (or 32 raw bytes). Thrown by `createAssetBundleClient`.
 * - `not_found`: the CDN answered 403 or 404. A missing object answers 403
 *   on the yyt CDN, so the two are one case.
 * - `asset_corrupt`: the ciphertext fails a length rule or a segment tag, or
 *   `readJson` was given bytes that are not UTF-8 JSON. Never retried: a wrong
 *   key and a wrong path fail the same way.
 * - `http`: any other status, a host that ignores `Range`, or an object that
 *   kept changing while it was being read.
 * - `network`: `fetch` rejected, or a body ended before its declared length.
 */
export type AssetClientErrorCode =
  "bad_key" | "not_found" | "asset_corrupt" | "http" | "network";

/**
 * The one error the client throws for a bad key, a refused or failed
 * request, or bytes that do not verify. Local misuse (an invalid path or
 * range, a malformed `baseUrl`) is a plain `RangeError` thrown before any
 * request is made, and whatever a caller's `sink` throws passes through
 * unchanged.
 */
export interface AssetClientError extends Error {
  readonly name: "AssetClientError";
  /** HTTP status; `0` when there was no answer to report. */
  readonly status: number;
  readonly code: AssetClientErrorCode;
}

/**
 * The message carries the code, the status and at most a fixed phrase: never
 * a key, a URL, a path or a byte of plaintext.
 */
export function createAssetClientError(fields: {
  code: AssetClientErrorCode;
  status?: number;
  detail?: string;
  cause?: unknown;
}): AssetClientError {
  const status = fields.status ?? 0;
  const error = new Error(
    `asset ${fields.code} (${status})${fields.detail === undefined ? "" : `: ${fields.detail}`}`,
    fields.cause === undefined ? undefined : { cause: fields.cause },
  ) as Error & { name: string; status: number; code: AssetClientErrorCode };
  error.name = "AssetClientError";
  error.status = status;
  error.code = fields.code;
  return error as AssetClientError;
}

export const corrupt = (status?: number): AssetClientError =>
  createAssetClientError({ code: "asset_corrupt", status });

/**
 * Duck-typed rather than `instanceof`: an error raised in another realm (an
 * iframe, a worker, a jsdom host) has a different `Error`, and this client
 * runs in browsers.
 */
export function isAssetClientError(error: unknown): error is AssetClientError {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as {
    name?: unknown;
    status?: unknown;
    code?: unknown;
  };
  return (
    candidate.name === "AssetClientError" &&
    typeof candidate.status === "number" &&
    typeof candidate.code === "string"
  );
}

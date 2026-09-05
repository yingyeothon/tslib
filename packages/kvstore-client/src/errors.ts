/**
 * The one error the client throws for anything the server, or the network,
 * refused. Local refusals (grammar, size, ranges) are plain `RangeError`s and
 * `TypeError`s thrown before any request is made.
 */
export interface KvStoreError extends Error {
  readonly name: "KvStoreError";
  /** HTTP status; `0` when the request never got an answer. */
  readonly status: number;
  /** The server's `error.code`, or `network` / `malformed_response`. */
  readonly code: string;
  /** `error.details.reason` when the server named one. */
  readonly reason?: string;
  /**
   * On a lost compare-and-set, the live version (`null` = the key is absent),
   * only when the caller may read the collection.
   */
  readonly currentVersion?: number | null;
}

interface ErrorBody {
  error?: {
    code?: unknown;
    message?: unknown;
    details?: { reason?: unknown; current?: unknown };
  };
}

/**
 * Builds the error from a response. The message carries the status and the
 * code only: never a key, a value, a URL or a token.
 */
export function kvStoreErrorFromResponse(
  status: number,
  bodyText: string,
): KvStoreError {
  let body: ErrorBody | undefined;
  try {
    body = JSON.parse(bodyText) as ErrorBody;
  } catch {
    body = undefined;
  }
  const error = body?.error;
  const code = typeof error?.code === "string" ? error.code : `http_${status}`;
  const details = error?.details;
  const reason =
    typeof details?.reason === "string" ? details.reason : undefined;
  const current = details?.current;
  const currentVersion =
    current === null || typeof current === "number" ? current : undefined;
  return createKvStoreError({ status, code, reason, currentVersion });
}

export function createKvStoreError(fields: {
  status: number;
  code: string;
  reason?: string;
  currentVersion?: number | null;
  cause?: unknown;
}): KvStoreError {
  const error = new Error(
    `kv ${fields.code} (${fields.status})`,
    fields.cause === undefined ? undefined : { cause: fields.cause },
  ) as Error & {
    name: string;
    status: number;
    code: string;
    reason?: string;
    currentVersion?: number | null;
  };
  error.name = "KvStoreError";
  error.status = fields.status;
  error.code = fields.code;
  if (fields.reason !== undefined) error.reason = fields.reason;
  if (fields.currentVersion !== undefined) {
    error.currentVersion = fields.currentVersion;
  }
  return error as KvStoreError;
}

/**
 * Duck-typed rather than `instanceof`: an error raised in another realm (an
 * iframe, a worker, a jsdom host) has a different `Error`, and this is a
 * browser SDK.
 */
export function isKvStoreError(error: unknown): error is KvStoreError {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as {
    name?: unknown;
    status?: unknown;
    code?: unknown;
  };
  return (
    candidate.name === "KvStoreError" &&
    typeof candidate.status === "number" &&
    typeof candidate.code === "string"
  );
}

/** `409`: a lost compare-and-set, a full collection or owner, `not_a_number`, `overflow`. */
export function isKvConflict(error: unknown): error is KvStoreError {
  return isKvStoreError(error) && error.status === 409;
}

/** `403`: the scope refuses this principal, or a conditional write without the read right. */
export function isKvForbidden(error: unknown): error is KvStoreError {
  return isKvStoreError(error) && error.status === 403;
}

/** `401`: the token is missing, expired or not for this stage. */
export function isKvUnauthorized(error: unknown): error is KvStoreError {
  return isKvStoreError(error) && error.status === 401;
}

/** `409` with `details.reason` `collection_full` or `owner_full`. */
export function isKvFull(error: unknown): error is KvStoreError {
  return (
    isKvConflict(error) &&
    (error.reason === "collection_full" || error.reason === "owner_full")
  );
}

/** `"3"`, `W/"3"` and `3` all read as `3`; anything else is `undefined`. */
export function parseEtagVersion(raw: string | null): number | undefined {
  if (raw === null) return undefined;
  const match = /^(?:W\/)?(?:"(\d{1,15})"|(\d{1,15}))$/.exec(raw.trim());
  if (match === null) return undefined;
  return Number(match[1] ?? match[2]);
}

/** `x-kv-expires-at` is an absolute epoch second. */
export function parseExpiresAt(raw: string | null): number | undefined {
  if (raw === null) return undefined;
  const value = Number(raw.trim());
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

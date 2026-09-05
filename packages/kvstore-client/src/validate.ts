/**
 * Local refusals mirror the server's rules and nothing more. Every constant
 * here is a copy of one in `service/packages/console-db/src/kvstore.ts`; when
 * that file changes, this one follows.
 */

/** `KV_KEY_RE`. */
export const kvKeyPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
/** The console's collection name grammar (`checkKvName`). */
export const kvCollectionNamePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** `KV_COLLECTION_ID_RE`. */
export const kvCollectionIdPattern = /^kv_[0-9a-z]{26}$/;
/** `KV_OWNER_ID`, plus the player alias `me`. */
export const kvOwnerIdPattern =
  /^(?:me|[0-9a-f]{32}|[a-z]{1,8}:[A-Za-z0-9_-]{1,48})$/;
/** `MAX_KV_VALUE_BYTES`. */
export const kvMaxValueBytes = 16 * 1024;
/** `KV_TTL_MIN_SECONDS` … `KV_TTL_MAX_SECONDS`; `0` clears the expiry. */
export const kvTtlMinSeconds = 1;
export const kvTtlMaxSeconds = 366 * 24 * 60 * 60;
/** `KV_LIST_LIMIT_MAX`. */
export const kvListLimitMin = 1;
export const kvListLimitMax = 100;

const encoder = new TextEncoder();

/** UTF-8 byte length, which is what the server measures. */
export function kvValueBytes(text: string): number {
  return encoder.encode(text).byteLength;
}

/**
 * A `kv_` id goes on the path as is; anything else is a name. The edge is not
 * transparent to encoded segments, so a segment outside both grammars is
 * refused here instead of being encoded.
 */
export function checkCollectionRef(ref: string): string {
  if (typeof ref !== "string") {
    throw new RangeError("kv collection must be a string");
  }
  if (kvCollectionIdPattern.test(ref)) return ref;
  // The console refuses a name the unique index would fold onto an id
  // (`KV_01J…`), and the server answers such a segment without a lookup.
  if (
    kvCollectionNamePattern.test(ref) &&
    !kvCollectionIdPattern.test(ref.toLowerCase())
  ) {
    return ref;
  }
  throw new RangeError(
    "kv collection must be a kv_ id or a name matching ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$",
  );
}

export function checkKey(key: string): string {
  if (typeof key === "string" && kvKeyPattern.test(key)) return key;
  throw new RangeError("kv key must match ^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$");
}

export function checkOwnerId(ownerId: string): string {
  if (typeof ownerId === "string" && kvOwnerIdPattern.test(ownerId)) {
    return ownerId;
  }
  throw new RangeError(
    "kv owner must be `me`, 32 hex characters, or `{kind}:{id}`",
  );
}

/** Serialises a value and refuses what JSON cannot carry or the server would. */
export function encodeValue(value: unknown): string {
  // `JSON.stringify(NaN)` is `"null"`: a counter that silently became null is
  // the bug this refusal exists for. Nested non-finite numbers still turn into
  // `null`, as in every JSON encoder.
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new TypeError(
      "kv value must be a finite number, not NaN or Infinity",
    );
  }
  const text: string | undefined = JSON.stringify(value);
  if (text === undefined) {
    throw new TypeError("kv value must be JSON-serialisable (not undefined)");
  }
  if (kvValueBytes(text) > kvMaxValueBytes) {
    throw new RangeError(`kv value exceeds ${kvMaxValueBytes} bytes`);
  }
  return text;
}

export function checkTtl(ttl: number | undefined): number | undefined {
  if (ttl === undefined) return undefined;
  if (
    Number.isInteger(ttl) &&
    (ttl === 0 || (ttl >= kvTtlMinSeconds && ttl <= kvTtlMaxSeconds))
  ) {
    return ttl;
  }
  throw new RangeError(
    `kv ttl must be 0 or an integer between ${kvTtlMinSeconds} and ${kvTtlMaxSeconds} seconds`,
  );
}

export function checkLimit(limit: number | undefined): number | undefined {
  if (limit === undefined) return undefined;
  if (
    Number.isInteger(limit) &&
    limit >= kvListLimitMin &&
    limit <= kvListLimitMax
  ) {
    return limit;
  }
  throw new RangeError(
    `kv list limit must be an integer between ${kvListLimitMin} and ${kvListLimitMax}`,
  );
}

/** Versions start at 1; `If-Match: "0"` is a 400 on the server. */
export function checkVersion(version: number, name: string): number {
  if (Number.isSafeInteger(version) && version >= 1) return version;
  throw new RangeError(`kv ${name} must be a positive integer version`);
}

export function checkDelta(delta: number): number {
  if (Number.isSafeInteger(delta)) return delta;
  throw new RangeError("kv incr delta must be a safe integer");
}

/** A non-empty list prefix is checked with the key grammar on the server. */
export function checkPrefix(prefix: string): string {
  if (
    typeof prefix === "string" &&
    (prefix === "" || kvKeyPattern.test(prefix))
  ) {
    return prefix;
  }
  throw new RangeError(
    "kv list prefix must match ^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$",
  );
}

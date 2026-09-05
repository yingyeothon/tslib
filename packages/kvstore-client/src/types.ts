import type { Logger } from "@yingyeothon/logger";

/**
 * Structural view of the WHATWG `fetch` the client needs. Declared here rather
 * than taken from the DOM lib or `undici-types` so the public `.d.ts` stays
 * dependency-free and the same code runs in browsers and Node >= 20.
 */
export interface KvFetchRequest {
  method: string;
  headers: Record<string, string>;
  body?: string;
}

export interface KvFetchResponse {
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}

export type KvFetchLike = (
  url: string,
  init: KvFetchRequest,
) => Promise<KvFetchResponse>;

export interface KvStoreClientOptions {
  /** `"https://doc.yyt.life"` or `"https://doc-dev.yyt.life"`; no default. */
  baseUrl: string;
  /**
   * The channel JWT (a player) or the auth channel's doc apiKey (the game's
   * server). Sent as `Authorization: Bearer` and never logged. The token is
   * copied at create time; a new token is a new client.
   */
  token: string;
  /** Defaults to the global `fetch`. */
  fetch?: KvFetchLike;
  logger?: Logger;
}

export interface KvStoreClient {
  /**
   * Addresses a collection by its `kv_…` id or by its name, resolved by the
   * server within the caller's project. Pure: builds paths, holds no state.
   */
  collection(nameOrId: string): KvCollection;
}

export type KvScope = "team" | "project" | "user";

export interface KvCollectionInfo {
  /** The `kv_…` id, whichever of id or name `collection()` was given. */
  id: string;
  name: string;
  readScope: KvScope;
  writeScope: KvScope;
  encrypted: boolean;
  maxEntries: number;
  maxEntriesPerOwner: number;
}

export interface KvEntry<T> {
  value: T;
  version: number;
  /** Absolute epoch second, absent when the entry never expires. */
  expiresAt?: number;
}

export interface KvPutOptions {
  /** Seconds, 1 … 366 days; `0` clears the expiry; omitted keeps it. */
  ttl?: number;
  /** Write only while the stored version is exactly this one. */
  ifMatch?: number;
  /** Write only while the key is absent (`If-None-Match: *`). */
  ifNoneMatch?: true;
}

export interface KvDeleteOptions {
  ifMatch?: number;
}

/**
 * `created` and `version` are absent for a caller without the read right;
 * `expiresAt` is present only when this write passed a non-zero `ttl`.
 */
export interface KvWriteResult {
  created?: boolean;
  version?: number;
  expiresAt?: number;
}

export interface KvListOptions {
  prefix?: string;
  cursor?: string;
  /** 1 … 100, server default 50. */
  limit?: number;
  order?: "asc" | "desc";
  /** Ask for each entry's value as well (`values=1`). */
  values?: boolean;
}

export interface KvListEntry<T> {
  /** Present only when listing every owner of a user namespace. */
  owner?: string;
  key: string;
  version: number;
  bytes: number;
  expiresAt?: number;
  updatedAt: number;
  /** Present only with `values: true`. */
  value?: T;
}

export interface KvPage<T> {
  entries: KvListEntry<T>[];
  nextCursor?: string;
}

export interface KvIncrOptions {
  ttl?: number;
}

export interface KvIncrResult {
  value: number;
  version: number;
  /** Present only when this call passed a non-zero `ttl`. */
  expiresAt?: number;
}

export interface KvNamespace {
  /**
   * The stored value, or `undefined` on `404` — which is also what an unknown
   * collection answers, so a misspelt name reads as "nothing saved yet".
   */
  get<T = unknown>(key: string): Promise<T | undefined>;
  /** The value with its version and expiry, or `undefined` on `404` (see `get`). */
  getEntry<T = unknown>(key: string): Promise<KvEntry<T> | undefined>;
  /** `JSON.stringify(value)` as the body; `undefined` is refused locally. */
  put(
    key: string,
    value: unknown,
    options?: KvPutOptions,
  ): Promise<KvWriteResult>;
  /**
   * Resolves whether or not the key existed: the server answers a reader's
   * delete of a missing key with `404` and a write-only caller's with `204`,
   * and this method folds the first into the second. A lost `ifMatch` is
   * still a `409`.
   */
  delete(key: string, options?: KvDeleteOptions): Promise<void>;
  list<T = unknown>(options?: KvListOptions): Promise<KvPage<T>>;
  /**
   * Atomic `{"incr": delta}` on a stored integer; needs the read right.
   * `delta` must be a safe integer.
   */
  incr(
    key: string,
    delta: number,
    options?: KvIncrOptions,
  ): Promise<KvIncrResult>;
}

export interface KvCollection extends KvNamespace {
  /** What was passed to `collection()`. */
  readonly ref: string;
  /** `GET /kv/{col}`: scopes, `encrypted`, both caps. */
  info(): Promise<KvCollectionInfo>;
  /** The caller's own user namespace, `/kv/{col}/u/me/entries`. */
  readonly mine: KvNamespace;
  /** Another owner's user namespace; the server key may write any of them. */
  owner(ownerId: string): KvNamespace;
}

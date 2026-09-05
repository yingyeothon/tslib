import type { KvListOptions } from "./types.js";
import {
  checkCollectionRef,
  checkKey,
  checkLimit,
  checkOwnerId,
  checkPrefix,
  checkTtl,
} from "./validate.js";

/** `/kv/{col}`. */
export function collectionPath(ref: string): string {
  return `/kv/${checkCollectionRef(ref)}`;
}

/** `/kv/{col}/entries` or `/kv/{col}/u/{owner}/entries`. */
export function entriesPath(ref: string, owner: string | undefined): string {
  const base = collectionPath(ref);
  return owner === undefined
    ? `${base}/entries`
    : `${base}/u/${checkOwnerId(owner)}/entries`;
}

/** `…/entries/{key}`. */
export function entryPath(
  ref: string,
  owner: string | undefined,
  key: string,
): string {
  return `${entriesPath(ref, owner)}/${checkKey(key)}`;
}

/** `?prefix&cursor&limit&order&values=1`, or `""` when nothing is set. */
export function listQuery(options: KvListOptions = {}): string {
  const params = new URLSearchParams();
  if (options.prefix !== undefined) {
    params.set("prefix", checkPrefix(options.prefix));
  }
  if (options.cursor !== undefined) params.set("cursor", options.cursor);
  const limit = checkLimit(options.limit);
  if (limit !== undefined) params.set("limit", String(limit));
  if (options.order !== undefined) params.set("order", options.order);
  if (options.values === true) params.set("values", "1");
  const query = params.toString();
  return query === "" ? "" : `?${query}`;
}

/** `?ttl=` or `""`. */
export function ttlQuery(ttl: number | undefined): string {
  const checked = checkTtl(ttl);
  return checked === undefined ? "" : `?ttl=${checked}`;
}

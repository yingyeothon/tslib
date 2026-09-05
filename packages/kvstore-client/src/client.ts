import type { Logger } from "@yingyeothon/logger";
import { nullLogger } from "@yingyeothon/logger";
import {
  createKvStoreError,
  kvStoreErrorFromResponse,
  parseEtagVersion,
  parseExpiresAt,
} from "./errors.js";
import {
  collectionPath,
  entriesPath,
  entryPath,
  listQuery,
  ttlQuery,
} from "./paths.js";
import type {
  KvCollection,
  KvCollectionInfo,
  KvEntry,
  KvFetchLike,
  KvFetchResponse,
  KvIncrResult,
  KvListEntry,
  KvListOptions,
  KvNamespace,
  KvPage,
  KvStoreClient,
  KvStoreClientOptions,
  KvWriteResult,
} from "./types.js";
import { checkDelta, checkVersion, encodeValue } from "./validate.js";

type Route = "meta" | "entries" | "entry" | "incr";

/** The alias the server resolves to the JWT's own `sub`. */
const selfOwner = "me";

interface RequestSpec {
  method: "GET" | "PUT" | "PATCH" | "DELETE";
  path: string;
  route: Route;
  headers?: Record<string, string>;
  body?: string;
}

interface Answer {
  status: number;
  headers: KvFetchResponse["headers"];
  text: string;
}

/**
 * `https://host` or `https://host/prefix`, nothing else: userinfo, a query or
 * a fragment would end up in a URL `fetch` rejects with a message that quotes
 * the URL — and with it the collection and the key.
 */
function checkBaseUrl(baseUrl: unknown): string {
  let url: URL;
  try {
    url = new URL(baseUrl as string);
  } catch {
    throw new RangeError("kv baseUrl must be an http(s) URL");
  }
  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new RangeError(
      "kv baseUrl must be an http(s) origin with an optional path and nothing else",
    );
  }
  return `${url.origin}${url.pathname}`.replace(/\/+$/, "");
}

function resolveFetch(injected: KvFetchLike | undefined): KvFetchLike {
  if (injected !== undefined) return injected;
  const global = (globalThis as { fetch?: KvFetchLike }).fetch;
  if (global === undefined) {
    throw new Error("No global fetch; pass the fetch option");
  }
  return global;
}

/**
 * Fails loudly on a body the server promised would be JSON and is not. The
 * `SyntaxError` is deliberately not attached as `cause`: its message quotes
 * the first bytes of the body, which on an entry route is a stored value.
 */
function parseJson<T>(status: number, text: string): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    throw createKvStoreError({ status, code: "malformed_response" });
  }
}

/**
 * The single request choke point: one header assembly, one place the token is
 * used, one log line per request. Only the route pattern, the method, the
 * status and the body size are logged — never the collection, the key, the
 * value or the token.
 */
function createRequester(
  baseUrl: string,
  token: string,
  fetchImpl: KvFetchLike,
  logger: Logger,
) {
  const origin = baseUrl;
  const authorization = `Bearer ${token}`;
  return async function request(spec: RequestSpec): Promise<Answer> {
    const headers: Record<string, string> = {
      authorization,
      ...spec.headers,
    };
    if (spec.body !== undefined) {
      headers["content-type"] = "application/json";
    }
    let response: KvFetchResponse;
    try {
      response = await fetchImpl(`${origin}${spec.path}`, {
        method: spec.method,
        headers,
        ...(spec.body === undefined ? {} : { body: spec.body }),
      });
    } catch (cause) {
      logger.warn("kv request failed", {
        method: spec.method,
        route: spec.route,
      });
      throw createKvStoreError({ status: 0, code: "network", cause });
    }
    const text = await response.text();
    logger.debug("kv request", {
      method: spec.method,
      route: spec.route,
      status: response.status,
      chars: text.length,
    });
    if (response.status < 200 || response.status >= 300) {
      throw kvStoreErrorFromResponse(response.status, text);
    }
    return { status: response.status, headers: response.headers, text };
  };
}

type Requester = ReturnType<typeof createRequester>;

function conditionHeaders(options: {
  ifMatch?: number;
  ifNoneMatch?: true;
}): Record<string, string> {
  const headers: Record<string, string> = {};
  if (options.ifMatch !== undefined && options.ifNoneMatch !== undefined) {
    throw new RangeError("kv ifMatch and ifNoneMatch cannot be combined");
  }
  if (options.ifMatch !== undefined) {
    headers["if-match"] = `"${checkVersion(options.ifMatch, "ifMatch")}"`;
  }
  if (options.ifNoneMatch === true) headers["if-none-match"] = "*";
  return headers;
}

/** The wire shape of one list row; `valueText` is the stored JSON verbatim. */
interface WireListEntry {
  owner?: string;
  key: string;
  version: number;
  bytes: number;
  expiresAt?: number | null;
  updatedAt: number;
  valueText?: string;
}

interface WireListPage {
  entries: WireListEntry[];
  nextCursor?: string;
}

function createNamespace(
  request: Requester,
  ref: string,
  owner: string | undefined,
): KvNamespace {
  // Paths are validated once here, so a bad collection or owner throws at
  // `collection()` / `owner()` time rather than on the first call.
  const entries = entriesPath(ref, owner);

  /** `404` on an entry route means "no such entry" (or no such collection). */
  const isMissing = (error: unknown): boolean =>
    typeof error === "object" &&
    error !== null &&
    (error as { status?: unknown }).status === 404;

  async function readEntry<T>(key: string): Promise<KvEntry<T> | undefined> {
    const path = entryPath(ref, owner, key);
    let answer: Answer;
    try {
      answer = await request({ method: "GET", path, route: "entry" });
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
    const value = parseJson<T>(answer.status, answer.text);
    const version = parseEtagVersion(answer.headers.get("etag"));
    if (version === undefined) {
      throw createKvStoreError({
        status: answer.status,
        code: "malformed_response",
      });
    }
    const expiresAt = parseExpiresAt(answer.headers.get("x-kv-expires-at"));
    return {
      value,
      version,
      ...(expiresAt === undefined ? {} : { expiresAt }),
    };
  }

  return {
    async get<T>(key: string): Promise<T | undefined> {
      const entry = await readEntry<T>(key);
      return entry === undefined ? undefined : entry.value;
    },
    getEntry: readEntry,
    async put(key, value, options = {}): Promise<KvWriteResult> {
      const path = entryPath(ref, owner, key) + ttlQuery(options.ttl);
      const headers = conditionHeaders(options);
      const body = encodeValue(value);
      const answer = await request({
        method: "PUT",
        path,
        route: "entry",
        headers,
        body,
      });
      const version = parseEtagVersion(answer.headers.get("etag"));
      const expiresAt = parseExpiresAt(answer.headers.get("x-kv-expires-at"));
      return {
        // 201 and the ETag are both facts about stored data, and a write-only
        // caller is told neither: it always sees 204 and no ETag.
        ...(version === undefined
          ? {}
          : { created: answer.status === 201, version }),
        ...(expiresAt === undefined ? {} : { expiresAt }),
      };
    },
    async delete(key, options = {}): Promise<void> {
      const path = entryPath(ref, owner, key);
      const headers = conditionHeaders({ ifMatch: options.ifMatch });
      try {
        await request({ method: "DELETE", path, route: "entry", headers });
      } catch (error) {
        // A reader deleting an absent key gets 404 from the server; a
        // write-only caller gets 204. Deleting is idempotent to both.
        if (!isMissing(error)) throw error;
      }
    },
    async list<T>(options: KvListOptions = {}): Promise<KvPage<T>> {
      const path = entries + listQuery(options);
      const answer = await request({ method: "GET", path, route: "entries" });
      const page = parseJson<WireListPage>(answer.status, answer.text);
      if (!Array.isArray(page.entries)) {
        throw createKvStoreError({
          status: answer.status,
          code: "malformed_response",
        });
      }
      const rows: KvListEntry<T>[] = page.entries.map((row) => ({
        ...(row.owner === undefined ? {} : { owner: row.owner }),
        key: row.key,
        version: row.version,
        bytes: row.bytes,
        ...(typeof row.expiresAt === "number"
          ? { expiresAt: row.expiresAt }
          : {}),
        updatedAt: row.updatedAt,
        ...(row.valueText === undefined
          ? {}
          : { value: parseJson<T>(answer.status, row.valueText) }),
      }));
      return {
        entries: rows,
        ...(page.nextCursor === undefined
          ? {}
          : { nextCursor: page.nextCursor }),
      };
    },
    async incr(key, delta, options = {}): Promise<KvIncrResult> {
      const path = entryPath(ref, owner, key) + ttlQuery(options.ttl);
      const body = JSON.stringify({ incr: checkDelta(delta) });
      const answer = await request({
        method: "PATCH",
        path,
        route: "incr",
        body,
      });
      const result = parseJson<KvIncrResult>(answer.status, answer.text);
      const expiresAt = parseExpiresAt(answer.headers.get("x-kv-expires-at"));
      return {
        value: result.value,
        version: result.version,
        ...(expiresAt === undefined ? {} : { expiresAt }),
      };
    },
  };
}

function createCollection(request: Requester, ref: string): KvCollection {
  const meta = collectionPath(ref);
  const shared = createNamespace(request, ref, undefined);
  return {
    ...shared,
    ref,
    async info(): Promise<KvCollectionInfo> {
      const answer = await request({
        method: "GET",
        path: meta,
        route: "meta",
      });
      return parseJson<KvCollectionInfo>(answer.status, answer.text);
    },
    mine: createNamespace(request, ref, selfOwner),
    owner(ownerId: string): KvNamespace {
      return createNamespace(request, ref, ownerId);
    },
  };
}

/**
 * A client for the yyt key-value store served by the state stack. It speaks
 * for one credential: the channel JWT of a player or the doc apiKey of the
 * game's server; the two differ only in which `/u/{ownerId}` namespaces the
 * server lets them touch.
 */
export function createKvStoreClient(
  options: KvStoreClientOptions,
): KvStoreClient {
  const { token, logger = nullLogger } = options;
  const origin = checkBaseUrl(options.baseUrl);
  // RFC 7235 token68 characters only. A stray newline or NUL (a token copied
  // from a file) would otherwise make `fetch` itself throw, and that
  // TypeError quotes the whole header value — the credential — in its message.
  if (typeof token !== "string" || !/^[\x21-\x7E]+$/.test(token)) {
    throw new RangeError(
      "kv token is required and must contain no whitespace or control characters",
    );
  }
  const request = createRequester(
    origin,
    token,
    resolveFetch(options.fetch),
    logger,
  );
  return {
    collection(nameOrId: string): KvCollection {
      return createCollection(request, nameOrId);
    },
  };
}

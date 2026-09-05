import { inspect } from "node:util";
import type { Logger } from "@yingyeothon/logger";
import { describe, expect, it } from "vitest";
import {
  createKvStoreClient,
  isKvConflict,
  isKvForbidden,
  isKvFull,
  isKvStoreError,
  isKvUnauthorized,
  kvMaxValueBytes,
} from "../src/index.js";
import { createFakeFetch, error, json } from "./fake-fetch.js";

// A fixture no unrelated text can collide with; asserted in segments too.
const token = "HEAD-ALPHA-9f2.BODY-BRAVO-7c1.SIG-CHARLIE-3e8";
const baseUrl = "https://doc-dev.yyt.life";
const id = "kv_01j8x2z3y4w5v6u7t8s9r0q1p2";

function capturingLogger() {
  const lines: string[] = [];
  const write = (...args: unknown[]) => {
    lines.push(
      args
        .map((a) =>
          a instanceof Error
            ? `${a.name} ${a.message} ${a.stack ?? ""}`
            : typeof a === "string"
              ? a
              : JSON.stringify(a),
        )
        .join(" "),
    );
  };
  const logger: Logger = {
    severity: "debug",
    debug: write,
    info: write,
    warn: write,
    error: write,
  };
  return { logger, lines };
}

/** The rejection of a promise, typed, so a test can inspect it. */
async function failureOf(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected a rejection");
}

function client(
  fetch: ReturnType<typeof createFakeFetch>["fetch"],
  logger?: Logger,
) {
  return createKvStoreClient({ baseUrl, token, fetch, logger });
}

describe("createKvStoreClient", () => {
  it("refuses a missing token or a non-http base URL before any request", () => {
    const { fetch, requests } = createFakeFetch([]);
    expect(() => createKvStoreClient({ baseUrl, token: "", fetch })).toThrow(
      RangeError,
    );
    expect(() =>
      createKvStoreClient({ baseUrl: "doc.yyt.life", token, fetch }),
    ).toThrow(RangeError);
    for (const bad of [
      "ftp://doc.yyt.life",
      "https://u:p@doc.yyt.life",
      "https://doc.yyt.life?x=1",
      "https://doc.yyt.life#f",
    ]) {
      expect(() => createKvStoreClient({ baseUrl: bad, token, fetch })).toThrow(
        RangeError,
      );
    }
    expect(requests).toHaveLength(0);
  });

  it("refuses a token with whitespace or control characters, without echoing it", () => {
    const { fetch } = createFakeFetch([]);
    for (const bad of [
      `${token}\n`,
      `Bearer ${token}`,
      `${token}\u0000`,
      " ",
    ]) {
      let thrown: unknown;
      try {
        createKvStoreClient({ baseUrl, token: bad, fetch });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(RangeError);
      expect(inspect(thrown)).not.toContain("HEAD-ALPHA-9f2");
    }
  });

  it("keeps a path prefix on baseUrl", async () => {
    const fake = createFakeFetch([json(200, { entries: [] })]);
    await createKvStoreClient({
      baseUrl: `${baseUrl}/api/`,
      token,
      fetch: fake.fetch,
    })
      .collection("c")
      .list();
    expect(fake.only().url).toBe(`${baseUrl}/api/kv/c/entries`);
  });

  it("strips a trailing slash from baseUrl and sends the bearer header", async () => {
    const fake = createFakeFetch([
      json(200, {
        readScope: "project",
        writeScope: "team",
        encrypted: false,
        maxEntries: 10000,
        maxEntriesPerOwner: 100,
      }),
    ]);
    const kv = createKvStoreClient({
      baseUrl: `${baseUrl}/`,
      token,
      fetch: fake.fetch,
    });
    const info = await kv.collection("announcements").info();
    expect(info.writeScope).toBe("team");
    const request = fake.only();
    expect(request.url).toBe(`${baseUrl}/kv/announcements`);
    expect(request.method).toBe("GET");
    expect(request.headers).toEqual({ authorization: `Bearer ${token}` });
    expect(request.body).toBeUndefined();
  });
});

describe("collection()", () => {
  it("puts a kv_ id on the path as is", () => {
    const { fetch } = createFakeFetch([]);
    expect(client(fetch).collection(id).ref).toBe(id);
  });

  it.each([
    "",
    "-lead",
    "a/b",
    "a b",
    "KV_01J8X2Z3Y4W5V6U7T8S9R0Q1P2",
    "x".repeat(65),
    "a%2Fb",
  ])("refuses %j locally instead of encoding it", (ref) => {
    const { fetch, requests } = createFakeFetch([]);
    expect(() => client(fetch).collection(ref)).toThrow(RangeError);
    expect(requests).toHaveLength(0);
  });

  it("refuses an owner outside the server's grammar", () => {
    const { fetch } = createFakeFetch([]);
    const col = client(fetch).collection("profile");
    expect(() => col.owner("me/../x")).toThrow(RangeError);
    expect(() => col.owner("")).toThrow(RangeError);
    expect(col.owner("0123456789abcdef0123456789abcdef")).toBeDefined();
    expect(col.owner("bot:npc-1")).toBeDefined();
  });
});

describe("get / getEntry", () => {
  it("parses the body and reads the version and expiry from headers", async () => {
    const fake = createFakeFetch([
      json(
        200,
        { volume: 0.5 },
        { ETag: '"3"', "X-KV-Expires-At": "1800000000" },
      ),
    ]);
    const entry = await client(fake.fetch)
      .collection("profile")
      .mine.getEntry<{ volume: number }>("settings");
    expect(entry).toEqual({
      value: { volume: 0.5 },
      version: 3,
      expiresAt: 1800000000,
    });
    const request = fake.only();
    expect(request.url).toBe(`${baseUrl}/kv/profile/u/me/entries/settings`);
    expect(request.method).toBe("GET");
  });

  it("omits expiresAt when the header is absent and accepts a weak ETag", async () => {
    const fake = createFakeFetch([json(200, 7, { etag: 'W/"12"' })]);
    const entry = await client(fake.fetch).collection("c").getEntry("n");
    expect(entry).toEqual({ value: 7, version: 12 });
  });

  it("answers undefined on 404 for get/getEntry, and surfaces 403", async () => {
    const fake = createFakeFetch([
      error(404, "not_found"),
      error(404, "not_found"),
      error(403, "forbidden"),
    ]);
    const col = client(fake.fetch).collection("profile");
    await expect(col.get("missing")).resolves.toBeUndefined();
    await expect(col.mine.getEntry("missing")).resolves.toBeUndefined();
    await expect(col.get("secret")).rejects.toSatisfy(isKvForbidden);
  });

  it("surfaces 404 from every method that is not a read or a delete", async () => {
    const fake = createFakeFetch([
      error(404, "not_found"),
      error(404, "not_found"),
      error(404, "not_found"),
      error(404, "not_found"),
    ]);
    const col = client(fake.fetch).collection("gone");
    const missing = { status: 404, code: "not_found" };
    await expect(col.put("k", 1)).rejects.toMatchObject(missing);
    await expect(col.list()).rejects.toMatchObject(missing);
    await expect(col.incr("k", 1)).rejects.toMatchObject(missing);
    await expect(col.info()).rejects.toMatchObject(missing);
  });

  it("reads id and name from info()", async () => {
    const fake = createFakeFetch([
      json(200, {
        id,
        name: "profile",
        readScope: "user",
        writeScope: "user",
        encrypted: false,
        maxEntries: 10000,
        maxEntriesPerOwner: 100,
      }),
    ]);
    const info = await client(fake.fetch).collection("profile").info();
    expect(info.id).toBe(id);
    expect(info.name).toBe("profile");
  });

  it("reads the shared namespace and another owner's namespace", async () => {
    const fake = createFakeFetch([
      json(200, "a", { etag: '"1"' }),
      json(200, "b", { etag: '"1"' }),
    ]);
    const col = client(fake.fetch).collection("profile");
    await col.get("k");
    await col.owner("0123456789abcdef0123456789abcdef").get("k");
    expect(fake.requests.map((r) => r.url)).toEqual([
      `${baseUrl}/kv/profile/entries/k`,
      `${baseUrl}/kv/profile/u/0123456789abcdef0123456789abcdef/entries/k`,
    ]);
  });

  it("reports a non-JSON 200 body as malformed_response without quoting the body", async () => {
    const fake = createFakeFetch([
      { status: 200, headers: { etag: '"1"' }, body: "<html>VALUE-FOX-2a7" },
    ]);
    const failure = await failureOf(
      client(fake.fetch).collection("c").get("k"),
    );
    expect(failure).toMatchObject({
      name: "KvStoreError",
      code: "malformed_response",
      status: 200,
    });
    // A SyntaxError's message quotes the first bytes of the body, which on
    // this route is a stored value; it must not ride along as `cause`.
    expect(inspect(failure, { depth: 5 })).not.toContain("VALUE-FOX-2a7");
  });

  it("reports a 200 without a usable ETag as malformed_response", async () => {
    const fake = createFakeFetch([json(200, 1)]);
    await expect(
      client(fake.fetch).collection("c").get("k"),
    ).rejects.toMatchObject({
      code: "malformed_response",
      status: 200,
    });
  });
});

describe("put", () => {
  it("sends JSON with content-type and reads back created/version/expiresAt", async () => {
    const fake = createFakeFetch([
      {
        status: 201,
        headers: { etag: '"1"', "x-kv-expires-at": "1700000000" },
      },
    ]);
    const result = await client(fake.fetch)
      .collection("profile")
      .mine.put("settings", { volume: 0.5 }, { ttl: 3600 });
    expect(result).toEqual({
      created: true,
      version: 1,
      expiresAt: 1700000000,
    });
    const request = fake.only();
    expect(request.method).toBe("PUT");
    expect(request.url).toBe(
      `${baseUrl}/kv/profile/u/me/entries/settings?ttl=3600`,
    );
    expect(request.headers).toEqual({
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    });
    expect(request.body).toBe('{"volume":0.5}');
  });

  it("reports an update as created: false", async () => {
    const fake = createFakeFetch([{ status: 204, headers: { etag: '"2"' } }]);
    const result = await client(fake.fetch).collection("c").put("k", 1);
    expect(result).toEqual({ created: false, version: 2 });
  });

  it("returns {} for a write-only caller (204, no ETag), plus expiresAt when this write set a ttl", async () => {
    const fake = createFakeFetch([
      { status: 204 },
      { status: 204, headers: { "x-kv-expires-at": "1700000000" } },
    ]);
    const inbox = client(fake.fetch).collection("inbox").mine;
    expect(await inbox.put("m1", { hi: 1 })).toEqual({});
    expect(await inbox.put("m2", { hi: 2 }, { ttl: 60 })).toEqual({
      expiresAt: 1700000000,
    });
  });

  it("refuses a non-finite top-level number instead of storing null", async () => {
    const { fetch, requests } = createFakeFetch([]);
    const col = client(fetch).collection("c");
    await expect(col.put("k", NaN)).rejects.toThrow(TypeError);
    await expect(col.put("k", Infinity)).rejects.toThrow(TypeError);
    expect(requests).toHaveLength(0);
  });

  it("sends If-Match / If-None-Match and ttl=0", async () => {
    const fake = createFakeFetch([
      { status: 204, headers: { etag: '"4"' } },
      { status: 201, headers: { etag: '"1"' } },
    ]);
    const col = client(fake.fetch).collection("c");
    await col.put("k", 1, { ifMatch: 3, ttl: 0 });
    await col.put("k2", 1, { ifNoneMatch: true });
    expect(fake.requests[0]!.url).toBe(`${baseUrl}/kv/c/entries/k?ttl=0`);
    expect(fake.requests[0]!.headers["if-match"]).toBe('"3"');
    expect(fake.requests[0]!.headers["if-none-match"]).toBeUndefined();
    expect(fake.requests[1]!.headers["if-none-match"]).toBe("*");
    expect(fake.requests[1]!.headers["if-match"]).toBeUndefined();
  });

  it("surfaces a lost compare-and-set with the live version (reader)", async () => {
    const fake = createFakeFetch([error(409, "conflict", { current: 5 })]);
    const failure = await client(fake.fetch)
      .collection("c")
      .put("k", 1, { ifMatch: 3 })
      .catch((e: unknown) => e);
    expect(isKvConflict(failure)).toBe(true);
    expect(isKvFull(failure)).toBe(false);
    expect(failure).toMatchObject({
      status: 409,
      code: "conflict",
      currentVersion: 5,
    });
  });

  it("surfaces an absent key on If-Match as currentVersion null", async () => {
    const fake = createFakeFetch([error(409, "conflict", { current: null })]);
    const failure = await client(fake.fetch)
      .collection("c")
      .put("k", 1, { ifMatch: 3 })
      .catch((e: unknown) => e);
    expect(failure).toMatchObject({ currentVersion: null });
  });

  it("surfaces a write-only 409 without current, and the cap reasons", async () => {
    const fake = createFakeFetch([
      error(409, "conflict"),
      error(409, "conflict", { reason: "collection_full" }),
      error(409, "conflict", { reason: "owner_full" }),
      error(409, "conflict", { reason: "encrypted" }),
    ]);
    const col = client(fake.fetch).collection("c");
    const bare = await col
      .put("k", 1, { ifNoneMatch: true })
      .catch((e: unknown) => e);
    expect(bare).toMatchObject({ status: 409, code: "conflict" });
    expect(
      (bare as { currentVersion?: unknown }).currentVersion,
    ).toBeUndefined();
    const full = await col.put("k", 1).catch((e: unknown) => e);
    expect(isKvFull(full)).toBe(true);
    expect(full).toMatchObject({ reason: "collection_full" });
    expect(isKvFull(await col.put("k", 1).catch((e: unknown) => e))).toBe(true);
    const encrypted = await col.put("k", 1).catch((e: unknown) => e);
    expect(isKvFull(encrypted)).toBe(false);
    expect(encrypted).toMatchObject({ reason: "encrypted" });
  });

  it("surfaces 403 on a conditional write without the read right, and 401", async () => {
    const fake = createFakeFetch([
      error(403, "forbidden"),
      error(401, "unauthorized"),
    ]);
    const col = client(fake.fetch).collection("inbox");
    await expect(col.mine.put("k", 1, { ifMatch: 1 })).rejects.toSatisfy(
      isKvForbidden,
    );
    await expect(col.mine.put("k", 1)).rejects.toSatisfy(isKvUnauthorized);
  });

  it("surfaces 400 wrong_namespace as its reason", async () => {
    const fake = createFakeFetch([
      error(400, "bad_request", { reason: "wrong_namespace" }),
    ]);
    await expect(
      client(fake.fetch).collection("profile").put("k", 1),
    ).rejects.toMatchObject({
      status: 400,
      code: "bad_request",
      reason: "wrong_namespace",
    });
  });

  it("surfaces 503 kv_encryption_not_configured", async () => {
    const fake = createFakeFetch([
      error(503, "unavailable", { reason: "kv_encryption_not_configured" }),
    ]);
    await expect(
      client(fake.fetch).collection("c").put("k", 1),
    ).rejects.toMatchObject({
      status: 503,
      reason: "kv_encryption_not_configured",
    });
  });

  it("names a non-JSON error body by its status", async () => {
    const fake = createFakeFetch([{ status: 502, body: "Bad Gateway" }]);
    await expect(
      client(fake.fetch).collection("c").put("k", 1),
    ).rejects.toMatchObject({
      status: 502,
      code: "http_502",
    });
  });

  it("refuses locally, before any fetch: undefined, oversize, ttl, both conditions, key grammar", async () => {
    const { fetch, requests } = createFakeFetch([]);
    const col = client(fetch).collection("c");
    await expect(col.put("k", undefined)).rejects.toThrow(TypeError);
    await expect(col.put("k", () => 1)).rejects.toThrow(TypeError);
    await expect(col.put("k", "x".repeat(kvMaxValueBytes))).rejects.toThrow(
      RangeError,
    );
    // 16 KiB of body is fine when the *encoded* form fits: 16382 chars + 2 quotes.
    await expect(col.put("k", "é".repeat(kvMaxValueBytes / 2))).rejects.toThrow(
      RangeError,
    );
    await expect(col.put("k", 1, { ttl: 0.5 })).rejects.toThrow(RangeError);
    await expect(col.put("k", 1, { ttl: -1 })).rejects.toThrow(RangeError);
    await expect(col.put("k", 1, { ttl: 366 * 86400 + 1 })).rejects.toThrow(
      RangeError,
    );
    await expect(
      col.put("k", 1, { ifMatch: 1, ifNoneMatch: true }),
    ).rejects.toThrow(RangeError);
    await expect(col.put("k", 1, { ifMatch: -1 })).rejects.toThrow(RangeError);
    // `If-Match: "0"` is a 400 on the server; `ifNoneMatch` is the create form.
    await expect(col.put("k", 1, { ifMatch: 0 })).rejects.toThrow(RangeError);
    await expect(col.put("", 1)).rejects.toThrow(RangeError);
    await expect(col.put("a/b", 1)).rejects.toThrow(RangeError);
    await expect(col.put(".hidden", 1)).rejects.toThrow(RangeError);
    await expect(col.put("k".repeat(129), 1)).rejects.toThrow(RangeError);
    expect(requests).toHaveLength(0);
  });

  it("accepts the largest value the server does", async () => {
    const fake = createFakeFetch([{ status: 201, headers: { etag: '"1"' } }]);
    await client(fake.fetch)
      .collection("c")
      .put("k", "x".repeat(kvMaxValueBytes - 2));
    expect(fake.only().body).toHaveLength(kvMaxValueBytes);
  });
});

describe("delete", () => {
  it("resolves on 404 too (a reader deleting an absent key), and surfaces a 409", async () => {
    const fake = createFakeFetch([
      error(404, "not_found"),
      error(409, "conflict", { current: 3 }),
    ]);
    const col = client(fake.fetch).collection("c");
    await expect(col.delete("gone")).resolves.toBeUndefined();
    await expect(col.delete("k", { ifMatch: 2 })).rejects.toMatchObject({
      status: 409,
      currentVersion: 3,
    });
  });

  it("sends DELETE with an optional If-Match and resolves on 204", async () => {
    const fake = createFakeFetch([{ status: 204 }, { status: 204 }]);
    const col = client(fake.fetch).collection("c");
    await expect(col.delete("k")).resolves.toBeUndefined();
    await expect(col.mine.delete("k", { ifMatch: 2 })).resolves.toBeUndefined();
    expect(fake.requests[0]).toMatchObject({
      method: "DELETE",
      url: `${baseUrl}/kv/c/entries/k`,
      headers: { authorization: `Bearer ${token}` },
      body: undefined,
    });
    expect(fake.requests[1]!.url).toBe(`${baseUrl}/kv/c/u/me/entries/k`);
    expect(fake.requests[1]!.headers["if-match"]).toBe('"2"');
  });
});

describe("list", () => {
  it("builds the query and parses valueText into value", async () => {
    const fake = createFakeFetch([
      json(200, {
        entries: [
          {
            key: "n2",
            version: 1,
            bytes: 12,
            expiresAt: null,
            updatedAt: 1700000001,
            valueText: '{"title":"b"}',
          },
          {
            key: "n1",
            version: 3,
            bytes: 12,
            expiresAt: 1800000000,
            updatedAt: 1700000000,
            valueText: '{"title":"a"}',
          },
        ],
        nextCursor: "c2",
      }),
    ]);
    const page = await client(fake.fetch)
      .collection("announcements")
      .list<{ title: string }>({
        values: true,
        order: "desc",
        prefix: "n",
        limit: 2,
        cursor: "c 1&x",
      });
    expect(page).toEqual({
      entries: [
        {
          key: "n2",
          version: 1,
          bytes: 12,
          updatedAt: 1700000001,
          value: { title: "b" },
        },
        {
          key: "n1",
          version: 3,
          bytes: 12,
          expiresAt: 1800000000,
          updatedAt: 1700000000,
          value: { title: "a" },
        },
      ],
      nextCursor: "c2",
    });
    const url = new URL(fake.only().url);
    expect(url.pathname).toBe("/kv/announcements/entries");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      prefix: "n",
      cursor: "c 1&x",
      limit: "2",
      order: "desc",
      values: "1",
    });
  });

  it("sends no query by default and keeps owner on an every-owner listing", async () => {
    const fake = createFakeFetch([
      json(200, {
        entries: [
          {
            owner: "0123456789abcdef0123456789abcdef",
            key: "k",
            version: 1,
            bytes: 1,
            updatedAt: 1,
          },
        ],
      }),
    ]);
    const page = await client(fake.fetch).collection("profile").list();
    expect(fake.only().url).toBe(`${baseUrl}/kv/profile/entries`);
    expect(page.entries[0]).toEqual({
      owner: "0123456789abcdef0123456789abcdef",
      key: "k",
      version: 1,
      bytes: 1,
      updatedAt: 1,
    });
    expect(page.nextCursor).toBeUndefined();
  });

  it("lists one owner's namespace", async () => {
    const fake = createFakeFetch([json(200, { entries: [] })]);
    await client(fake.fetch).collection("profile").mine.list({ limit: 100 });
    expect(fake.only().url).toBe(
      `${baseUrl}/kv/profile/u/me/entries?limit=100`,
    );
  });

  it("reports a list body without entries as malformed_response", async () => {
    const fake = createFakeFetch([json(200, {})]);
    await expect(
      client(fake.fetch).collection("c").list(),
    ).rejects.toMatchObject({
      code: "malformed_response",
      status: 200,
    });
  });

  it("refuses a limit outside 1 … 100 locally", async () => {
    const { fetch, requests } = createFakeFetch([]);
    const col = client(fetch).collection("c");
    await expect(col.list({ limit: 0 })).rejects.toThrow(RangeError);
    await expect(col.list({ limit: 101 })).rejects.toThrow(RangeError);
    await expect(col.list({ limit: 1.5 })).rejects.toThrow(RangeError);
    expect(requests).toHaveLength(0);
  });

  it("refuses a prefix outside the key grammar locally, and accepts an empty one", async () => {
    const { fetch, requests } = createFakeFetch([json(200, { entries: [] })]);
    const col = client(fetch).collection("c");
    await expect(col.list({ prefix: "a/b" })).rejects.toThrow(RangeError);
    await expect(col.list({ prefix: ".x" })).rejects.toThrow(RangeError);
    expect(requests).toHaveLength(0);
    await col.list({ prefix: "" });
    expect(requests[0]!.url).toBe(`${baseUrl}/kv/c/entries?prefix=`);
  });
});

describe("incr", () => {
  it("PATCHes {incr} with ttl and returns value and version", async () => {
    const fake = createFakeFetch([json(200, { value: 8, version: 4 })]);
    const result = await client(fake.fetch)
      .collection("c")
      .mine.incr("score", 3, { ttl: 60 });
    expect(result).toEqual({ value: 8, version: 4 });
    const request = fake.only();
    expect(request.method).toBe("PATCH");
    expect(request.url).toBe(`${baseUrl}/kv/c/u/me/entries/score?ttl=60`);
    expect(request.body).toBe('{"incr":3}');
    expect(request.headers["content-type"]).toBe("application/json");
    expect(request.headers["if-match"]).toBeUndefined();
  });

  it("reads expiresAt from the header when a ttl was set", async () => {
    const fake = createFakeFetch([
      json(200, { value: 1, version: 1 }, { "x-kv-expires-at": "1700000000" }),
    ]);
    const result = await client(fake.fetch)
      .collection("c")
      .incr("k", 1, { ttl: 5 });
    expect(result).toEqual({ value: 1, version: 1, expiresAt: 1700000000 });
  });

  it("refuses a delta that is not a safe integer locally", async () => {
    const { fetch, requests } = createFakeFetch([]);
    const col = client(fetch).collection("c");
    await expect(col.incr("k", 1.5)).rejects.toThrow(RangeError);
    await expect(col.incr("k", NaN)).rejects.toThrow(RangeError);
    await expect(col.incr("k", 2 ** 53)).rejects.toThrow(RangeError);
    expect(requests).toHaveLength(0);
  });

  it("surfaces not_a_number and overflow as 409 reasons that are not full", async () => {
    const fake = createFakeFetch([
      error(409, "conflict", { reason: "not_a_number" }),
      error(409, "conflict", { reason: "overflow" }),
    ]);
    const col = client(fake.fetch).collection("c");
    const first = await col.incr("k", 1).catch((e: unknown) => e);
    expect(isKvConflict(first)).toBe(true);
    expect(isKvFull(first)).toBe(false);
    expect(first).toMatchObject({ reason: "not_a_number" });
    await expect(col.incr("k", 1)).rejects.toMatchObject({
      reason: "overflow",
    });
  });
});

describe("failures and logging", () => {
  it("turns a fetch rejection into status 0 / network with the cause", async () => {
    const cause = new Error("ECONNRESET");
    const fake = createFakeFetch([{ reject: cause }]);
    const failure = await client(fake.fetch)
      .collection("c")
      .get("k")
      .catch((e: unknown) => e);
    expect(isKvStoreError(failure)).toBe(true);
    expect(failure).toMatchObject({ status: 0, code: "network", cause });
  });

  it("never puts the token, the key or the value in a log line or an error", async () => {
    const { logger, lines } = capturingLogger();
    const fake = createFakeFetch([
      { status: 201, headers: { etag: '"1"' } },
      error(409, "conflict", { current: 1 }),
      { reject: new Error("offline") },
    ]);
    const col = client(fake.fetch, logger).collection("profile");
    await col.mine.put("KEY-DELTA-4b1", { secret: "VALUE-ECHO-6d9" });
    const conflict = await failureOf(
      col.mine.put("KEY-DELTA-4b1", 1, { ifNoneMatch: true }),
    );
    const offline = await failureOf(col.get("KEY-DELTA-4b1"));

    // Positive control: something was logged, and it is the route pattern.
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('"route":"entry"');
    expect(lines[0]).toContain('"status":201');
    expect(lines[2]).toContain("kv request failed");

    // `inspect` walks `cause` too; `stack` alone would miss a leak there.
    const haystack = [
      ...lines,
      inspect(conflict, { depth: 5 }),
      inspect(offline, { depth: 5 }),
    ].join("\n");
    for (const secret of [
      token,
      "HEAD-ALPHA-9f2",
      "BODY-BRAVO-7c1",
      "SIG-CHARLIE-3e8",
      "KEY-DELTA-4b1",
      "VALUE-ECHO-6d9",
      "profile",
      baseUrl,
    ]) {
      expect(haystack).not.toContain(secret);
    }
    expect(conflict.message).toBe("kv conflict (409)");
    expect(offline.message).toBe("kv network (0)");
  });

  it("isKvStoreError rejects other errors and accepts a cross-realm shape", () => {
    expect(isKvStoreError(new Error("x"))).toBe(false);
    expect(isKvStoreError(undefined)).toBe(false);
    expect(isKvConflict(new RangeError("x"))).toBe(false);
    // Another realm's Error is not `instanceof` this one; the shape is enough.
    expect(
      isKvStoreError({ name: "KvStoreError", status: 409, code: "conflict" }),
    ).toBe(true);
  });
});

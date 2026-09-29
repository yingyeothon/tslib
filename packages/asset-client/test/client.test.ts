import { inspect } from "node:util";
import type { Logger } from "@yingyeothon/logger";
import { describe, expect, it } from "vitest";
import type {
  AssetBundleClient,
  AssetBundleClientOptions,
  AssetFetchLike,
} from "../src/index.js";
import { createAssetBundleClient, isAssetClientError } from "../src/index.js";
import { encryptAsset, pattern, testKey } from "./encrypt.js";
import type { FakeCdnOptions } from "./fake-cdn.js";
import { createFakeCdn, createMemorySink } from "./fake-cdn.js";

// Byte-wise equality through Buffer: vitest's generic walk takes ~170 ms per
// 130 KB array, and these tests compare hundreds of them.
const view = (a: Uint8Array) =>
  Buffer.from(a.buffer, a.byteOffset, a.byteLength);
expect.addEqualityTesters([
  (a: unknown, b: unknown) =>
    a instanceof Uint8Array && b instanceof Uint8Array
      ? view(a).equals(view(b))
      : undefined,
]);

const base = "https://dev-d.yyt.life/assets/bnd_test/";
const key = testKey(3);
const otherKey = testKey(99);

/** The interesting lengths: segment boundaries of `yyt-enc v1`. */
const lengths = [
  0, 1, 65_463, 65_464, 65_465, 130_968, 130_969, 131_100, 200_000,
];

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

async function failureOf(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected a rejection");
}

function setup(
  cdnOptions: FakeCdnOptions = {},
  clientOptions: Partial<AssetBundleClientOptions> = {},
) {
  const cdn = createFakeCdn(cdnOptions);
  const client = createAssetBundleClient({
    baseUrl: base,
    key: key.text,
    corsSafe: cdnOptions.crossOrigin ?? false,
    fetch: cdn.fetch,
    ...clientOptions,
  });
  /** Encrypts `plain` at `path` (AD = path in a live bundle) and serves it. */
  const serve = (path: string, plain: Uint8Array, ad = path) =>
    cdn.put(base + path, encryptAsset(key.bytes, ad, plain));
  return { cdn, client, serve };
}

const modes = [
  { name: "Node (If-Range, Content-Range)", crossOrigin: false },
  { name: "browser (HEAD, Range only)", crossOrigin: true },
] as const;

describe("createAssetBundleClient", () => {
  it("accepts the key as text or as 32 raw bytes", async () => {
    const cdn = createFakeCdn();
    const plain = pattern(10);
    cdn.put(`${base}a.bin`, encryptAsset(key.bytes, "a.bin", plain));
    for (const k of [key.text, key.bytes]) {
      const client = createAssetBundleClient({
        baseUrl: base,
        key: k,
        fetch: cdn.fetch,
        corsSafe: false,
      });
      expect(await client.read("a.bin")).toEqual(plain);
    }
    // The caller's bytes are copied, not zeroed or kept.
    expect(key.bytes).toEqual(testKey(3).bytes);
  });

  it("refuses every text that is not the canonical yak1 form, without quoting it", () => {
    const suffix = key.text.slice(5);
    const bad: unknown[] = [
      "",
      suffix,
      `yak2.${suffix}`,
      `YAK1.${suffix}`,
      `${key.text}=`,
      `${key.text}A`,
      key.text.slice(0, -1),
      `yak1.${suffix.slice(0, -1)}+`,
      `yak1.${suffix.slice(0, -1)}/`,
      `yak1. ${suffix.slice(1)}`,
      new Uint8Array(31),
      new Uint8Array(33),
      42,
      null,
    ];
    for (const k of bad) {
      const error = (() => {
        try {
          createAssetBundleClient({ baseUrl: base, key: k as string });
        } catch (e) {
          return e as Error;
        }
        throw new Error("accepted a bad key");
      })();
      expect(isAssetClientError(error)).toBe(true);
      expect(error).toMatchObject({ code: "bad_key", status: 0 });
      expect(error.message).toBe("asset bad_key (0)");
    }
  });

  it("agrees with a lenient decoder on which of the 64 last characters make a key", () => {
    // Buffer's base64url decoder ignores the low bits of the last character,
    // so 4 texts decode to each key; exactly one of them re-encodes to itself.
    const alphabet =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const accepted: string[] = [];
    for (const last of alphabet) {
      const text = key.text.slice(0, -1) + last;
      const lenient = Buffer.from(text.slice(5), "base64url");
      const canonical =
        lenient.length === 32 &&
        lenient.toString("base64url") === text.slice(5);
      let ok = true;
      try {
        createAssetBundleClient({ baseUrl: base, key: text });
      } catch {
        ok = false;
      }
      expect(ok).toBe(canonical);
      if (ok) accepted.push(last);
    }
    expect(accepted.join("")).toBe("AEIMQUYcgkosw048");
  });

  it("checks baseUrl and paths locally, before any request, without quoting them", async () => {
    for (const baseUrl of [
      "not a url",
      "ftp://dev-d.yyt.life/assets/b/",
      "https://user:pw@dev-d.yyt.life/assets/b/",
      "https://dev-d.yyt.life/assets/b/?x=1",
      "https://dev-d.yyt.life/assets/b/#x",
    ]) {
      expect(() => createAssetBundleClient({ baseUrl })).toThrow(RangeError);
    }
    // The associated data comes from the URL, so an encrypted bundle needs its shape.
    for (const baseUrl of [
      "https://dev-d.yyt.life/",
      "https://dev-d.yyt.life/files/b/",
      "https://dev-d.yyt.life/assets/b/v1/extra/",
    ]) {
      expect(() => createAssetBundleClient({ baseUrl, key: key.text })).toThrow(
        RangeError,
      );
      expect(() => createAssetBundleClient({ baseUrl })).not.toThrow();
    }

    const { cdn, client } = setup();
    for (const path of [
      "",
      "/a",
      "a/",
      "a//b",
      "./a",
      "a/../b",
      "a\\b",
      "a\nb",
      7,
    ]) {
      const error = await failureOf(client.read(path as string));
      expect(error).toBeInstanceOf(RangeError);
      if (typeof path === "string" && path.length > 1) {
        expect(error.message).not.toContain(path);
      }
    }
    expect(cdn.requests).toHaveLength(0);
  });

  it("refuses a key without WebCrypto, rather than failing on the first read", () => {
    const saved = Object.getOwnPropertyDescriptor(globalThis, "crypto")!;
    Object.defineProperty(globalThis, "crypto", {
      value: {},
      configurable: true,
    });
    try {
      expect(() =>
        createAssetBundleClient({ baseUrl: base, key: key.text }),
      ).toThrow(/WebCrypto is unavailable/);
      // A plain bundle needs no crypto at all.
      expect(() => createAssetBundleClient({ baseUrl: base })).not.toThrow();
    } finally {
      Object.defineProperty(globalThis, "crypto", saved);
    }
  });

  it("defaults corsSafe from the environment and fetch from the global", async () => {
    const savedFetch = globalThis.fetch;
    const cdn = createFakeCdn({ crossOrigin: true });
    const plain = pattern(70_000);
    cdn.put(`${base}a.bin`, encryptAsset(key.bytes, "a.bin", plain));
    globalThis.fetch = cdn.fetch as unknown as typeof fetch;
    const scope = globalThis as { document?: unknown };
    try {
      scope.document = {};
      const browser = createAssetBundleClient({ baseUrl: base, key: key.text });
      expect(
        await browser.readRange("a.bin", { start: 66_000, end: 66_010 }),
      ).toEqual(plain.slice(66_000, 66_010));
      expect(cdn.requests.map((r) => r.method)).toEqual(["HEAD", "GET", "GET"]);
    } finally {
      delete scope.document;
      globalThis.fetch = savedFetch;
    }
    // Without a document, Node's default is the If-Range path.
    const node = createAssetBundleClient({
      baseUrl: base,
      key: key.text,
      fetch: cdn.fetch,
    });
    cdn.requests.length = 0;
    await expect(
      node.readRange("a.bin", { start: 66_000, end: 66_010 }),
    ).rejects.toMatchObject({
      code: "http",
      message: "asset http (206): no Content-Range",
    });
  });

  it("reports no global fetch at create time", () => {
    const savedFetch = globalThis.fetch;
    (globalThis as { fetch?: unknown }).fetch = undefined;
    try {
      expect(() => createAssetBundleClient({ baseUrl: base })).toThrow(
        /No global fetch/,
      );
    } finally {
      globalThis.fetch = savedFetch;
    }
  });

  it("types the real fetch as an AssetFetchLike", () => {
    const real: AssetFetchLike = fetch;
    expect(typeof real).toBe("function");
  });
});

describe("read", () => {
  it.each(lengths)("decrypts a %i-byte file whole", async (length) => {
    const { client, serve, cdn } = setup();
    const plain = pattern(length);
    serve("data/file.bin", plain);
    expect(await client.read("data/file.bin")).toEqual(plain);
    expect(cdn.requests).toEqual([
      {
        url: `${base}data/file.bin`,
        method: "GET",
        headers: {},
        cache: undefined,
      },
    ]);
  });

  it("uses the version below the bundle as associated data", async () => {
    const cdn = createFakeCdn();
    const versioned = `${base}v3/`;
    const plain = pattern(100);
    cdn.put(
      `${versioned}data/songs.db`,
      encryptAsset(key.bytes, "v3/data/songs.db", plain),
    );
    const client = createAssetBundleClient({
      baseUrl: versioned.slice(0, -1), // the trailing slash is optional
      key: key.text,
      fetch: cdn.fetch,
      corsSafe: false,
    });
    expect(await client.read("data/songs.db")).toEqual(plain);
  });

  it("percent-encodes each segment and binds the raw UTF-8 path", async () => {
    const { client, serve, cdn } = setup();
    const path = "v1/데이터/노래 #1?.db";
    const plain = new TextEncoder().encode("hello, 세계\n");
    serve(path, plain);
    cdn.put(
      `${base}${path.split("/").map(encodeURIComponent).join("/")}`,
      encryptAsset(key.bytes, path, plain),
    );
    expect(await client.read(path)).toEqual(plain);
    expect(cdn.requests[0]!.url).toBe(
      `${base}v1/%EB%8D%B0%EC%9D%B4%ED%84%B0/%EB%85%B8%EB%9E%98%20%231%3F.db`,
    );
  });

  it("fails every tampering as asset_corrupt", async () => {
    const plain = pattern(131_100);
    const good = encryptAsset(key.bytes, "a.bin", plain);
    const flip = (at: number) => {
      const copy = good.slice();
      copy[at]! ^= 1;
      return copy;
    };
    const cases: [string, Uint8Array][] = [
      ["a flipped tag byte", flip(65_535)],
      ["a flipped ciphertext byte", flip(70_000)],
      ["a flipped salt byte", flip(5)],
      ["a header length byte other than 0x28", flip(0)],
      ["truncated by one segment", good.slice(0, 65_536 * 2)],
      ["truncated inside the last segment", good.slice(0, -1)],
      ["appended bytes", new Uint8Array([...good, 0])],
      [
        "two segments swapped",
        new Uint8Array([
          ...good.slice(0, 40),
          ...good.slice(65_536, 131_072),
          ...good.slice(40, 65_536),
          ...good.slice(131_072),
        ]),
      ],
      ["the wrong key", encryptAsset(otherKey.bytes, "a.bin", plain)],
      ["the wrong path", encryptAsset(key.bytes, "b.bin", plain)],
      ["shorter than an empty file", good.slice(0, 71)],
      ["a last segment with no plaintext", good.slice(0, 65_536 * 2 + 32)],
    ];
    for (const [name, bytes] of cases) {
      const { client, cdn } = setup();
      cdn.put(`${base}a.bin`, bytes);
      const error = await failureOf(client.read("a.bin"));
      expect(isAssetClientError(error), name).toBe(true);
      expect(error, name).toMatchObject({ code: "asset_corrupt" });
    }
  });

  it("refuses a length no ciphertext has before reading the body", async () => {
    let read = false;
    const fetch: AssetFetchLike = () =>
      Promise.resolve({
        status: 200,
        headers: {
          get: (n: string) => (n === "content-length" ? "999999999" : null),
        },
        arrayBuffer: () => {
          read = true;
          return Promise.resolve(new ArrayBuffer(0));
        },
        body: null,
      });
    const client = createAssetBundleClient({
      baseUrl: base,
      key: key.text,
      fetch,
    });
    await expect(client.read("a.bin")).rejects.toMatchObject({
      code: "asset_corrupt",
      status: 200,
    });
    expect(read).toBe(false);
  });

  it("maps 403 and 404 to not_found, anything else to http, a rejection to network", async () => {
    const statuses = async (status: number) => {
      const fetch: AssetFetchLike = () =>
        Promise.resolve({
          status,
          headers: { get: () => null },
          arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
          body: null,
        });
      const client = createAssetBundleClient({
        baseUrl: base,
        key: key.text,
        fetch,
      });
      return failureOf(client.read("a.bin"));
    };
    expect(await statuses(403)).toMatchObject({
      code: "not_found",
      status: 403,
    });
    expect(await statuses(404)).toMatchObject({
      code: "not_found",
      status: 404,
    });
    expect(await statuses(500)).toMatchObject({ code: "http", status: 500 });
    expect(await statuses(206)).toMatchObject({ code: "http", status: 206 });
    expect(await statuses(304)).toMatchObject({ code: "http", status: 304 });

    const cause = new TypeError("fetch failed");
    const client = createAssetBundleClient({
      baseUrl: base,
      key: key.text,
      fetch: () => Promise.reject(cause),
    });
    expect(await failureOf(client.read("a.bin"))).toMatchObject({
      code: "network",
      status: 0,
      cause,
    });
  });

  it("reports a body that fails mid-transfer as network", async () => {
    const cause = new TypeError("terminated");
    const fetch: AssetFetchLike = () =>
      Promise.resolve({
        status: 200,
        headers: { get: () => null },
        arrayBuffer: () => Promise.reject(cause),
        body: {
          getReader: () => ({
            read: () => Promise.reject(cause),
            cancel: () => Promise.resolve(),
          }),
        },
      });
    const client = createAssetBundleClient({
      baseUrl: base,
      key: key.text,
      fetch,
    });
    expect(await failureOf(client.read("a.bin"))).toMatchObject({
      code: "network",
      status: 200,
      cause,
    });
  });

  it("reads through arrayBuffer when the response has no stream", async () => {
    const plain = pattern(70_000);
    const bytes = encryptAsset(key.bytes, "a.bin", plain);
    const fetch: AssetFetchLike = () =>
      Promise.resolve({
        status: 200,
        headers: { get: () => null },
        arrayBuffer: () => Promise.resolve(bytes.slice().buffer),
        body: null,
      });
    const client = createAssetBundleClient({
      baseUrl: base,
      key: key.text,
      fetch,
    });
    expect(await client.read("a.bin")).toEqual(plain);
  });

  it("passes the cache mode through only when asked", async () => {
    const { client, serve, cdn } = setup();
    serve("manifest.json", new TextEncoder().encode("{}"));
    await client.readJson("manifest.json", { cache: "no-store" });
    await client.readJson("manifest.json");
    expect(cdn.requests.map((r) => r.cache)).toEqual(["no-store", undefined]);
  });

  it("rejects after close()", async () => {
    const { client, serve } = setup();
    serve("a.bin", pattern(3));
    expect(await client.read("a.bin")).toEqual(pattern(3));
    client.close();
    await expect(client.read("a.bin")).rejects.toThrow(
      "asset client is closed",
    );
  });
});

describe("readJson", () => {
  it("parses UTF-8 JSON", async () => {
    const { client, serve } = setup();
    serve("m.json", new TextEncoder().encode('﻿{"songs":["노래"],"n":2}'));
    expect(await client.readJson("m.json")).toEqual({ songs: ["노래"], n: 2 });
  });

  it("is asset_corrupt on bytes that are not UTF-8 JSON, and quotes none of them", async () => {
    const { client, serve } = setup();
    serve("bad.json", new TextEncoder().encode("PLAINTEXT-FOXTROT-5a2 {"));
    serve("bin.json", new Uint8Array([0x7b, 0xff, 0xfe, 0x7d]));
    for (const path of ["bad.json", "bin.json"]) {
      const error = await failureOf(client.readJson(path));
      expect(error).toMatchObject({ code: "asset_corrupt" });
      expect((error as Error & { cause?: unknown }).cause).toBeUndefined();
      expect(inspect(error, { depth: 5 })).not.toContain("FOXTROT");
    }
  });
});

describe.each(modes)("readRange — $name", ({ crossOrigin }) => {
  const size = 200_000;
  const plain = pattern(size);
  // Every boundary of the first three segments, and the edges of the file.
  const cuts = [
    0,
    1,
    65_463,
    65_464,
    65_465,
    130_967,
    130_968,
    130_969,
    196_471,
    196_472,
    size - 1,
    size,
  ];

  it("returns every window across every segment boundary", async () => {
    const { client, serve } = setup({ crossOrigin });
    serve("a.bin", plain);
    for (const start of cuts) {
      for (const end of cuts) {
        if (end <= start) continue;
        expect(
          await client.readRange("a.bin", { start, end }),
          `${start}-${end}`,
        ).toEqual(plain.slice(start, end));
      }
    }
  });

  it.each(lengths)(
    "reads to the end of a %i-byte file and clamps like slice",
    async (length) => {
      const { client, serve } = setup({ crossOrigin });
      const data = pattern(length);
      serve("a.bin", data);
      expect(await client.readRange("a.bin", { start: 0 })).toEqual(data);
      expect(
        await client.readRange("a.bin", { start: Math.max(length - 3, 0) }),
      ).toEqual(data.slice(Math.max(length - 3, 0)));
      expect(
        await client.readRange("a.bin", { start: 1, end: length + 100 }),
      ).toEqual(data.slice(1, length + 100));
      expect(
        await client.readRange("a.bin", { start: length + 5, end: length + 9 }),
      ).toEqual(new Uint8Array(0));
    },
  );

  it("fetches only the segments the window covers", async () => {
    const { client, serve, cdn } = setup({ crossOrigin });
    const etag = serve("a.bin", plain);
    await client.readRange("a.bin", { start: 70_000, end: 70_010 });
    const wire = cdn.requests.map((r) => ({ method: r.method, ...r.headers }));
    if (crossOrigin) {
      // Only `Range` crosses: `If-Range` would need a preflight the CDN refuses.
      expect(wire).toEqual([
        { method: "HEAD" },
        { method: "GET", range: "bytes=0-39" },
        { method: "GET", range: "bytes=65536-131071" },
      ]);
    } else {
      expect(wire).toEqual([
        { method: "GET", range: "bytes=0-39" },
        { method: "GET", range: "bytes=65536-131071", "if-range": etag },
      ]);
    }
  });

  it("fetches the header together with the first segment", async () => {
    const { client, serve, cdn } = setup({ crossOrigin });
    serve("a.bin", plain);
    expect(await client.readRange("a.bin", { start: 10, end: 20 })).toEqual(
      plain.slice(10, 20),
    );
    expect(
      cdn.requests
        .filter((r) => r.method === "GET")
        .map((r) => r.headers.range),
    ).toEqual(["bytes=0-65535"]);
  });

  it("starts over when the object changes between requests", async () => {
    const replacement = pattern(size, 99);
    const changeBefore = crossOrigin ? 2 : 1; // the segments request
    const cdn = createFakeCdn({
      crossOrigin,
      beforeAnswer: (i) => {
        if (i === changeBefore)
          cdn.put(
            `${base}a.bin`,
            encryptAsset(key.bytes, "a.bin", replacement),
          );
      },
    });
    const { logger, lines } = capturingLogger();
    const client = createAssetBundleClient({
      baseUrl: base,
      key: key.text,
      corsSafe: crossOrigin,
      fetch: cdn.fetch,
      logger,
    });
    cdn.put(`${base}a.bin`, encryptAsset(key.bytes, "a.bin", plain));
    expect(
      await client.readRange("a.bin", { start: 70_000, end: 70_100 }),
    ).toEqual(replacement.slice(70_000, 70_100));
    expect(
      lines.some((l) =>
        l.includes("asset changed during a read; starting over"),
      ),
    ).toBe(true);
  });

  it("gives up with http after three restarts", async () => {
    let seed = 0;
    const cdn = createFakeCdn({
      crossOrigin,
      beforeAnswer: (_i, request) => {
        if (
          request.headers.range !== undefined &&
          request.headers.range !== "bytes=0-39"
        ) {
          seed += 1;
          cdn.put(
            `${base}a.bin`,
            encryptAsset(key.bytes, "a.bin", pattern(size, seed)),
          );
        }
      },
    });
    const client = createAssetBundleClient({
      baseUrl: base,
      key: key.text,
      corsSafe: crossOrigin,
      fetch: cdn.fetch,
    });
    cdn.put(`${base}a.bin`, encryptAsset(key.bytes, "a.bin", plain));
    const error = await failureOf(
      client.readRange("a.bin", { start: 70_000, end: 70_100 }),
    );
    expect(error).toMatchObject({ code: "http" });
    expect(error.message).toContain("the object kept changing");
    expect(seed).toBe(4);
  });

  it("detects a change by ETag when the host ignores If-Range", async () => {
    const replacement = pattern(size, 42);
    const cdn = createFakeCdn({
      crossOrigin,
      ignoreIfRange: true,
      beforeAnswer: (i) => {
        if (i === (crossOrigin ? 2 : 1)) {
          cdn.put(
            `${base}a.bin`,
            encryptAsset(key.bytes, "a.bin", replacement),
          );
        }
      },
    });
    const client = createAssetBundleClient({
      baseUrl: base,
      key: key.text,
      corsSafe: crossOrigin,
      fetch: cdn.fetch,
    });
    cdn.put(`${base}a.bin`, encryptAsset(key.bytes, "a.bin", plain));
    expect(
      await client.readRange("a.bin", { start: 70_000, end: 70_004 }),
    ).toEqual(replacement.slice(70_000, 70_004));
  });

  it("is http when the host ignores Range", async () => {
    const { client, serve } = setup({ crossOrigin, ignoreRange: true });
    serve("a.bin", plain);
    const error = await failureOf(
      client.readRange("a.bin", { start: 70_000, end: 70_004 }),
    );
    expect(error).toMatchObject({ code: "http", status: 200 });
    expect(error.message).toBe("asset http (200): the host ignores Range");
  });

  it("is not_found for a missing object", async () => {
    const { client } = setup({ crossOrigin });
    await expect(
      client.readRange("nope.bin", { start: 0, end: 4 }),
    ).rejects.toMatchObject({
      code: "not_found",
      status: 403,
    });
  });

  it("still verifies without an ETag", async () => {
    const { client, serve } = setup({ crossOrigin, noEtag: true });
    serve("a.bin", plain);
    expect(
      await client.readRange("a.bin", { start: 130_000, end: 140_000 }),
    ).toEqual(plain.slice(130_000, 140_000));
  });

  it("fails a tampered segment as asset_corrupt", async () => {
    const { client, cdn } = setup({ crossOrigin });
    const bytes = encryptAsset(key.bytes, "a.bin", plain);
    bytes[65_536 + 100]! ^= 1;
    cdn.put(`${base}a.bin`, bytes);
    // The first segment is untouched and still reads.
    expect(await client.readRange("a.bin", { start: 0, end: 10 })).toEqual(
      plain.slice(0, 10),
    );
    await expect(
      client.readRange("a.bin", { start: 70_000, end: 70_010 }),
    ).rejects.toMatchObject({
      code: "asset_corrupt",
    });
  });

  it("refuses a bad window locally and answers an empty one without a request", async () => {
    const { client, cdn } = setup({ crossOrigin });
    for (const window of [
      { start: -1 },
      { start: 1.5 },
      { start: 0, end: -1 },
      { start: Number.NaN },
    ]) {
      await expect(client.readRange("a.bin", window)).rejects.toBeInstanceOf(
        RangeError,
      );
    }
    expect(await client.readRange("a.bin", { start: 5, end: 5 })).toEqual(
      new Uint8Array(0),
    );
    expect(await client.readRange("a.bin", { start: 5, end: 2 })).toEqual(
      new Uint8Array(0),
    );
    expect(cdn.requests).toHaveLength(0);
  });
});

describe("readRange — hosts that answer oddly", () => {
  const plain = pattern(100_000);
  const ciphertext = encryptAsset(key.bytes, "a.bin", plain);

  /** A fetch that answers the header request with the given headers. */
  function oddHost(headers: Record<string, string>, status = 206) {
    const fetch: AssetFetchLike = () =>
      Promise.resolve({
        status,
        headers: { get: (n: string) => headers[n] ?? null },
        arrayBuffer: () => Promise.resolve(ciphertext.slice(0, 40).buffer),
        body: null,
      });
    return createAssetBundleClient({
      baseUrl: base,
      key: key.text,
      fetch,
      corsSafe: false,
    });
  }

  it("is http on a 206 without a numeric total length", async () => {
    const client = oddHost({ "content-range": "bytes 0-39/*" });
    await expect(
      client.readRange("a.bin", { start: 70_000 }),
    ).rejects.toMatchObject({
      code: "http",
      message: "asset http (206): no total length in Content-Range",
    });
  });

  it("is http on a range other than the one asked for", async () => {
    const client = oddHost({
      "content-range": `bytes 1-40/${ciphertext.length}`,
    });
    await expect(
      client.readRange("a.bin", { start: 70_000 }),
    ).rejects.toMatchObject({
      code: "http",
      message: "asset http (206): Content-Range is not the range asked for",
    });
  });

  it("is asset_corrupt on an empty object (416 before any length is known)", async () => {
    const client = oddHost({ "content-range": "bytes */0" }, 416);
    await expect(
      client.readRange("a.bin", { start: 70_000 }),
    ).rejects.toMatchObject({
      code: "asset_corrupt",
      status: 416,
    });
  });

  it("is http in the browser when HEAD states no length", async () => {
    const fetch: AssetFetchLike = () =>
      Promise.resolve({
        status: 200,
        headers: { get: () => null },
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
        body: null,
      });
    const client = createAssetBundleClient({
      baseUrl: base,
      key: key.text,
      fetch,
      corsSafe: true,
    });
    await expect(client.readRange("a.bin", { start: 0 })).rejects.toMatchObject(
      {
        code: "http",
        message: "asset http (200): no usable Content-Length",
      },
    );
  });

  it("is network when a ranged body ends before the segment does", async () => {
    const fetch: AssetFetchLike = (_url, init) =>
      Promise.resolve({
        status: 206,
        headers: {
          get: (n: string) =>
            n === "content-range"
              ? `bytes 0-${init.headers.range === "bytes=0-39" ? 39 : 65_535}/${ciphertext.length}`
              : null,
        },
        arrayBuffer: () => Promise.resolve(ciphertext.slice(0, 1_000).buffer),
        body: null,
      });
    const client = createAssetBundleClient({
      baseUrl: base,
      key: key.text,
      fetch,
      corsSafe: false,
    });
    await expect(
      client.readRange("a.bin", { start: 0, end: 10 }),
    ).rejects.toMatchObject({
      code: "network",
      message: "asset network (206): the body ended early",
    });
  });
});

describe.each(modes)("download — $name", ({ crossOrigin }) => {
  it.each(lengths)(
    "streams a %i-byte file segment by segment",
    async (length) => {
      const { client, serve } = setup({ crossOrigin });
      const plain = pattern(length);
      const etag = serve("a.bin", plain);
      const memory = createMemorySink();
      const progress: number[] = [];
      const result = await client.download("a.bin", {
        sink: memory.sink,
        onProgress: (p) => {
          expect(p.total).toBe(length);
          expect(p.etag).toBe(etag);
          progress.push(p.written);
        },
      });
      expect(result).toEqual({ bytes: length, etag });
      expect(memory.bytes()).toEqual(plain);
      expect(memory.events).not.toContain("reset");
      expect(progress.at(-1)).toBe(length);
      // One write per segment: nothing is released before its tag verified.
      expect(memory.events.filter((e) => e.startsWith("write")).length).toBe(
        length === 0 ? 0 : 1 + Math.ceil(Math.max(length - 65_464, 0) / 65_504),
      );
    },
  );

  it("downloads from the start in one ranged GET", async () => {
    const { client, serve, cdn } = setup({ crossOrigin });
    serve("a.bin", pattern(200_000));
    await client.download("a.bin", { sink: createMemorySink().sink });
    const wire = cdn.requests.map(
      (r) => `${r.method} ${r.headers.range ?? ""}`,
    );
    // Node reads the length from Content-Range; a browser asks HEAD first.
    expect(wire).toEqual(
      crossOrigin ? ["HEAD ", "GET bytes=0-200167"] : ["GET bytes=0-"],
    );
  });

  it("resumes from the segment holding the offset, and re-fetches at most one", async () => {
    const { client, serve, cdn } = setup({ crossOrigin });
    const plain = pattern(200_000);
    const etag = serve("a.bin", plain);
    const memory = createMemorySink();
    memory.seed(plain.slice(0, 100_000));
    const result = await client.download("a.bin", {
      sink: memory.sink,
      resume: { offset: 100_000, etag },
    });
    expect(result).toEqual({ bytes: 200_000, etag });
    expect(memory.bytes()).toEqual(plain);
    expect(memory.events).not.toContain("reset");
    const ranges = cdn.requests
      .filter((r) => r.method === "GET")
      .map((r) => r.headers.range);
    // 200,000 bytes of plaintext are 200,168 of ciphertext.
    expect(ranges).toEqual(["bytes=0-39", "bytes=65536-200167"]);
    if (!crossOrigin) expect(cdn.requests[0]!.headers["if-range"]).toBe(etag);
  });

  it("resumes a download that stopped inside the first segment", async () => {
    const { client, serve } = setup({ crossOrigin });
    const plain = pattern(100_000);
    const etag = serve("a.bin", plain);
    const memory = createMemorySink();
    memory.seed(plain.slice(0, 1_000));
    await client.download("a.bin", {
      sink: memory.sink,
      resume: { offset: 1_000, etag },
    });
    expect(memory.bytes()).toEqual(plain);
  });

  it("starts over, resetting the sink, when the object is not the one resumed", async () => {
    const { client, serve } = setup({ crossOrigin });
    const plain = pattern(150_000);
    const etag = serve("a.bin", plain);
    const memory = createMemorySink();
    memory.seed(pattern(100_000, 5)); // bytes of an older version
    const result = await client.download("a.bin", {
      sink: memory.sink,
      resume: { offset: 100_000, etag: '"an-older-etag"' },
    });
    expect(result).toEqual({ bytes: 150_000, etag });
    expect(memory.events[0]).toBe("reset");
    expect(memory.bytes()).toEqual(plain);
  });

  it("starts over when the object changes mid-download", async () => {
    const plain = pattern(200_000);
    const replacement = pattern(180_000, 77);
    const cdn = createFakeCdn({
      crossOrigin,
      beforeAnswer: (i) => {
        if (i === (crossOrigin ? 2 : 1)) {
          cdn.put(
            `${base}a.bin`,
            encryptAsset(key.bytes, "a.bin", replacement),
          );
        }
      },
    });
    const client = createAssetBundleClient({
      baseUrl: base,
      key: key.text,
      corsSafe: crossOrigin,
      fetch: cdn.fetch,
    });
    const etag = cdn.put(
      `${base}a.bin`,
      encryptAsset(key.bytes, "a.bin", plain),
    );
    const memory = createMemorySink();
    memory.seed(plain.slice(0, 70_000));
    await client.download("a.bin", {
      sink: memory.sink,
      resume: { offset: 70_000, etag },
    });
    expect(memory.events[0]).toBe("reset");
    expect(memory.bytes()).toEqual(replacement);
  });

  it("verifies only the last segment when the resumed download was already complete", async () => {
    const { client, serve, cdn } = setup({ crossOrigin });
    const plain = pattern(100_000);
    const etag = serve("a.bin", plain);
    const memory = createMemorySink();
    memory.seed(plain);
    const progress: number[] = [];
    const result = await client.download("a.bin", {
      sink: memory.sink,
      resume: { offset: 100_000, etag },
      onProgress: (p) => progress.push(p.written),
    });
    expect(result).toEqual({ bytes: 100_000, etag });
    expect(progress).toEqual([100_000]);
    expect(memory.events).toEqual([]);
    // 100,000 bytes are 100,104 of ciphertext; the last segment starts at 65,536.
    expect(
      cdn.requests
        .filter((r) => r.method === "GET")
        .map((r) => r.headers.range),
    ).toEqual(["bytes=0-39", "bytes=65536-100103"]);
  });

  it("refuses a resume offset past the end, and a malformed resume", async () => {
    const { client, serve } = setup({ crossOrigin });
    const etag = serve("a.bin", pattern(10));
    const memory = createMemorySink();
    await expect(
      client.download("a.bin", {
        sink: memory.sink,
        resume: { offset: 11, etag },
      }),
    ).rejects.toThrow("asset resume offset is past the end of the file");
    await expect(
      client.download("a.bin", {
        sink: memory.sink,
        resume: { offset: -1, etag },
      }),
    ).rejects.toBeInstanceOf(RangeError);
    await expect(
      client.download("a.bin", {
        sink: memory.sink,
        resume: { offset: 1, etag: "" },
      }),
    ).rejects.toBeInstanceOf(RangeError);
  });

  it("writes nothing of a segment whose tag fails", async () => {
    const { client, cdn } = setup({ crossOrigin });
    const plain = pattern(150_000);
    const bytes = encryptAsset(key.bytes, "a.bin", plain);
    bytes[65_536 + 10]! ^= 1;
    cdn.put(`${base}a.bin`, bytes);
    const memory = createMemorySink();
    await expect(
      client.download("a.bin", { sink: memory.sink }),
    ).rejects.toMatchObject({
      code: "asset_corrupt",
    });
    // Segment 0 verified and was written; segment 1 never reached the sink.
    expect(memory.bytes()).toEqual(plain.slice(0, 65_464));
  });

  it("lets a sink's own failure through unchanged", async () => {
    const { client, serve } = setup({ crossOrigin });
    serve("a.bin", pattern(10));
    const failure = new Error("disk full");
    await expect(
      client.download("a.bin", {
        sink: { write: () => Promise.reject(failure), reset: () => undefined },
      }),
    ).rejects.toBe(failure);
  });
});

describe("a plain bundle", () => {
  function plainSetup(options: FakeCdnOptions = {}) {
    const cdn = createFakeCdn(options);
    const client = createAssetBundleClient({
      baseUrl: base,
      corsSafe: options.crossOrigin ?? false,
      fetch: cdn.fetch,
    });
    return { cdn, client };
  }

  it("reads, reads JSON and reads ranges with the same calls and no crypto", async () => {
    const { cdn, client } = plainSetup();
    const data = pattern(5_000);
    cdn.put(`${base}a.bin`, data);
    cdn.put(`${base}m.json`, new TextEncoder().encode('{"a":1}'));
    expect(await client.read("a.bin")).toEqual(data);
    expect(await client.readJson("m.json")).toEqual({ a: 1 });
    expect(await client.readRange("a.bin", { start: 10, end: 20 })).toEqual(
      data.slice(10, 20),
    );
    expect(await client.readRange("a.bin", { start: 4_990 })).toEqual(
      data.slice(4_990),
    );
    expect(await client.readRange("a.bin", { start: 9_000 })).toEqual(
      new Uint8Array(0),
    );
    await expect(client.readJson("a.bin")).rejects.toMatchObject({
      code: "asset_corrupt",
    });
    expect(cdn.requests.map((r) => r.headers.range)).toEqual([
      undefined,
      undefined,
      "bytes=10-19",
      "bytes=4990-",
      "bytes=9000-",
      undefined,
    ]);
  });

  it("slices the whole file when the host ignores Range", async () => {
    const { cdn, client } = plainSetup({ ignoreRange: true });
    const data = pattern(5_000);
    cdn.put(`${base}a.bin`, data);
    expect(await client.readRange("a.bin", { start: 10, end: 20 })).toEqual(
      data.slice(10, 20),
    );
  });

  it("reads a range in the browser without Content-Range", async () => {
    const { cdn, client } = plainSetup({ crossOrigin: true });
    const data = pattern(5_000);
    cdn.put(`${base}a.bin`, data);
    expect(await client.readRange("a.bin", { start: 10, end: 20 })).toEqual(
      data.slice(10, 20),
    );
    expect(cdn.requests.map((r) => r.method)).toEqual(["GET"]);
  });

  it("is http on a 206 whose range is not the one asked for, or unstated outside a browser", async () => {
    const answerWith = (contentRange: string | null) =>
      createAssetBundleClient({
        baseUrl: base,
        corsSafe: false,
        fetch: () =>
          Promise.resolve({
            status: 206,
            headers: {
              get: (n: string) => (n === "content-range" ? contentRange : null),
            },
            arrayBuffer: () => Promise.resolve(new ArrayBuffer(4)),
            body: null,
          }),
      });
    await expect(
      answerWith("bytes 0-3/100").readRange("a", { start: 10 }),
    ).rejects.toMatchObject({
      code: "http",
      status: 206,
    });
    await expect(
      answerWith(null).readRange("a", { start: 10 }),
    ).rejects.toMatchObject({
      code: "http",
      message: "asset http (206): no Content-Range",
    });
  });

  it.each(modes)("downloads and resumes — $name", async ({ crossOrigin }) => {
    const { cdn, client } = plainSetup({ crossOrigin });
    const data = pattern(50_000);
    const etag = cdn.put(`${base}a.bin`, data);
    const fresh = createMemorySink();
    const totals: (number | undefined)[] = [];
    expect(
      await client.download("a.bin", {
        sink: fresh.sink,
        onProgress: (p) => totals.push(p.total),
      }),
    ).toEqual({ bytes: 50_000, etag });
    expect(fresh.bytes()).toEqual(data);
    // A browser cannot see Content-Encoding, so it never trusts a 200's length.
    expect(new Set(totals)).toEqual(
      new Set([crossOrigin ? undefined : 50_000]),
    );

    const resumed = createMemorySink();
    resumed.seed(data.slice(0, 20_000));
    cdn.requests.length = 0;
    await client.download("a.bin", {
      sink: resumed.sink,
      resume: { offset: 20_000, etag },
    });
    expect(resumed.bytes()).toEqual(data);
    expect(resumed.events).not.toContain("reset");
    expect(cdn.requests[0]!.headers).toEqual(
      crossOrigin
        ? { range: "bytes=20000-" }
        : { range: "bytes=20000-", "if-range": etag },
    );
  });

  it.each(modes)(
    "starts over from a changed object — $name",
    async ({ crossOrigin }) => {
      const { cdn, client } = plainSetup({ crossOrigin });
      const data = pattern(50_000, 3);
      const etag = cdn.put(`${base}a.bin`, data);
      const memory = createMemorySink();
      memory.seed(pattern(20_000, 9));
      await client.download("a.bin", {
        sink: memory.sink,
        resume: { offset: 20_000, etag: '"stale"' },
      });
      expect(memory.events[0]).toBe("reset");
      expect(memory.bytes()).toEqual(data);
      void etag;
    },
  );

  it.each(modes)(
    "finishes a complete resume, or starts over when it cannot tell (416) — $name",
    async ({ crossOrigin }) => {
      const { cdn, client } = plainSetup({ crossOrigin });
      const data = pattern(1_000);
      const etag = cdn.put(`${base}a.bin`, data);
      const memory = createMemorySink();
      memory.seed(data);
      await client.download("a.bin", {
        sink: memory.sink,
        resume: { offset: 1_000, etag },
      });
      // Node reads `bytes */1000` under a matching If-Range; a browser sees neither.
      expect(memory.events[0]).toBe(crossOrigin ? "reset" : undefined);
      expect(memory.bytes()).toEqual(data);
    },
  );

  it("is network when the body is shorter than its stated length", async () => {
    const client = createAssetBundleClient({
      baseUrl: base,
      corsSafe: false,
      fetch: () =>
        Promise.resolve({
          status: 200,
          headers: {
            get: (n: string) => (n === "content-length" ? "10" : null),
          },
          arrayBuffer: () => Promise.resolve(new ArrayBuffer(4)),
          body: null,
        }),
    });
    const memory = createMemorySink();
    await expect(
      client.download("a", { sink: memory.sink }),
    ).rejects.toMatchObject({
      code: "network",
    });
  });

  it("reports no total for a compressed body", async () => {
    const client = createAssetBundleClient({
      baseUrl: base,
      corsSafe: false,
      fetch: () =>
        Promise.resolve({
          status: 200,
          headers: {
            get: (n: string) =>
              n === "content-length"
                ? "3"
                : n === "content-encoding"
                  ? "gzip"
                  : null,
          },
          arrayBuffer: () => Promise.resolve(new Uint8Array(10).buffer),
          body: null,
        }),
    });
    const memory = createMemorySink();
    const totals: (number | undefined)[] = [];
    expect(
      await client.download("a", {
        sink: memory.sink,
        onProgress: (p) => totals.push(p.total),
      }),
    ).toEqual({ bytes: 10 });
    expect(totals).toEqual([undefined]);
  });
});

describe("secrecy", () => {
  it("never puts the key, the plaintext or a URL with a key in a log line or an error", async () => {
    const { logger, lines } = capturingLogger();
    const cdn = createFakeCdn();
    const secretText = "PLAINTEXT-GOLF-8c4";
    cdn.put(
      `${base}a.json`,
      encryptAsset(key.bytes, "a.json", new TextEncoder().encode(secretText)),
    );
    cdn.put(`${base}b.bin`, encryptAsset(otherKey.bytes, "b.bin", pattern(10)));
    const client: AssetBundleClient = createAssetBundleClient({
      baseUrl: base,
      key: key.text,
      corsSafe: false,
      fetch: cdn.fetch,
      logger,
    });
    const errors = [
      await failureOf(client.readJson("a.json")),
      await failureOf(client.read("b.bin")),
      await failureOf(client.read("missing.bin")),
    ];
    const offline = createAssetBundleClient({
      baseUrl: base,
      key: key.text,
      fetch: () => Promise.reject(new TypeError("fetch failed")),
      logger,
    });
    errors.push(await failureOf(offline.read("a.json")));

    // Positive control: the requests were logged, by kind and status.
    expect(
      lines.some(
        (l) => l.includes('"kind":"whole"') && l.includes('"status":200'),
      ),
    ).toBe(true);
    expect(lines.some((l) => l.includes("asset request failed"))).toBe(true);

    const haystack = [
      ...lines,
      ...errors.map((e) => inspect(e, { depth: 5 })),
      JSON.stringify(client),
      inspect(client, { depth: 5 }),
    ].join("\n");
    const keyBody = key.text.slice(5);
    for (const secret of [
      key.text,
      keyBody,
      keyBody.slice(0, 14),
      keyBody.slice(14, 28),
      keyBody.slice(28),
      Buffer.from(key.bytes).toString("hex"),
      secretText,
    ]) {
      expect(haystack).not.toContain(secret);
    }
    expect(errors.map((e) => e.message)).toEqual([
      "asset asset_corrupt (0)",
      "asset asset_corrupt (0)",
      "asset not_found (403)",
      "asset network (0)",
    ]);
  });

  it("isAssetClientError accepts a cross-realm shape and rejects others", () => {
    expect(isAssetClientError(new Error("x"))).toBe(false);
    expect(isAssetClientError(undefined)).toBe(false);
    expect(
      isAssetClientError({
        name: "AssetClientError",
        status: 403,
        code: "not_found",
      }),
    ).toBe(true);
  });
});

describe("review regressions", () => {
  const plain = pattern(200_000);

  it.each(modes)(
    "an empty window still verifies the last segment — $name",
    async ({ crossOrigin }) => {
      const good = encryptAsset(key.bytes, "a.bin", plain);
      const cases: [string, Uint8Array][] = [
        ["truncated to one segment", good.slice(0, 65_536)],
        ["the wrong key", encryptAsset(otherKey.bytes, "a.bin", plain)],
        ["the wrong path", encryptAsset(key.bytes, "b.bin", plain)],
      ];
      for (const [name, bytes] of cases) {
        const { client, cdn } = setup({ crossOrigin });
        const etag = cdn.put(`${base}a.bin`, bytes);
        // Past the end of whatever length the host states.
        await expect(
          client.readRange("a.bin", { start: 300_000, end: 300_010 }),
          name,
        ).rejects.toMatchObject({ code: "asset_corrupt" });
        const memory = createMemorySink();
        await expect(
          client.download("a.bin", {
            sink: memory.sink,
            resume: { offset: 65_464, etag },
          }),
          name,
        ).rejects.toMatchObject({ code: "asset_corrupt" });
        expect(cdn.openBodies(), name).toBe(0);
      }
    },
  );

  it.each(modes)(
    "fails every tampering through a window that skips byte 0 — $name",
    async ({ crossOrigin }) => {
      const good = encryptAsset(key.bytes, "a.bin", plain);
      const flip = (at: number) => {
        const copy = good.slice();
        copy[at]! ^= 1;
        return copy;
      };
      const cases: [string, Uint8Array][] = [
        ["a flipped salt byte", flip(5)],
        ["a flipped tag byte", flip(131_071)],
        ["truncated inside the last segment", good.slice(0, -1)],
        ["appended bytes", new Uint8Array([...good, 0])],
        [
          "two segments swapped",
          new Uint8Array([
            ...good.slice(0, 65_536),
            ...good.slice(131_072, 196_608),
            ...good.slice(65_536, 131_072),
            ...good.slice(196_608),
          ]),
        ],
      ];
      for (const [name, bytes] of cases) {
        const { client, cdn } = setup({ crossOrigin });
        cdn.put(`${base}a.bin`, bytes);
        await expect(
          client.readRange("a.bin", { start: 70_000 }),
          name,
        ).rejects.toMatchObject({ code: "asset_corrupt" });
        const memory = createMemorySink();
        await expect(
          client.download("a.bin", { sink: memory.sink }),
          name,
        ).rejects.toMatchObject({ code: "asset_corrupt" });
        expect(cdn.openBodies(), name).toBe(0);
      }
    },
  );

  it("does not splice a resume onto an object that names no ETag", async () => {
    // A weak resume ETag cannot go into If-Range, and this host sends none.
    const { client, serve, cdn } = setup({ noEtag: true });
    serve("a.bin", plain);
    const memory = createMemorySink();
    memory.seed(pattern(100_000, 5));
    const result = await client.download("a.bin", {
      sink: memory.sink,
      resume: { offset: 100_000, etag: 'W/"old"' },
    });
    expect(memory.events[0]).toBe("reset");
    expect(memory.bytes()).toEqual(plain);
    expect(result).toEqual({ bytes: 200_000 });
    expect(cdn.openBodies()).toBe(0);
  });

  it("does not splice a plain resume onto an object that names no ETag", async () => {
    const cdn = createFakeCdn({ noEtag: true });
    const client = createAssetBundleClient({
      baseUrl: base,
      corsSafe: false,
      fetch: cdn.fetch,
    });
    const data = pattern(50_000, 3);
    cdn.put(`${base}a.bin`, data);
    const memory = createMemorySink();
    memory.seed(pattern(20_000, 9));
    await client.download("a.bin", {
      sink: memory.sink,
      resume: { offset: 20_000, etag: 'W/"old"' },
    });
    expect(memory.events[0]).toBe("reset");
    expect(memory.bytes()).toEqual(data);
  });

  it.each(modes)(
    "releases the connection on every refusal and every sink failure — $name",
    async ({ crossOrigin }) => {
      const ignoring = setup({ crossOrigin, ignoreRange: true });
      ignoring.serve("a.bin", plain);
      await expect(
        ignoring.client.readRange("a.bin", { start: 70_000 }),
      ).rejects.toMatchObject({ code: "http" });
      await expect(
        ignoring.client.download("a.bin", { sink: createMemorySink().sink }),
      ).rejects.toMatchObject({ code: "http" });
      expect(ignoring.cdn.openBodies()).toBe(0);

      const failure = new Error("disk full");
      const failing = {
        write: () => Promise.reject(failure),
        reset: () => undefined,
      };
      const keyed = setup({ crossOrigin });
      keyed.serve("a.bin", plain);
      await expect(
        keyed.client.download("a.bin", { sink: failing }),
      ).rejects.toBe(failure);
      expect(keyed.cdn.openBodies()).toBe(0);

      const cdn = createFakeCdn({ crossOrigin });
      cdn.put(`${base}a.bin`, plain);
      const bare = createAssetBundleClient({
        baseUrl: base,
        corsSafe: crossOrigin,
        fetch: cdn.fetch,
      });
      await expect(bare.download("a.bin", { sink: failing })).rejects.toBe(
        failure,
      );
      await expect(
        bare.download("a.bin", {
          sink: createMemorySink().sink,
          onProgress: () => {
            throw failure;
          },
        }),
      ).rejects.toBe(failure);
      await expect(bare.read("missing")).rejects.toMatchObject({
        code: "not_found",
      });
      expect(cdn.openBodies()).toBe(0);
    },
  );

  it("falls back to a whole-file GET when a browser refuses Range", async () => {
    const { logger, lines } = capturingLogger();
    const { client, serve, cdn } = setup({ crossOrigin: true }, { logger });
    const etag = serve("a.bin", plain);
    cdn.refuseRange();
    expect(
      await client.readRange("a.bin", { start: 70_000, end: 140_000 }),
    ).toEqual(plain.slice(70_000, 140_000));
    const memory = createMemorySink();
    memory.seed(plain.slice(0, 100_000));
    await client.download("a.bin", {
      sink: memory.sink,
      resume: { offset: 100_000, etag },
    });
    expect(memory.bytes()).toEqual(plain);
    expect(memory.events).not.toContain("reset");
    expect(
      lines.filter((l) => l.includes("asset ranged request refused")),
    ).toHaveLength(2);
    expect(cdn.openBodies()).toBe(0);

    // A plain bundle does the same, for a range and for a resume.
    const bare = createAssetBundleClient({
      baseUrl: base,
      corsSafe: true,
      fetch: cdn.fetch,
    });
    const plainEtag = cdn.put(`${base}p.bin`, plain);
    expect(await bare.readRange("p.bin", { start: 10, end: 20 })).toEqual(
      plain.slice(10, 20),
    );
    const resumed = createMemorySink();
    resumed.seed(plain.slice(0, 1_000));
    await bare.download("p.bin", {
      sink: resumed.sink,
      resume: { offset: 1_000, etag: plainEtag },
    });
    expect(resumed.bytes()).toEqual(plain);
    expect(cdn.openBodies()).toBe(0);
  });

  it("does not fall back outside a browser", async () => {
    const { client, serve, cdn } = setup();
    serve("a.bin", plain);
    cdn.refuseRange();
    await expect(
      client.readRange("a.bin", { start: 70_000 }),
    ).rejects.toMatchObject({ code: "network", status: 0 });
  });

  it("stops a read in flight when the client closes", async () => {
    const { client, serve } = setup();
    serve("a.bin", plain);
    const memory = createMemorySink();
    await expect(
      client.download("a.bin", {
        sink: {
          write(chunk) {
            memory.sink.write(chunk);
            client.close();
          },
          reset: () => memory.sink.reset(),
        },
      }),
    ).rejects.toThrow("asset client is closed");
    // The first segment was written; nothing after the close.
    expect(memory.bytes()).toEqual(plain.slice(0, 65_464));
  });

  it("refuses a spoofed key object and reports a key WebCrypto refuses as bad_key", async () => {
    const spoof = { [Symbol.toStringTag]: "Uint8Array", length: 32 };
    expect(() =>
      createAssetBundleClient({
        baseUrl: base,
        key: spoof as unknown as Uint8Array,
      }),
    ).toThrow(expect.objectContaining({ code: "bad_key" }) as Error);

    const cdn = createFakeCdn();
    cdn.put(`${base}a.bin`, encryptAsset(key.bytes, "a.bin", pattern(10)));
    const saved = Object.getOwnPropertyDescriptor(globalThis, "crypto")!;
    const secret = new Error("KEY-MATERIAL-HOTEL-1d7");
    Object.defineProperty(globalThis, "crypto", {
      value: { subtle: { importKey: () => Promise.reject(secret) } },
      configurable: true,
    });
    let client: AssetBundleClient;
    try {
      client = createAssetBundleClient({
        baseUrl: base,
        key: key.text,
        corsSafe: false,
        fetch: cdn.fetch,
      });
    } finally {
      Object.defineProperty(globalThis, "crypto", saved);
    }
    const error = await failureOf(client.read("a.bin"));
    expect(error).toMatchObject({ code: "bad_key" });
    expect(inspect(error, { depth: 5 })).not.toContain("HOTEL");
  });

  it("refuses a path with a lone surrogate as a RangeError", async () => {
    const { client } = setup();
    for (const path of ["a\uD800", "\uDC00b", "a/\uD800/b"]) {
      await expect(client.read(path)).rejects.toBeInstanceOf(RangeError);
    }
    // A well-formed pair is an ordinary character.
    await expect(client.read("a😀")).rejects.toMatchObject({
      code: "not_found",
    });
  });

  it("checks a plain 206 against the range it asked for", async () => {
    const answerWith = (contentRange: string, bytes: number) =>
      createAssetBundleClient({
        baseUrl: base,
        corsSafe: false,
        fetch: () =>
          Promise.resolve({
            status: 206,
            headers: {
              get: (n: string) => (n === "content-range" ? contentRange : null),
            },
            arrayBuffer: () => Promise.resolve(new ArrayBuffer(bytes)),
            body: null,
          }),
      });
    await expect(
      answerWith("bytes 10-15/100", 6).readRange("a", { start: 10, end: 20 }),
    ).rejects.toMatchObject({
      code: "http",
      message: "asset http (206): Content-Range is not the range asked for",
    });
    await expect(
      answerWith("bytes 10-19/100", 4).readRange("a", { start: 10, end: 20 }),
    ).rejects.toMatchObject({
      code: "network",
      message: "asset network (206): the body ended early",
    });
    expect(
      await answerWith("bytes 95-99/100", 5).readRange("a", {
        start: 95,
        end: 200,
      }),
    ).toHaveLength(5);
  });

  it("is network when a plain body runs past its stated length", async () => {
    const client = createAssetBundleClient({
      baseUrl: base,
      corsSafe: false,
      fetch: () =>
        Promise.resolve({
          status: 200,
          headers: {
            get: (n: string) => (n === "content-length" ? "4" : null),
          },
          arrayBuffer: () => Promise.resolve(new ArrayBuffer(10)),
          body: null,
        }),
    });
    const memory = createMemorySink();
    await expect(
      client.download("a", { sink: memory.sink }),
    ).rejects.toMatchObject({
      message: "asset network (200): the body ran past its stated length",
    });
    expect(memory.bytes()).toHaveLength(0);
  });

  it("reports progress once for an empty plain file", async () => {
    const cdn = createFakeCdn();
    cdn.put(`${base}e.bin`, new Uint8Array(0));
    const client = createAssetBundleClient({
      baseUrl: base,
      corsSafe: false,
      fetch: cdn.fetch,
    });
    const progress: unknown[] = [];
    await client.download("e.bin", {
      sink: createMemorySink().sink,
      onProgress: (p) => progress.push(p),
    });
    expect(progress).toEqual([{ written: 0, total: 0, etag: '"etag-1"' }]);
  });
});

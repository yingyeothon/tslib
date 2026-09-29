import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createAssetBundleClient, isAssetClientError } from "../src/index.js";
import { encryptAsset } from "./encrypt.js";
import { createFakeCdn, createMemorySink } from "./fake-cdn.js";

/**
 * The `yyt-enc v1` conformance vectors, copied verbatim from the service
 * repository's `docs/asset-encryption-vectors.json` at commit f6c418a
 * (2026-09-28). Every decryptor — the Go CLI, the console's node:crypto check,
 * tink-go, and the three client libraries — must accept every positive case
 * and refuse every negative one with `asset_corrupt`. Refresh the copy when
 * that file changes; never edit it here.
 */
interface Vectors {
  format: string;
  cases: {
    name: string;
    keyHex: string;
    key: string;
    path: string;
    plaintextUnitHex: string;
    plaintextLength: number;
    ciphertextHex: string;
  }[];
  negative: {
    name: string;
    keyHex: string;
    key: string;
    path: string;
    ciphertextHex: string;
    error: string;
  }[];
}

const vectors = JSON.parse(
  readFileSync(
    new URL("./fixtures/asset-encryption-vectors.json", import.meta.url),
    "utf8",
  ),
) as Vectors;

// A live bundle: the associated data is the path itself, `v3/…` included.
const base = "https://dev-d.yyt.life/assets/bnd_vectors/";
const view = (a: Uint8Array) =>
  Buffer.from(a.buffer, a.byteOffset, a.byteLength);
const hex = (text: string) => new Uint8Array(Buffer.from(text, "hex"));

/** `plaintextUnitHex` repeated and cut; the empty case has an empty unit. */
function plaintextOf(unitHex: string, length: number): Uint8Array {
  const out = new Uint8Array(length);
  if (length === 0) return out;
  const unit = hex(unitHex);
  for (let at = 0; at < length; at += unit.length) {
    out.set(unit.subarray(0, Math.min(unit.length, length - at)), at);
  }
  return out;
}

function served(
  key: string | Uint8Array,
  path: string,
  ciphertext: Uint8Array,
  corsSafe: boolean,
) {
  const cdn = createFakeCdn({ crossOrigin: corsSafe });
  cdn.put(base + path.split("/").map(encodeURIComponent).join("/"), ciphertext);
  return createAssetBundleClient({
    baseUrl: base,
    key,
    fetch: cdn.fetch,
    corsSafe,
  });
}

describe("yyt-enc v1 conformance vectors", () => {
  it("covers the cases the format document lists", () => {
    expect(vectors.format).toBe("yyt-enc-v1");
    expect(vectors.cases).toHaveLength(7);
    expect(vectors.negative).toHaveLength(9);
  });

  describe.each(vectors.cases)("accepts: $name", (vector) => {
    const plaintext = plaintextOf(
      vector.plaintextUnitHex,
      vector.plaintextLength,
    );
    const ciphertext = hex(vector.ciphertextHex);

    it("reads it whole, with the key as text and as bytes", async () => {
      expect(view(hex(vector.keyHex)).toString("base64url")).toBe(
        vector.key.slice(5),
      );
      for (const key of [vector.key, hex(vector.keyHex)]) {
        const bytes = await served(key, vector.path, ciphertext, false).read(
          vector.path,
        );
        expect(view(bytes).equals(view(plaintext))).toBe(true);
      }
    });

    it("is reproduced byte for byte by the tests' own encryptor", () => {
      expect(
        view(encryptAsset(hex(vector.keyHex), vector.path, plaintext)).toString(
          "hex",
        ),
      ).toBe(vector.ciphertextHex);
    });

    it.each([false, true])(
      "reads every range across its segment boundaries (corsSafe %s)",
      async (corsSafe) => {
        const client = served(vector.key, vector.path, ciphertext, corsSafe);
        const n = vector.plaintextLength;
        const cuts = [
          0,
          1,
          65_463,
          65_464,
          65_465,
          130_967,
          130_968,
          130_969,
          n - 1,
          n,
        ].filter((c) => c >= 0 && c <= n);
        for (const start of cuts) {
          for (const end of cuts) {
            if (end <= start) continue;
            const bytes = await client.readRange(vector.path, { start, end });
            expect(
              view(bytes).equals(view(plaintext.subarray(start, end))),
              `${start}-${end}`,
            ).toBe(true);
          }
        }
        const tail = await client.readRange(vector.path, { start: 0 });
        expect(view(tail).equals(view(plaintext))).toBe(true);
      },
    );

    it.each([false, true])("downloads it (corsSafe %s)", async (corsSafe) => {
      const memory = createMemorySink();
      const result = await served(
        vector.key,
        vector.path,
        ciphertext,
        corsSafe,
      ).download(vector.path, { sink: memory.sink });
      expect(result.bytes).toBe(vector.plaintextLength);
      expect(view(memory.bytes()).equals(view(plaintext))).toBe(true);
    });
  });

  describe.each(vectors.negative)("refuses: $name", (vector) => {
    const ciphertext = hex(vector.ciphertextHex);

    it.each([false, true])(
      "as asset_corrupt on every read (corsSafe %s)",
      async (corsSafe) => {
        expect(vector.error).toBe("asset_corrupt");
        const client = served(vector.key, vector.path, ciphertext, corsSafe);
        const memory = createMemorySink();
        // Thunks, so each read starts only when awaited: an eager array
        // leaves the later rejections unhandled while the first is awaited.
        for (const attempt of [
          () => client.read(vector.path),
          () => client.readRange(vector.path, { start: 0 }),
          () => client.download(vector.path, { sink: memory.sink }),
        ]) {
          const error = await attempt().then(
            () => undefined,
            (e: unknown) => e,
          );
          expect(isAssetClientError(error)).toBe(true);
          expect(error).toMatchObject({ code: "asset_corrupt" });
        }
      },
    );
  });
});

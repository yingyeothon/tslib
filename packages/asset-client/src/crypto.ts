import { corrupt, createAssetClientError } from "./errors.js";
import {
  headerByte,
  headerLength,
  noncePrefixLength,
  plaintextLengthOf,
  saltLength,
  segmentExtent,
  segmentIv,
  segmentsOf,
  tagLength,
} from "./format.js";

/** An opaque WebCrypto `CryptoKey`; never extractable. */
type OpaqueKey = object;

/**
 * The part of WebCrypto's `SubtleCrypto` the decryptor uses, typed here so
 * the public `.d.ts` references neither the DOM lib nor Node's `webcrypto`.
 */
interface SubtleLike {
  importKey(
    format: "raw",
    keyData: Uint8Array,
    algorithm: unknown,
    extractable: boolean,
    usages: string[],
  ): Promise<OpaqueKey>;
  deriveBits(
    algorithm: unknown,
    key: OpaqueKey,
    length: number,
  ): Promise<ArrayBuffer>;
  verify(
    algorithm: unknown,
    key: OpaqueKey,
    signature: Uint8Array,
    data: Uint8Array,
  ): Promise<boolean>;
  decrypt(
    algorithm: unknown,
    key: OpaqueKey,
    data: Uint8Array,
  ): Promise<ArrayBuffer>;
}

/** One file's verified view: its segment count and each segment's plaintext. */
export interface Decryptor {
  readonly total: number;
  readonly segments: number;
  readonly plaintextLength: number;
  /**
   * Verifies segment `i` — exactly the ciphertext bytes of its extent, tag
   * included — and only then decrypts it. A mismatch is `asset_corrupt`.
   */
  open(i: number, segment: Uint8Array): Promise<Uint8Array>;
}

export interface BundleCrypto {
  /**
   * Checks the header byte and the total length and derives the segment
   * keys. Never recomputes the plaintext digest: a decryptor cannot tell a
   * derived salt from a random one and does not need to.
   */
  openDecryptor(
    header: Uint8Array,
    total: number,
    ad: string,
  ): Promise<Decryptor>;
  /** Drops the key; any later `openDecryptor` rejects. */
  close(): void;
}

export function resolveSubtle(): SubtleLike {
  const subtle = (globalThis as { crypto?: { subtle?: SubtleLike } }).crypto
    ?.subtle;
  if (subtle === undefined) {
    // A browser hides WebCrypto outside a secure context (plain http).
    throw new Error(
      "WebCrypto is unavailable (crypto.subtle); an encrypted bundle needs a secure context or Node >= 20",
    );
  }
  return subtle;
}

const encoder = new TextEncoder();

/**
 * Imports the bundle key as a non-extractable HKDF key and zeroes `raw` as
 * soon as the import settles, so the only copy left is inside WebCrypto.
 */
export function createBundleCrypto(
  subtle: SubtleLike,
  raw: Uint8Array<ArrayBuffer>,
): BundleCrypto {
  let master: Promise<OpaqueKey> | undefined = subtle
    .importKey("raw", raw, "HKDF", false, ["deriveBits"])
    // WebCrypto's own rejection is not quoted: the error stays in the
    // client's vocabulary and carries nothing about the key.
    .catch(() => Promise.reject(createAssetClientError({ code: "bad_key" })))
    .finally(() => raw.fill(0));
  // Surfaced by the first read instead; never an unhandled rejection.
  master.catch(() => undefined);

  return {
    async openDecryptor(header, total, ad) {
      if (master === undefined) throw new Error("asset client is closed");
      const segments = segmentsOf(total);
      if (
        segments === undefined ||
        header.length !== headerLength ||
        header[0] !== headerByte
      ) {
        throw corrupt();
      }
      const salt = header.slice(1, 1 + saltLength);
      const noncePrefix = header.slice(
        1 + saltLength,
        1 + saltLength + noncePrefixLength,
      );
      const bits = new Uint8Array(
        await subtle.deriveBits(
          { name: "HKDF", hash: "SHA-256", salt, info: encoder.encode(ad) },
          await master,
          512,
        ),
      );
      let encKey: OpaqueKey;
      let macKey: OpaqueKey;
      try {
        encKey = await subtle.importKey(
          "raw",
          bits.subarray(0, 32),
          { name: "AES-CTR" },
          false,
          ["decrypt"],
        );
        macKey = await subtle.importKey(
          "raw",
          bits.subarray(32, 64),
          { name: "HMAC", hash: "SHA-256" },
          false,
          ["verify"],
        );
      } finally {
        bits.fill(0);
      }
      return {
        total,
        segments,
        plaintextLength: plaintextLengthOf(total, segments),
        async open(i, segment) {
          // A read already in flight when the client closed stops at its
          // next segment instead of decrypting on with the derived keys.
          if (master === undefined) throw new Error("asset client is closed");
          const { start, end } = segmentExtent(i, total);
          if (
            !Number.isSafeInteger(i) ||
            i < 0 ||
            i >= segments ||
            segment.length !== end - start
          ) {
            throw corrupt();
          }
          const iv = segmentIv(noncePrefix, i, i === segments - 1);
          const body = segment.subarray(0, segment.length - tagLength);
          const tag = segment.subarray(segment.length - tagLength);
          const signed = new Uint8Array(iv.length + body.length);
          signed.set(iv, 0);
          signed.set(body, iv.length);
          // WebCrypto's verify compares in constant time in Node, Chromium,
          // Firefox and WebKit; nothing of the segment is decrypted first.
          if (!(await subtle.verify("HMAC", macKey, tag, signed))) {
            throw corrupt();
          }
          return new Uint8Array(
            await subtle.decrypt(
              { name: "AES-CTR", counter: iv, length: 32 },
              encKey,
              body,
            ),
          );
        },
      };
    },
    close() {
      master = undefined;
    },
  };
}

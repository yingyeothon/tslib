import { createCipheriv, createHmac, hkdfSync } from "node:crypto";

/**
 * An independent `yyt-enc v1` encryptor on node:crypto, written from
 * `docs/asset-encryption.md` in the service repository rather than from the
 * library, so the tests can make ciphertexts of any size and any path. The
 * conformance vectors (`vectors.test.ts`) are what prove it agrees with the
 * Go encryptor; this one only has to agree with itself and the spec.
 */
const firstPlain = 65_464;
const laterPlain = 65_504;

const u32be = (n: number) => {
  const out = Buffer.alloc(4);
  out.writeUInt32BE(n);
  return out;
};

export function encryptAsset(
  key: Uint8Array,
  ad: string,
  plaintext: Uint8Array,
): Uint8Array {
  const kDet = Buffer.from(
    hkdfSync("sha256", key, Buffer.alloc(0), "yyt-enc v1 det", 32),
  );
  const adBytes = Buffer.from(ad, "utf8");
  const d = createHmac("sha256", kDet)
    .update(u32be(adBytes.length))
    .update(adBytes)
    .update(plaintext)
    .digest();
  const saltPrefix = Buffer.from(
    hkdfSync("sha256", d, Buffer.alloc(0), "yyt-enc v1 header", 39),
  );
  const salt = saltPrefix.subarray(0, 32);
  const noncePrefix = saltPrefix.subarray(32);
  const km = Buffer.from(hkdfSync("sha256", key, salt, adBytes, 64));
  const kEnc = km.subarray(0, 32);
  const kMac = km.subarray(32);

  const n =
    plaintext.length <= firstPlain
      ? 1
      : 1 + Math.ceil((plaintext.length - firstPlain) / laterPlain);
  const parts: Buffer[] = [Buffer.from([0x28]), salt, noncePrefix];
  let at = 0;
  for (let i = 0; i < n; i += 1) {
    const size = i === 0 ? firstPlain : laterPlain;
    const piece = plaintext.subarray(at, Math.min(at + size, plaintext.length));
    at += piece.length;
    const iv = Buffer.concat([
      noncePrefix,
      u32be(i),
      Buffer.from([i === n - 1 ? 1 : 0]),
      Buffer.alloc(4),
    ]);
    const cipher = createCipheriv("aes-256-ctr", kEnc, iv);
    const body = Buffer.concat([cipher.update(piece), cipher.final()]);
    const tag = createHmac("sha256", kMac).update(iv).update(body).digest();
    parts.push(body, tag);
  }
  return new Uint8Array(Buffer.concat(parts));
}

/** Deterministic, non-repeating-looking bytes: `(i * 31 + seed) & 0xff`. */
export function pattern(length: number, seed = 7): Uint8Array {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i += 1)
    out[i] = (i * 31 + seed + (i >> 8)) & 0xff;
  return out;
}

/** 32 key bytes and their `yak1.` text form. */
export function testKey(fill: number): { bytes: Uint8Array; text: string } {
  const bytes = new Uint8Array(32).map((_, i) => (i * 13 + fill) & 0xff);
  return {
    bytes,
    text: `yak1.${Buffer.from(bytes).toString("base64url")}`,
  };
}

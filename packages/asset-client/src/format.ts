/**
 * The `yyt-enc v1` layout: a 40-byte header, then 64 KiB ciphertext segments
 * each ending in a 32-byte HMAC-SHA256 tag. Pure arithmetic, no IO and no
 * crypto, so every offset rule is testable on its own. The normative text is
 * `docs/asset-encryption.md` in the service repository.
 */

/** `0x28` ‖ salt (32) ‖ noncePrefix (7). */
export const headerLength = 40;
export const headerByte = 0x28;
export const saltLength = 32;
export const noncePrefixLength = 7;
/** Ciphertext segment size, tag included. */
export const segmentSize = 65_536;
export const tagLength = 32;
/** Plaintext a full first segment holds: 65,536 − 40 − 32. */
export const firstPlain = segmentSize - headerLength - tagLength;
/** Plaintext every full later segment holds: 65,536 − 32. */
export const laterPlain = segmentSize - tagLength;
/** An empty file: the header and one empty segment's tag. */
export const minCiphertext = headerLength + tagLength;
/**
 * The platform's 256 MiB file ceiling plus the format's overhead
 * (4,099 segments): 268,566,664 bytes.
 */
export const maxCiphertext =
  256 * 1024 * 1024 + headerLength + tagLength * 4099;

/**
 * The segment count a ciphertext length implies, or `undefined` when no
 * plaintext encrypts to that length (the caller reports `asset_corrupt`).
 */
export function segmentsOf(total: number): number | undefined {
  if (
    !Number.isSafeInteger(total) ||
    total < minCiphertext ||
    total > maxCiphertext
  ) {
    return undefined;
  }
  if (total <= segmentSize) return 1;
  const n = 1 + Math.ceil((total - segmentSize) / segmentSize);
  // The last segment must hold at least one plaintext byte and its tag.
  if (total - segmentSize * (n - 1) < tagLength + 1) return undefined;
  return n;
}

/** Plaintext length of a well-formed ciphertext of `total` bytes in `n` segments. */
export function plaintextLengthOf(total: number, n: number): number {
  return total - headerLength - tagLength * n;
}

/** Ciphertext offset where segment `i` starts. */
export function cipherStart(i: number): number {
  return i === 0 ? headerLength : segmentSize * i;
}

/** Plaintext offset where segment `i` starts. */
export function plainStart(i: number): number {
  return i === 0 ? 0 : firstPlain + laterPlain * (i - 1);
}

/** The segment holding plaintext offset `p`. */
export function segmentOf(p: number): number {
  return p < firstPlain ? 0 : 1 + Math.floor((p - firstPlain) / laterPlain);
}

/**
 * Ciphertext byte range `[start, end)` of segment `i` in a file of `total`
 * bytes. Without `total` it is the nominal extent of a full segment, which is
 * what a request can ask for before the length is known: a server clamps a
 * range that runs past the end.
 */
export function segmentExtent(
  i: number,
  total?: number,
): { start: number; end: number } {
  const start = cipherStart(i);
  const full = start + (i === 0 ? segmentSize - headerLength : segmentSize);
  return { start, end: total === undefined ? full : Math.min(full, total) };
}

/** `IV_i = noncePrefix ‖ u32be(i) ‖ last ‖ 0x00000000`. */
export function segmentIv(
  noncePrefix: Uint8Array,
  i: number,
  last: boolean,
): Uint8Array<ArrayBuffer> {
  const iv = new Uint8Array(16);
  iv.set(noncePrefix, 0);
  new DataView(iv.buffer).setUint32(noncePrefixLength, i, false);
  iv[noncePrefixLength + 4] = last ? 1 : 0;
  return iv;
}

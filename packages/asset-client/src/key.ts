import { createAssetClientError } from "./errors.js";

const keyPrefix = "yak1.";
const keyTextLength = 43;
const keyBytes = 32;
const alphabet =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

function encodeBase64Url(bytes: Uint8Array): string {
  let out = "";
  let i = 0;
  for (; i + 3 <= bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    out +=
      alphabet[(n >> 18) & 63]! +
      alphabet[(n >> 12) & 63]! +
      alphabet[(n >> 6) & 63]! +
      alphabet[n & 63]!;
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = bytes[i]! << 16;
    out += alphabet[(n >> 18) & 63]! + alphabet[(n >> 12) & 63]!;
  } else if (rest === 2) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8);
    out +=
      alphabet[(n >> 18) & 63]! +
      alphabet[(n >> 12) & 63]! +
      alphabet[(n >> 6) & 63]!;
  }
  return out;
}

/** Lenient on purpose: the re-encode comparison is what makes it strict. */
function decodeBase64Url(text: string): Uint8Array<ArrayBuffer> | undefined {
  const out = new Uint8Array(Math.floor((text.length * 6) / 8));
  let bits = 0;
  let value = 0;
  let at = 0;
  for (const char of text) {
    const digit = alphabet.indexOf(char);
    if (digit < 0) return undefined;
    value = ((value << 6) | digit) & 0xffffff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[at++] = (value >> bits) & 0xff;
    }
  }
  return out;
}

const badKey = () => createAssetClientError({ code: "bad_key" });

/**
 * A private copy of the 32 key bytes, from the text form (`yak1.` + 43
 * base64url characters that decode to 32 bytes and re-encode to the same
 * text) or from 32 raw bytes. Anything else is `bad_key`, and the error never
 * quotes what it was given.
 */
export function parseAssetKey(key: unknown): Uint8Array<ArrayBuffer> {
  // Not `instanceof`: bytes from another realm (a worker, an iframe) have a
  // different `Uint8Array`.
  if (
    ArrayBuffer.isView(key) &&
    Object.prototype.toString.call(key) === "[object Uint8Array]"
  ) {
    const bytes = key as Uint8Array;
    if (bytes.length !== keyBytes) throw badKey();
    return new Uint8Array(bytes);
  }
  if (
    typeof key !== "string" ||
    key.length !== keyPrefix.length + keyTextLength ||
    !key.startsWith(keyPrefix)
  ) {
    throw badKey();
  }
  const text = key.slice(keyPrefix.length);
  const raw = decodeBase64Url(text);
  if (raw === undefined || raw.length !== keyBytes) throw badKey();
  // Only 16 of the 64 characters can end a canonical 32-byte encoding; the
  // other 48 decode to the same bytes as one of them, and must not be keys.
  if (encodeBase64Url(raw) !== text) {
    raw.fill(0);
    throw badKey();
  }
  return raw;
}

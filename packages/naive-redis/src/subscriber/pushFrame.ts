const newline = "\r\n";

/** Returned by {@link parsePushFrame} when the buffer holds no whole frame. */
export const incompletePushFrame = -1;

/** A complete top-level reply read from a Redis subscriber connection. */
export type PushFrame =
  | { kind: "message"; channel: string; payload: string }
  | {
      kind: "subscription";
      event: "subscribe" | "unsubscribe";
      channel: string;
      count: number;
    }
  | { kind: "other" };

export interface PushFrameResult {
  /**
   * Characters consumed by the frame, or {@link incompletePushFrame} when
   * the buffer does not hold a whole frame yet.
   */
  consumed: number;
  frame?: PushFrame;
}

interface Read<T> {
  value: T;
  next: number;
}

/**
 * Reads one complete reply from the head of a Redis subscriber stream.
 *
 * Bulk lengths are **byte** counts while the buffer holds characters, so
 * the payload boundary is resolved by walking code points — a payload may
 * therefore contain `\r\n` or multi-byte characters without confusing the
 * framing. Payloads are assumed to be valid UTF-8 text, which is what
 * `redisPublish` writes; a bulk length that does not land on a character
 * boundary throws instead of silently desynchronizing the stream.
 *
 * `psubscribe`/`pmessage` replies parse as `{ kind: "other" }`.
 */
export function parsePushFrame(buffer: string): PushFrameResult {
  if (buffer.length === 0) {
    return { consumed: incompletePushFrame };
  }

  const header = readLine(buffer, 0);
  if (header === null) {
    return { consumed: incompletePushFrame };
  }
  if (!header.value.startsWith("*")) {
    // A simple string, error, or integer occupies a single line.
    return { consumed: header.next, frame: { kind: "other" } };
  }

  const count = Number(header.value.slice(1));
  if (!Number.isInteger(count)) {
    throw new Error(`Invalid RESP array header: ${header.value}`);
  }
  if (count < 0) {
    return { consumed: header.next, frame: { kind: "other" } };
  }

  const parts: (string | null)[] = [];
  let position = header.next;
  for (let index = 0; index < count; ++index) {
    const element =
      buffer[position] === "$"
        ? readBulk(buffer, position)
        : readInline(buffer, position);
    if (element === null) {
      return { consumed: incompletePushFrame };
    }
    parts.push(element.value);
    position = element.next;
  }
  return { consumed: position, frame: toFrame(parts) };
}

function toFrame(parts: (string | null)[]): PushFrame {
  const [kind, channel, third] = parts;
  if (typeof channel !== "string") {
    return { kind: "other" };
  }
  if (kind === "message" && typeof third === "string") {
    return { kind: "message", channel, payload: third };
  }
  if (kind === "subscribe" || kind === "unsubscribe") {
    return {
      kind: "subscription",
      event: kind,
      channel,
      count: Number(third ?? 0),
    };
  }
  return { kind: "other" };
}

function readLine(buffer: string, position: number): Read<string> | null {
  const end = buffer.indexOf(newline, position);
  if (end < 0) {
    return null;
  }
  return { value: buffer.slice(position, end), next: end + newline.length };
}

/** Reads a non-bulk element, dropping its `:`/`+`/`-` type marker. */
function readInline(buffer: string, position: number): Read<string> | null {
  const line = readLine(buffer, position);
  return line === null ? null : { value: line.value.slice(1), next: line.next };
}

function readBulk(
  buffer: string,
  position: number,
): Read<string | null> | null {
  const header = readLine(buffer, position);
  if (header === null) {
    return null;
  }
  const byteLength = Number(header.value.slice(1));
  if (!Number.isInteger(byteLength)) {
    throw new Error(`Invalid RESP bulk header: ${header.value}`);
  }
  if (byteLength < 0) {
    return { value: null, next: header.next };
  }

  const characters = charactersForBytes(buffer, header.next, byteLength);
  if (characters === incompletePushFrame) {
    return null;
  }
  const end = header.next + characters;
  if (buffer.length < end + newline.length) {
    return null;
  }
  return { value: buffer.slice(header.next, end), next: end + newline.length };
}

/**
 * How many characters starting at `start` encode exactly `byteLength`
 * UTF-8 bytes, or {@link incompletePushFrame} when the buffer is short.
 */
function charactersForBytes(
  buffer: string,
  start: number,
  byteLength: number,
): number {
  let bytes = 0;
  let index = start;
  while (index < buffer.length && bytes < byteLength) {
    const codePoint = buffer.codePointAt(index);
    if (codePoint === undefined) {
      break;
    }
    bytes += utf8Length(codePoint);
    index += codePoint > 0xffff ? 2 : 1;
  }
  if (bytes < byteLength) {
    return incompletePushFrame;
  }
  if (bytes > byteLength) {
    throw new Error(
      `RESP bulk length ${byteLength} does not end on a character boundary`,
    );
  }
  return index - start;
}

function utf8Length(codePoint: number): number {
  if (codePoint < 0x80) {
    return 1;
  }
  if (codePoint < 0x800) {
    return 2;
  }
  if (codePoint < 0x10000) {
    return 3;
  }
  return 4;
}

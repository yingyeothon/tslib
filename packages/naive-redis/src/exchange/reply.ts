import type { TextMatch } from "@yingyeothon/naive-socket";

/**
 * Consumes exactly one complete RESP reply, whatever its type.
 *
 * A matcher that consumes one line is only correct for replies that *are*
 * one line. Point it at a command whose reply shape is not known in advance
 * and the remainder stays in the receive buffer, so the next command on the
 * same connection resolves with a fragment of this one — silently, with no
 * error anywhere. Framing the whole reply is what keeps the connection
 * usable after an unexpected answer.
 *
 * Bulk bodies are still delimited by `\r\n` rather than by their declared
 * byte length, which is the same limitation the rest of this package has:
 * a bulk value containing `\r\n` cannot be read back. Nested arrays are
 * likewise not framed — {@link replyKind} reports them so a caller can fail
 * loudly rather than desynchronize.
 */
export function captureReply(m: TextMatch): TextMatch {
  m.capture("\r\n");
  const header = lastValue(m);
  if (header === undefined) {
    return m;
  }
  if (header.startsWith("$")) {
    return header === "$-1" ? m : m.capture("\r\n");
  }
  if (header.startsWith("*")) {
    const count = Number.parseInt(header.slice(1), 10);
    for (let index = 0; index < count; ++index) {
      m.capture("\r\n");
      const element = lastValue(m);
      if (
        element !== undefined &&
        element.startsWith("$") &&
        element !== "$-1"
      ) {
        m.capture("\r\n");
      }
    }
  }
  return m;
}

export type ReplyKind =
  "status" | "error" | "integer" | "bulk" | "array" | "unknown";

/** Classifies a reply from its first byte. */
export function replyKind(header: string | undefined): ReplyKind {
  switch (header?.[0]) {
    case "+":
      return "status";
    case "-":
      return "error";
    case ":":
      return "integer";
    case "$":
      return "bulk";
    case "*":
      return "array";
    default:
      return "unknown";
  }
}

function lastValue(m: TextMatch): string | undefined {
  const values = m.values();
  return values[values.length - 1];
}

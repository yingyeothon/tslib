export function serializeCommand(command: string[]): string {
  const totalLength = command
    .map((part) => part.length)
    .reduce((a, b) => a + b, 0);
  const maxInlineRequestLength = 1 << 16;
  // Inline only when no part can break the argument or line framing;
  // anything with whitespace, quotes, backslashes, or control characters
  // goes through the length-prefixed RESP array form instead.
  const inlineSafe = /^[^\s"\\\p{Cc}]+$/u;
  if (
    totalLength <= maxInlineRequestLength &&
    command.every((part) => inlineSafe.test(part))
  ) {
    return command.join(" ");
  }

  const lines: string[] = [];
  lines.push(`*${command.length}`);
  for (const part of command) {
    // RESP bulk lengths are byte counts; the socket writes UTF-8.
    lines.push(`$${Buffer.byteLength(part)}`);
    lines.push(part);
  }
  return lines.join("\r\n") + "\r\n";
}

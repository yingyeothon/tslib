import type { Authorization } from "./types.js";

function splitByDelimiter(data: string, delim: string): [string, string] {
  const pos = data.indexOf(delim);
  return pos > 0 ? [data.slice(0, pos), data.slice(pos + 1)] : ["", ""];
}

export function parseAuthorization(raw: string): Authorization {
  const [scheme, credential] = splitByDelimiter(raw, " ");
  // RFC 7235: the scheme is case-insensitive. The parsed `type` is the
  // canonical spelling so consumers can compare it with ===.
  const lowered = scheme.toLowerCase();
  const type =
    lowered === "basic" ? "Basic" : lowered === "bearer" ? "Bearer" : scheme;
  if (type === "Basic") {
    const decoded = Buffer.from(credential, "base64").toString("utf8").trim();
    const [id, password] = splitByDelimiter(decoded, ":");
    return { type, credential: { id, password } };
  }
  if (type === "Bearer") {
    return { type, token: credential };
  }
  return { type: "Unknown", scheme, credential };
}

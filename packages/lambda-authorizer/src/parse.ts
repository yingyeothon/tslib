import type { Authorization } from "./types.js";

function splitByDelimiter(data: string, delim: string): [string, string] {
  const pos = data.indexOf(delim);
  return pos > 0 ? [data.slice(0, pos), data.slice(pos + 1)] : ["", ""];
}

export function parseAuthorization(token: string): Authorization {
  const [type, credential] = splitByDelimiter(token, " ");
  if (type === "Basic") {
    const decoded = Buffer.from(credential, "base64").toString("utf8").trim();
    const [id, password] = splitByDelimiter(decoded, ":");
    return { type, credential: { id, password } };
  }
  if (type === "Bearer") {
    return { type, token: credential };
  }
  return { type: "Unknown", scheme: type, credential };
}

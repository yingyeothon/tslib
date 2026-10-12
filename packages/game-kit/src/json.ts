/** RFC 8785 JCS for the JSON subset accepted by the kit. */
export function canonicalJson(value: unknown): string {
  const seen = new Set<object>();
  function encode(v: unknown): string {
    if (v === null) return "null";
    if (typeof v === "boolean") return v ? "true" : "false";
    if (typeof v === "number") {
      if (!Number.isFinite(v))
        throw new TypeError("kit JSON numbers must be finite");
      return JSON.stringify(v);
    }
    if (typeof v === "string") {
      for (let i = 0; i < v.length; i++) {
        const code = v.charCodeAt(i);
        if (code >= 0xd800 && code <= 0xdbff) {
          const next = v.charCodeAt(++i);
          if (!(next >= 0xdc00 && next <= 0xdfff))
            throw new TypeError("invalid Unicode string");
        } else if (code >= 0xdc00 && code <= 0xdfff)
          throw new TypeError("invalid Unicode string");
      }
      return JSON.stringify(v);
    }
    if (typeof v !== "object" || v === undefined)
      throw new TypeError("kit values must be JSON");
    if (seen.has(v)) throw new TypeError("kit JSON cannot contain cycles");
    seen.add(v);
    try {
      if (Array.isArray(v)) {
        const descriptors = Object.getOwnPropertyDescriptors(v);
        if (
          Object.getOwnPropertySymbols(v).length ||
          Object.keys(v).length !== v.length ||
          Object.values(descriptors).some(
            (d) => d.get !== undefined || d.set !== undefined,
          )
        )
          throw new TypeError("kit arrays must be dense JSON values");
        const elements: string[] = [];
        for (let i = 0; i < v.length; i++) {
          const item = descriptors[String(i)];
          if (!item) throw new TypeError("kit arrays must be dense");
          elements.push(encode(item.value));
        }
        return `[${elements.join(",")}]`;
      }
      if (
        Object.getPrototypeOf(v) !== Object.prototype &&
        Object.getPrototypeOf(v) !== null
      )
        throw new TypeError("kit JSON objects must be plain");
      const entries = Object.getOwnPropertyDescriptors(v);
      if (
        Object.values(entries).some(
          (d) => d.get !== undefined || d.set !== undefined,
        ) ||
        Object.getOwnPropertySymbols(v).length
      )
        throw new TypeError("kit JSON cannot use custom serializers");
      return `{${Object.keys(v)
        .sort()
        .map((key) => `${encode(key)}:${encode(entries[key]!.value)}`)
        .join(",")}}`;
    } finally {
      seen.delete(v);
    }
  }
  return encode(value);
}
export function copyJson<T>(value: T): T {
  return JSON.parse(canonicalJson(value)) as T;
}
export function bytes(value: unknown): number {
  return new TextEncoder().encode(canonicalJson(value)).length;
}
export async function hashJson(value: unknown): Promise<string> {
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonicalJson(value)),
  );
  return Array.from(new Uint8Array(hash), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}

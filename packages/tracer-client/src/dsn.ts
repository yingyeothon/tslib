import type { ParseTracerDsnOptions, TracerDsn } from "./types.js";

/** Hosts plain `http` is allowed for: this machine (a local `tracer serve`). */
const loopbackHosts = new Set(["127.0.0.1", "localhost", "[::1]"]);

const resourceIdPattern = /^trc_[0-9a-z]{1,40}$/;

/**
 * Printable ASCII without the characters that would change the meaning of
 * the `X-Sentry-Auth` parameter list or of a query string.
 */
const writeKeyPattern = /^[!#-+\--<>-[\]-~]{16,256}$/;

/**
 * Parses `https://{writeKey}@{host}[:port][/prefix]/{trc_id}` as `yyt tracer
 * dsn <res>` prints it. Returns `undefined` for anything else — never
 * throws, so a malformed build define turns the client off instead of
 * crashing the app.
 */
export function parseTracerDsn(
  dsn: string,
  options: ParseTracerDsnOptions = {},
): TracerDsn | undefined {
  try {
    if (typeof dsn !== "string") return undefined;
    const url = new URL(dsn.trim());
    const http = url.protocol === "http:";
    if (url.protocol !== "https:" && !http) return undefined;
    if (
      http &&
      !(options.allowHttpLoopback === true && loopbackHosts.has(url.hostname))
    ) {
      return undefined;
    }
    if (url.search !== "" || url.hash !== "" || url.password !== "") {
      return undefined;
    }
    const writeKey = decodeURIComponent(url.username);
    if (!writeKeyPattern.test(writeKey)) return undefined;
    const segments = url.pathname.split("/").filter((s) => s !== "");
    const resourceId = segments.pop();
    if (resourceId === undefined || !resourceIdPattern.test(resourceId)) {
      return undefined;
    }
    const prefix = segments.map((s) => `/${s}`).join("");
    return {
      writeKey,
      resourceId,
      envelopeUrl: `${url.protocol}//${url.host}${prefix}/api/${resourceId}/envelope/`,
    };
  } catch {
    return undefined;
  }
}

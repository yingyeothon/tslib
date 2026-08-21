import type { APIGatewayRequestAuthorizerEvent } from "aws-lambda";

/**
 * Where a REQUEST authorizer finds the credential. API Gateway hands a
 * REQUEST authorizer the whole request instead of a single
 * `authorizationToken`, and a WebSocket handshake started from a browser
 * cannot carry an `Authorization` header at all, so the location has to be
 * configurable.
 *
 * - `header` reads the named header verbatim, so it carries its own scheme
 *   (`Authorization: Bearer <token>`). Lookup is case-insensitive.
 * - `queryString` and `subprotocol` carry a bare token, so both always
 *   produce a `Bearer` authorization.
 */
export type AuthorizationSource =
  | { from: "header"; name?: string }
  | { from: "queryString"; name: string }
  | { from: "subprotocol"; name?: string };

/**
 * Tried in order by {@link readAuthorization}: an `Authorization` header
 * first, then a `bearer`-marked WebSocket subprotocol. A token in a query
 * string is never read unless it is asked for, because query strings land
 * in access logs.
 */
export const defaultAuthorizationSources: readonly AuthorizationSource[] = [
  { from: "header" },
  { from: "subprotocol" },
];

const authorizationHeader = "authorization";
const subprotocolHeader = "sec-websocket-protocol";
const subprotocolMarker = "bearer";

function readHeader(
  headers: APIGatewayRequestAuthorizerEvent["headers"],
  name: string,
): string | undefined {
  if (!headers) {
    return undefined;
  }
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted && value !== undefined && value !== "") {
      return value;
    }
  }
  return undefined;
}

/**
 * Splits `Sec-WebSocket-Protocol` and returns the entry after `marker`.
 * A browser sends `new WebSocket(url, ["bearer", token])` as
 * `Sec-WebSocket-Protocol: bearer, <token>`; the marker is required so a
 * genuine subprotocol name is never mistaken for a credential.
 */
function readSubprotocolToken(
  headers: APIGatewayRequestAuthorizerEvent["headers"],
  marker: string,
): string | undefined {
  const raw = readHeader(headers, subprotocolHeader);
  if (!raw) {
    return undefined;
  }
  const offered = raw.split(",").map((entry) => entry.trim());
  const wanted = marker.toLowerCase();
  const at = offered.findIndex((entry) => entry.toLowerCase() === wanted);
  if (at < 0) {
    return undefined;
  }
  const token = offered[at + 1];
  return token === undefined || token === "" ? undefined : token;
}

function readSource(
  event: APIGatewayRequestAuthorizerEvent,
  source: AuthorizationSource,
): string | undefined {
  if (source.from === "header") {
    return readHeader(event.headers, source.name ?? authorizationHeader);
  }
  if (source.from === "queryString") {
    const value = (event.queryStringParameters ?? {})[source.name];
    return value === undefined || value === "" ? undefined : `Bearer ${value}`;
  }
  const token = readSubprotocolToken(
    event.headers,
    source.name ?? subprotocolMarker,
  );
  return token === undefined ? undefined : `Bearer ${token}`;
}

/**
 * Returns the first `<scheme> <credential>` string the given sources yield,
 * ready for `parseAuthorization`.
 */
export function readAuthorization(
  event: APIGatewayRequestAuthorizerEvent,
  sources: readonly AuthorizationSource[] = defaultAuthorizationSources,
): string | undefined {
  for (const source of sources) {
    const found = readSource(event, source);
    if (found !== undefined) {
      return found;
    }
  }
  return undefined;
}

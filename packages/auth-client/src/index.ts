import { nullLogger, type Logger } from "@yingyeothon/logger";

export interface AuthFetchRequest {
  method: string;
  headers: Record<string, string>;
  body?: string;
}
export interface AuthFetchResponse {
  status: number;
  text(): Promise<string>;
}
export type AuthFetchLike = (
  url: string,
  request: AuthFetchRequest,
) => Promise<AuthFetchResponse>;
export interface AuthClientOptions {
  baseUrl: string;
  channelId: string;
  fetch?: AuthFetchLike;
  logger?: Logger;
}
export interface ChannelToken {
  jwt: string;
  userId: string;
  exp: number;
}
export interface AuthChannelConfig {
  issuer: string;
  audience: string;
  providers: string[];
  startUrl: string;
  redirectAllowlist: string[];
  tokenTtlSec: number;
  expiresAt?: number;
}
export interface AuthClientError extends Error {
  readonly name: "AuthClientError";
  readonly status: number;
  readonly code: string;
}
export interface AuthStartOptions {
  provider: string;
  redirectUrl: string;
  nonce: string;
}
export interface AuthRedirectOptions {
  returnedUrl: string;
  redirectUrl: string;
  expectedNonce: string;
}
export interface AuthExchangeOptions {
  provider: string;
  accessToken?: string;
  idToken?: string;
}
export interface AuthClient {
  fetchConfig(): Promise<AuthChannelConfig>;
  buildStartUrl(options: AuthStartOptions): string;
  parseRedirect(options: AuthRedirectOptions): ChannelToken;
  exchange(options: AuthExchangeOptions): Promise<ChannelToken>;
  verify(jwt: string): Promise<ChannelToken | undefined>;
}
function failure(status: number, code: string): AuthClientError {
  return Object.assign(new Error(`auth ${code} (${status})`), {
    name: "AuthClientError" as const,
    status,
    code,
  });
}
export function isAuthClientError(value: unknown): value is AuthClientError {
  return (
    typeof value === "object" &&
    value !== null &&
    "name" in value &&
    value.name === "AuthClientError" &&
    "status" in value &&
    typeof value.status === "number" &&
    "code" in value &&
    typeof value.code === "string"
  );
}
function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw failure(0, "malformed_response");
  return value as Record<string, unknown>;
}
function tokenOf(value: unknown, jwt?: string): ChannelToken {
  const v = object(value);
  const token = jwt ?? v.jwt;
  if (
    typeof token !== "string" ||
    !/^[\x21-\x7e]+$/.test(token) ||
    typeof v.userId !== "string" ||
    !v.userId ||
    !Number.isSafeInteger(v.exp) ||
    (v.exp as number) <= 0
  )
    throw failure(0, "malformed_response");
  return { jwt: token, userId: v.userId, exp: v.exp as number };
}
/** Reads identity metadata only. It does not verify a JWT signature. */
export function readTokenClaims(jwt: string): ChannelToken {
  try {
    if (jwt.split(".").length !== 3) throw new Error();
    const middle = jwt.split(".")[1]!;
    if (!/^[A-Za-z0-9_-]+$/.test(middle)) throw new Error();
    const bytes = Uint8Array.from(
      atob(middle.replace(/-/g, "+").replace(/_/g, "/")),
      (c) => c.charCodeAt(0),
    );
    const claims = object(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
    );
    return tokenOf({ userId: claims.sub, exp: claims.exp }, jwt);
  } catch {
    throw new TypeError("invalid channel token metadata");
  }
}
export function createAuthNonce(): string {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}
function equalNonce(a: string, b: string): boolean {
  let difference = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++)
    difference |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return difference === 0;
}
export function createAuthClient(options: AuthClientOptions): AuthClient {
  let base: URL;
  try {
    base = new URL(options.baseUrl);
  } catch {
    throw new RangeError("invalid auth baseUrl");
  }
  if (
    !/^https?:$/.test(base.protocol) ||
    base.username ||
    base.password ||
    base.search ||
    base.hash ||
    !/^[A-Za-z0-9_-]+$/.test(options.channelId)
  )
    throw new RangeError("invalid auth endpoint");
  const origin =
    options.baseUrl.replace(/\/+$/, "") + `/c/${options.channelId}`;
  const fetch =
    options.fetch ?? (globalThis as { fetch?: AuthFetchLike }).fetch;
  if (!fetch) throw new Error("No fetch; inject the fetch option");
  const logger = options.logger ?? nullLogger;
  async function request(
    path: string,
    init: AuthFetchRequest,
  ): Promise<{ status: number; data: unknown }> {
    let response: AuthFetchResponse;
    try {
      response = await fetch!(origin + path, init);
    } catch {
      throw failure(0, "network");
    }
    logger.debug("auth request", {
      method: init.method,
      status: response.status,
    });
    if (response.status === 401 && path === "/verify")
      return { status: 401, data: undefined };
    if (response.status < 200 || response.status >= 300)
      throw failure(response.status, `http_${response.status}`);
    try {
      return {
        status: response.status,
        data: JSON.parse(await response.text()) as unknown,
      };
    } catch {
      throw failure(response.status, "malformed_response");
    }
  }
  return {
    async fetchConfig() {
      const v = object(
        (await request("/.well-known/config", { method: "GET", headers: {} }))
          .data,
      );
      if (
        typeof v.issuer !== "string" ||
        typeof v.audience !== "string" ||
        !Array.isArray(v.providers) ||
        !v.providers.every((x) => typeof x === "string") ||
        typeof v.startUrl !== "string" ||
        !Array.isArray(v.redirectAllowlist) ||
        !v.redirectAllowlist.every((x) => typeof x === "string") ||
        !Number.isSafeInteger(v.tokenTtlSec)
      )
        throw failure(200, "malformed_response");
      return {
        issuer: v.issuer,
        audience: v.audience,
        providers: v.providers,
        startUrl: v.startUrl,
        redirectAllowlist: v.redirectAllowlist,
        tokenTtlSec: v.tokenTtlSec as number,
        ...(typeof v.expiresAt === "number" ? { expiresAt: v.expiresAt } : {}),
      };
    },
    buildStartUrl({ provider, redirectUrl, nonce }) {
      let redirect: URL;
      try {
        redirect = new URL(redirectUrl);
      } catch {
        throw new RangeError("invalid auth redirect");
      }
      if (
        !nonce ||
        !provider ||
        redirect.hash ||
        redirect.username ||
        redirect.password
      )
        throw new RangeError("invalid auth redirect options");
      redirect.searchParams.set("nonce", nonce);
      const start = new URL(origin + "/start");
      start.searchParams.set("provider", provider);
      start.searchParams.set("redirect", redirect.href);
      return start.href;
    },
    parseRedirect({ returnedUrl, redirectUrl, expectedNonce }) {
      try {
        const returned = new URL(returnedUrl);
        const expected = new URL(redirectUrl);
        if (
          returned.origin !== expected.origin ||
          returned.protocol !== expected.protocol ||
          returned.host !== expected.host ||
          returned.pathname !== expected.pathname ||
          !expectedNonce ||
          !equalNonce(returned.searchParams.get("nonce") ?? "", expectedNonce)
        )
          throw failure(0, "nonce_mismatch");
        const data = new URLSearchParams(returned.hash.slice(1));
        const jwt = data.get("token");
        const userId = data.get("userId");
        const exp = Number(data.get("exp"));
        if (!jwt || !userId || !exp) throw failure(0, "missing_fragment");
        const token = tokenOf({ jwt, userId, exp });
        const claims = readTokenClaims(jwt);
        if (claims.userId !== userId || claims.exp !== exp)
          throw failure(0, "malformed_response");
        return token;
      } catch (error) {
        if (isAuthClientError(error)) throw error;
        throw failure(0, "malformed_response");
      }
    },
    async exchange({ provider, accessToken, idToken }) {
      if (!provider || (accessToken === undefined) === (idToken === undefined))
        throw new TypeError("provide exactly one provider credential");
      return tokenOf(
        (
          await request("/token", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              provider,
              ...(accessToken === undefined ? { idToken } : { accessToken }),
            }),
          })
        ).data,
      );
    },
    async verify(jwt) {
      if (!/^[\x21-\x7e]+$/.test(jwt))
        throw new TypeError("invalid bearer token");
      const answer = await request("/verify", {
        method: "GET",
        headers: { authorization: `Bearer ${jwt}` },
      });
      return answer.status === 401 ? undefined : tokenOf(answer.data, jwt);
    },
  };
}

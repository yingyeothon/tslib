import type { PlatformFetchLike, PlatformFetchResponse } from "./types.js";
import { nullLogger } from "@yingyeothon/logger";
import type { PlatformClientOptions, PlatformClientError } from "./types.js";
export const record = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const safeErrors = new WeakSet<Error>();
export function invalid(message: string): RangeError {
  const e = new RangeError(message);
  safeErrors.add(e);
  return e;
}
export function failure(
  status: number,
  code: string,
  fields: { reason?: string; retryAfterMs?: number } = {},
): PlatformClientError {
  const e = Object.assign(new Error(`platform ${code} (${status})`), {
    name: "PlatformClientError" as const,
    status,
    code,
    ...fields,
  });
  safeErrors.add(e);
  return e;
}
export function isPlatformClientError(v: unknown): v is PlatformClientError {
  return (
    record(v) &&
    v.name === "PlatformClientError" &&
    typeof v.status === "number" &&
    typeof v.code === "string"
  );
}
export function protect<T extends object>(methods: T): T {
  const result = { ...methods };
  for (const key of Object.keys(methods) as (keyof T)[]) {
    const method = methods[key] as (...args: never[]) => Promise<unknown>;
    result[key] = (async (...args: never[]) => {
      try {
        return await method(...args);
      } catch (e) {
        if (e instanceof Error && safeErrors.has(e)) throw e;
        throw failure(0, "invalid_request");
      }
    }) as T[keyof T];
  }
  return result;
}
export function origin(value: string, protocols = /^https?:$/): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalid("Invalid platform base URL");
  }
  if (
    !protocols.test(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw invalid("Invalid platform base URL");
  return url.href.replace(/\/+$/, "");
}
export function segment(value: string): string {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 128 ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)
  )
    throw invalid("Invalid platform identifier");
  return encodeURIComponent(value);
}
export function credential(token: string): void {
  if (typeof token !== "string" || !/^[A-Za-z0-9._~+/-]+=*$/.test(token))
    throw invalid("Invalid platform credential");
}
const codes = new Set([
  "bad_request",
  "unauthorized",
  "forbidden",
  "not_found",
  "conflict",
  "gone",
  "too_many_requests",
  "rate_limited",
  "unavailable",
  "internal_error",
  "service_unavailable",
]);
const reasons = new Set([
  "board_full",
  "profile_required",
  "owner_full",
  "sender_full",
  "server_only",
  "out_of_range",
  "cooldown",
  "queue_full",
  "proposed",
  "confirming",
  "proposal_closed",
  "not_proposed",
  "confirmed",
  "busy",
  "wrong_mode",
]);
export type Check = (value: unknown) => boolean;
export const str: Check = (v) => typeof v === "string";
export const num: Check = (v) => typeof v === "number" && Number.isFinite(v);
export const int: Check = (v) => Number.isSafeInteger(v) && (v as number) >= 0;
export const bool: Check = (v) => typeof v === "boolean";
export const nullable =
  (check: Check): Check =>
  (v) =>
    v === null || check(v);
export const array =
  (check: Check): Check =>
  (v) =>
    Array.isArray(v) && v.every(check);
export const shape =
  (fields: Record<string, Check>): Check =>
  (v) =>
    record(v) &&
    Object.entries(fields).every(
      ([k, check]) => Object.hasOwn(v, k) && check(v[k]),
    );
export function createHttp(options: PlatformClientOptions) {
  const base = origin(options.baseUrl);
  const token = options.token;
  if (token !== undefined) credential(token);
  const fetch =
    options.fetch ?? (globalThis as { fetch?: PlatformFetchLike }).fetch;
  if (!fetch) throw new Error("No fetch; inject the fetch option");
  const logger = options.logger ?? nullLogger;
  return async <T>(
    path: string,
    method: string,
    expected: number[],
    check: Check,
    body?: unknown,
    auth = true,
  ): Promise<T> => {
    if (auth && !token) throw failure(401, "unauthorized");
    let encoded: string | undefined;
    try {
      if (body !== undefined) encoded = JSON.stringify(body);
    } catch {
      throw failure(0, "invalid_request");
    }
    let response: PlatformFetchResponse;
    try {
      response = await fetch(`${base}${path}`, {
        method,
        headers: {
          ...(auth ? { Authorization: `Bearer ${token}` } : {}),
          ...(encoded === undefined
            ? {}
            : { "Content-Type": "application/json" }),
        },
        ...(encoded === undefined ? {} : { body: encoded }),
        ...(auth
          ? { redirect: "error" as const, signal: AbortSignal.timeout(30000) }
          : {}),
      });
    } catch {
      throw failure(0, "network");
    }
    logger.debug("platform request completed", {
      method,
      status: response.status,
    });
    let data: unknown;
    if (response.status !== 204) {
      try {
        data = JSON.parse(await response.text()) as unknown;
      } catch {
        if (expected.includes(response.status))
          throw failure(response.status, "malformed_response");
      }
    }
    if (!expected.includes(response.status)) {
      const e = record(data) && record(data.error) ? data.error : {};
      const d = record(e.details) ? e.details : {};
      const retryAfterMs =
        typeof d.retryAfter === "number" &&
        Number.isFinite(d.retryAfter) &&
        d.retryAfter >= 0
          ? d.retryAfter * 1000
          : undefined;
      throw failure(
        response.status,
        typeof e.code === "string" && codes.has(e.code)
          ? e.code
          : `http_${response.status}`,
        {
          reason:
            typeof d.reason === "string" && reasons.has(d.reason)
              ? d.reason
              : undefined,
          retryAfterMs,
        },
      );
    }
    if (!check(data)) throw failure(response.status, "malformed_response");
    return data as T;
  };
}

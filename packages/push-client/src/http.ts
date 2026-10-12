import { nullLogger, type Logger } from "@yingyeothon/logger";

export interface PushClientFetchRequest {
  method: string;
  headers: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
  redirect?: "error";
}
export interface PushClientFetchResponse {
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}
export type PushClientFetchLike = (
  url: string,
  request: PushClientFetchRequest,
) => Promise<PushClientFetchResponse>;
export interface PushClientError extends Error {
  readonly name: "PushClientError";
  readonly status: number;
  readonly code: string;
  readonly reason?: string;
  readonly retryAfterMs?: number;
}
export function isPushClientError(value: unknown): value is PushClientError {
  return (
    record(value) &&
    value.name === "PushClientError" &&
    typeof value.status === "number" &&
    typeof value.code === "string"
  );
}
const safeErrors = new WeakSet<Error>();
export function invalid(message: string): RangeError {
  const error = new RangeError(message);
  safeErrors.add(error);
  return error;
}
export function protect<T extends object>(methods: T): T {
  const result = { ...methods };
  for (const key of Object.keys(methods) as (keyof T)[]) {
    const method = methods[key] as (...args: never[]) => Promise<unknown>;
    result[key] = (async (...args: never[]) => {
      try {
        return await method(...args);
      } catch (error) {
        if (error instanceof Error && safeErrors.has(error)) throw error;
        throw failure(0, "invalid_request");
      }
    }) as T[keyof T];
  }
  return result;
}
export function failure(
  status: number,
  code: string,
  extra: { reason?: string; retryAfterMs?: number } = {},
): PushClientError {
  const result = Object.assign(new Error(`push ${code} (${status})`), {
    name: "PushClientError" as const,
    status,
    code,
    ...extra,
  });
  safeErrors.add(result);
  return result;
}
export function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function baseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalid("Invalid push base URL");
  }
  if (
    !/^https?:$/.test(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw invalid("Invalid push base URL");
  return url.href.replace(/\/+$/, "");
}
export function identifier(value: string): string {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)
  )
    throw invalid("Invalid push identifier");
  return encodeURIComponent(value);
}
export function credential(value: string): void {
  if (typeof value !== "string" || !/^[A-Za-z0-9._~+/-]+=*$/.test(value))
    throw invalid("Invalid push credential");
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
  "internal_error",
  "service_unavailable",
  "unavailable",
]);
const reasons = new Set([
  "push_project_required",
  "push_project_refused",
  "push_payload_too_large",
  "push_not_registered",
  "push_not_configured",
  "csv_invalid",
  "csv_missing_columns",
  "template_has_variables",
  "idempotency_key_reused",
  "upload_missing",
  "upload_expired",
  "upload_size_mismatch",
  "upload_checksum_mismatch",
  "push_upload_cap",
  "upload_in_use",
  "push_dry_run_cap",
  "report_not_ready",
  "report_absent",
  "channel_inactive",
  "report_expired",
  "push_sender_unavailable",
  "push_storage_unavailable",
]);
export function createRequest(options: {
  fetch?: PushClientFetchLike;
  logger?: Logger;
  token: string;
  timeoutMs?: number;
}) {
  credential(options.token);
  const token = options.token;
  const timeoutMs = options.timeoutMs ?? 30000;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > 2147483647
  )
    throw invalid("Invalid push timeoutMs");
  const fetch =
    options.fetch ?? (globalThis as { fetch?: PushClientFetchLike }).fetch;
  if (!fetch) throw new Error("No fetch; inject the fetch option");
  const logger = options.logger ?? nullLogger;
  return async (
    url: string,
    method: string,
    expected: number[],
    body?: unknown,
  ): Promise<unknown> => {
    let encoded: string | undefined;
    try {
      if (body !== undefined) encoded = JSON.stringify(body);
    } catch {
      throw failure(0, "invalid_request");
    }
    let response: PushClientFetchResponse;
    try {
      response = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(encoded === undefined
            ? {}
            : { "Content-Type": "application/json" }),
        },
        body: encoded,
        signal: AbortSignal.timeout(timeoutMs),
        redirect: "error",
      });
    } catch {
      throw failure(0, "network");
    }
    logger.debug("push request completed", { method, status: response.status });
    if (!expected.includes(response.status)) {
      let data: unknown;
      try {
        data = JSON.parse(await response.text());
      } catch {
        /* Empty throttle responses are expected. */
      }
      const error = record(data) && record(data.error) ? data.error : {};
      const details = record(error.details) ? error.details : {};
      const code =
        typeof error.code === "string" && codes.has(error.code)
          ? error.code
          : `http_${response.status}`;
      const reason =
        typeof details.reason === "string" && reasons.has(details.reason)
          ? details.reason
          : undefined;
      let retryAfterMs =
        typeof details.retryAfterMs === "number" &&
        Number.isFinite(details.retryAfterMs) &&
        details.retryAfterMs >= 0
          ? details.retryAfterMs
          : undefined;
      const retryHeader = response.headers.get("retry-after");
      if (
        retryAfterMs === undefined &&
        retryHeader &&
        /^\d+(?:\.\d+)?$/.test(retryHeader)
      ) {
        const value = Number(retryHeader) * 1000;
        if (Number.isFinite(value)) retryAfterMs = value;
      }
      throw failure(response.status, code, { reason, retryAfterMs });
    }
    if (response.status === 204) return undefined;
    try {
      return JSON.parse(await response.text()) as unknown;
    } catch {
      throw failure(response.status, "malformed_response");
    }
  };
}

import { nullLogger, type Logger } from "@yingyeothon/logger";

export interface PlatformFetchRequest {
  method: string;
  headers: Record<string, string>;
  body?: string;
}
export interface PlatformFetchResponse {
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}
export type PlatformFetchLike = (
  url: string,
  request: PlatformFetchRequest,
) => Promise<PlatformFetchResponse>;
export interface PlatformClientOptions {
  baseUrl: string;
  fetch?: PlatformFetchLike;
  logger?: Logger;
}
export interface PlatformTime {
  now: string;
  epochMs: number;
}
export interface PlatformClientError extends Error {
  readonly name: "PlatformClientError";
  readonly status: number;
  readonly code: string;
}
export interface PlatformClient {
  time(): Promise<PlatformTime>;
}
export function isPlatformClientError(
  value: unknown,
): value is PlatformClientError {
  return (
    typeof value === "object" &&
    value !== null &&
    "name" in value &&
    value.name === "PlatformClientError" &&
    "status" in value &&
    typeof value.status === "number" &&
    "code" in value &&
    typeof value.code === "string"
  );
}
function failure(status: number, code: string): PlatformClientError {
  return Object.assign(new Error(`platform ${code} (${status})`), {
    name: "PlatformClientError" as const,
    status,
    code,
  });
}
export function createPlatformClient(
  options: PlatformClientOptions,
): PlatformClient {
  let url: URL;
  try {
    url = new URL(options.baseUrl);
  } catch {
    throw new RangeError("platform baseUrl must be an HTTP origin");
  }
  if (
    !/^https?:$/.test(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new RangeError("invalid platform baseUrl");
  const origin = options.baseUrl.replace(/\/+$/, "");
  const fetch =
    options.fetch ?? (globalThis as { fetch?: PlatformFetchLike }).fetch;
  if (!fetch) throw new Error("No fetch; inject the fetch option");
  const logger = options.logger ?? nullLogger;
  return {
    async time() {
      let response: PlatformFetchResponse;
      try {
        response = await fetch(`${origin}/time`, {
          method: "GET",
          headers: {},
        });
      } catch {
        throw failure(0, "network");
      }
      logger.debug("platform time request", { status: response.status });
      if (response.status !== 200)
        throw failure(response.status, `http_${response.status}`);
      let data: unknown;
      try {
        data = JSON.parse(await response.text());
      } catch {
        throw failure(response.status, "malformed_response");
      }
      if (
        typeof data !== "object" ||
        data === null ||
        !("epochMs" in data) ||
        !Number.isSafeInteger(data.epochMs) ||
        !("now" in data) ||
        typeof data.now !== "string"
      )
        throw failure(response.status, "malformed_response");
      return { now: data.now, epochMs: data.epochMs as number };
    },
  };
}

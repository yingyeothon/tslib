import type { S3cbClientOptions } from "./types.js";

export function authorizationHeader(
  options: S3cbClientOptions,
): Record<string, string> {
  if (options.apiId !== undefined && options.apiPassword !== undefined) {
    const authorization = Buffer.from(
      `${options.apiId}:${options.apiPassword}`,
      "utf-8",
    ).toString("base64");
    return { Authorization: `Basic ${authorization}` };
  }
  return {};
}

export function buildQueryParams(
  params: Record<string, string | number | boolean>,
): string {
  return (
    `?` +
    Object.entries(params)
      .map(([key, value]) =>
        value === true
          ? `${key}=1`
          : value === false
            ? `${key}=0`
            : `${key}=${encodeURIComponent(value)}`,
      )
      .join("&")
  );
}

export function makeBodyAsBuffer(
  body: string | Buffer | Uint8Array,
): Buffer | Uint8Array {
  return typeof body === "string" ? Buffer.from(body, "utf8") : body;
}

export async function httpRequest<R = string>({
  url,
  method,
  headers,
  body,
  handleResponse,
}: {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: Buffer | Uint8Array;
  handleResponse?: (response: Response) => Promise<R>;
}): Promise<R> {
  const response = await fetch(url, {
    method,
    headers,
    ...(body !== undefined ? { body } : {}),
  });
  if (response.status !== 200) {
    await response.body?.cancel();
    throw new Error(`${response.status} ${response.statusText}`);
  }
  if (handleResponse !== undefined) {
    return handleResponse(response);
  }
  return (await response.text()) as R;
}

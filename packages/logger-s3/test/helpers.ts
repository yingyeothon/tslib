import type { S3cbClient } from "@yingyeothon/s3-cache-bridge-client";
import { vi } from "vitest";

export interface Appended {
  key: string;
  body: string;
}

export function fakeS3cbClient(
  appends: Appended[],
  appendImpl?: (key: string, body: string) => Promise<string>,
): S3cbClient {
  const append = vi.fn((key: string, body: string) => {
    if (appendImpl) {
      return appendImpl(key, body);
    }
    appends.push({ key, body });
    return Promise.resolve("");
  });
  return { append } as unknown as S3cbClient;
}

export function parseLines(appends: Appended[]): Record<string, unknown[]> {
  const parsed: Record<string, unknown[]> = {};
  for (const { key, body } of appends) {
    const records = body
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as unknown);
    parsed[key] = [...(parsed[key] ?? []), ...records];
  }
  return parsed;
}

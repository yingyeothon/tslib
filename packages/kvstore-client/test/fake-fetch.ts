import type {
  KvFetchLike,
  KvFetchRequest,
  KvFetchResponse,
} from "../src/index.js";

export interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

export interface FakeAnswer {
  status: number;
  headers?: Record<string, string>;
  body?: string;
}

/**
 * A scripted `fetch`: each call consumes the next answer in order and records
 * what was sent, so a test asserts the exact method, path, query, headers and
 * body the client put on the wire. A `reject` answer models a network failure.
 */
export function createFakeFetch(answers: (FakeAnswer | { reject: Error })[]) {
  const requests: RecordedRequest[] = [];
  const queue = [...answers];
  const fetch: KvFetchLike = (url: string, init: KvFetchRequest) => {
    requests.push({
      url,
      method: init.method,
      headers: { ...init.headers },
      body: init.body,
    });
    const next = queue.shift();
    if (next === undefined) {
      return Promise.reject(new Error("fake fetch: no answer scripted"));
    }
    if ("reject" in next) return Promise.reject(next.reject);
    const headers = new Map(
      Object.entries(next.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
    );
    const response: KvFetchResponse = {
      status: next.status,
      headers: { get: (name) => headers.get(name.toLowerCase()) ?? null },
      text: () => Promise.resolve(next.body ?? ""),
    };
    return Promise.resolve(response);
  };
  return {
    fetch,
    requests,
    /** The one request a single-call test made. */
    only(): RecordedRequest {
      if (requests.length !== 1) {
        throw new Error(`expected one request, saw ${requests.length}`);
      }
      return requests[0]!;
    },
  };
}

export const json = (
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): FakeAnswer => ({
  status,
  headers: { "content-type": "application/json; charset=utf-8", ...headers },
  body: JSON.stringify(body),
});

export const error = (
  status: number,
  code: string,
  details?: Record<string, unknown>,
): FakeAnswer =>
  json(status, {
    error: {
      code,
      message: `${code} happened`,
      ...(details ? { details } : {}),
    },
  });

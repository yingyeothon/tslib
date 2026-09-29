import type {
  AssetFetchLike,
  AssetFetchRequest,
  AssetFetchResponse,
} from "../src/index.js";

export interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  cache: string | undefined;
}

export interface FakeCdnOptions {
  /** Answer every GET with the whole object, as a host without Range does. */
  ignoreRange?: boolean;
  /** Serve the range even when `If-Range` names another ETag. */
  ignoreIfRange?: boolean;
  /**
   * What a cross-origin script sees on the yyt CDN: no `Content-Range`, only
   * `ETag` and `Content-Length`.
   */
  crossOrigin?: boolean;
  /** Send no `ETag` at all. */
  noEtag?: boolean;
  /** How the body is cut into stream chunks. */
  chunkSize?: number;
  /** Runs before each answer, with the request's index: mutate the CDN here. */
  beforeAnswer?: (index: number, request: RecordedRequest) => void;
}

/**
 * A scripted CDN: objects by URL, `Range`/`If-Range`/`HEAD` as CloudFront
 * answers them, a missing object as 403, and every request recorded so a test
 * asserts exactly what went on the wire.
 */
export function createFakeCdn(options: FakeCdnOptions = {}) {
  const objects = new Map<string, { bytes: Uint8Array; etag: string }>();
  const requests: RecordedRequest[] = [];
  let generation = 0;
  const chunkSize = options.chunkSize ?? 7_000;

  function put(url: string, bytes: Uint8Array): string {
    generation += 1;
    const etag = `"etag-${generation}"`;
    objects.set(url, { bytes, etag });
    return etag;
  }

  /** Bodies handed out and neither read to the end nor cancelled. */
  let openBodies = 0;
  /** When set, a request carrying `Range` rejects, as a refused preflight does. */
  let refuseRange = false;

  function streamOf(bytes: Uint8Array): AssetFetchResponse["body"] {
    let at = 0;
    let open = true;
    openBodies += 1;
    const close = () => {
      if (open) openBodies -= 1;
      open = false;
    };
    return {
      getReader() {
        return {
          read() {
            if (at >= bytes.length) {
              close();
              return Promise.resolve({ done: true, value: undefined });
            }
            const value = bytes.slice(at, at + chunkSize);
            at += value.length;
            return Promise.resolve({ done: false, value });
          },
          cancel() {
            at = bytes.length;
            close();
            return Promise.resolve();
          },
        };
      },
    };
  }

  function answer(
    status: number,
    headers: Record<string, string>,
    bytes: Uint8Array | undefined,
  ): AssetFetchResponse {
    const lower = new Map(
      Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]),
    );
    if (options.crossOrigin) {
      for (const name of [...lower.keys()]) {
        if (name !== "etag" && name !== "content-length") lower.delete(name);
      }
    }
    if (options.noEtag) lower.delete("etag");
    return {
      status,
      headers: { get: (name) => lower.get(name.toLowerCase()) ?? null },
      arrayBuffer: () =>
        Promise.resolve((bytes ?? new Uint8Array(0)).slice().buffer),
      body: bytes === undefined ? null : streamOf(bytes),
    };
  }

  const fetch: AssetFetchLike = (url: string, init: AssetFetchRequest) => {
    const recorded: RecordedRequest = {
      url,
      method: init.method,
      headers: { ...init.headers },
      cache: init.cache,
    };
    requests.push(recorded);
    options.beforeAnswer?.(requests.length - 1, recorded);
    if (refuseRange && init.headers.range !== undefined) {
      return Promise.reject(new TypeError("Failed to fetch"));
    }
    const object = objects.get(url);
    if (object === undefined) {
      return Promise.resolve(answer(403, {}, new Uint8Array(0)));
    }
    const { bytes, etag } = object;
    const size = bytes.length;
    const base = { etag, "content-type": "application/octet-stream" };
    if (init.method === "HEAD") {
      return Promise.resolve(
        answer(200, { ...base, "content-length": String(size) }, undefined),
      );
    }
    const range = init.headers.range;
    const ifRange = init.headers["if-range"];
    const honour =
      range !== undefined &&
      !options.ignoreRange &&
      (ifRange === undefined || ifRange === etag || options.ignoreIfRange);
    if (!honour) {
      return Promise.resolve(
        answer(200, { ...base, "content-length": String(size) }, bytes),
      );
    }
    const match = /^bytes=(\d+)-(\d*)$/.exec(range);
    if (match === null) throw new Error(`fake cdn: bad range ${range}`);
    const from = Number(match[1]);
    const to =
      match[2] === "" ? size - 1 : Math.min(Number(match[2]), size - 1);
    if (from >= size) {
      return Promise.resolve(
        answer(
          416,
          { ...base, "content-range": `bytes */${size}` },
          new Uint8Array(0),
        ),
      );
    }
    const body = bytes.slice(from, to + 1);
    return Promise.resolve(
      answer(
        206,
        {
          ...base,
          "content-length": String(body.length),
          "content-range": `bytes ${from}-${to}/${size}`,
        },
        body,
      ),
    );
  };

  return {
    fetch,
    requests,
    put,
    remove: (url: string) => objects.delete(url),
    /** Bodies still holding a connection; every test should end at 0. */
    openBodies: () => openBodies,
    refuseRange(on = true) {
      refuseRange = on;
    },
  };
}

/** A capturing sink: what `download` wrote, in order, and every reset. */
export function createMemorySink() {
  let chunks: Uint8Array[] = [];
  const events: string[] = [];
  return {
    events,
    sink: {
      write(chunk: Uint8Array) {
        chunks.push(chunk.slice());
        events.push(`write:${chunk.length}`);
      },
      reset() {
        chunks = [];
        events.push("reset");
      },
    },
    /** Pre-fills the sink as an earlier, interrupted download left it. */
    seed(bytes: Uint8Array) {
      chunks = [bytes.slice()];
    },
    bytes(): Uint8Array {
      return new Uint8Array(Buffer.concat(chunks));
    },
  };
}

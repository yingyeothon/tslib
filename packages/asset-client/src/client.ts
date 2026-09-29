import { nullLogger } from "@yingyeothon/logger";
import type { BundleCrypto, Decryptor } from "./crypto.js";
import { createBundleCrypto, resolveSubtle } from "./crypto.js";
import {
  corrupt,
  createAssetClientError,
  isAssetClientError,
} from "./errors.js";
import {
  headerLength,
  maxCiphertext,
  plainStart,
  plaintextLengthOf,
  segmentExtent,
  segmentOf,
  segmentSize,
  segmentsOf,
} from "./format.js";
import type { Answer, BodyReader, Requester, RequestSpec } from "./http.js";
import { createRequester, isStrongEtag } from "./http.js";
import { parseAssetKey } from "./key.js";
import type { BundleBase } from "./paths.js";
import { checkPath, fileUrl, parseBaseUrl } from "./paths.js";
import type {
  AssetBundleClient,
  AssetBundleClientOptions,
  AssetCacheMode,
  AssetDownloadOptions,
  AssetDownloadResult,
  AssetFetchLike,
  AssetRangeOptions,
  AssetReadOptions,
} from "./types.js";

/** How often a read starts over because the object changed under it. */
const maxRestarts = 3;

interface File {
  path: string;
  url: string;
  /** The associated data: the object key below the bundle. */
  ad: string;
}

/** An attempt that saw the object change; the caller starts over. */
interface Changed {
  changed: true;
  status: number;
}

const changed = (status: number): Changed => ({ changed: true, status });

const isChanged = (value: unknown): value is Changed =>
  typeof value === "object" &&
  value !== null &&
  (value as { changed?: unknown }).changed === true;

/** `fetch` itself rejected: no status, as opposed to a body that failed. */
const isFetchRejection = (error: unknown): boolean =>
  isAssetClientError(error) && error.code === "network" && error.status === 0;

function concat(chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

const httpError = (status: number, detail?: string) =>
  createAssetClientError({ code: "http", status, detail });

function resolveFetch(injected: AssetFetchLike | undefined): AssetFetchLike {
  if (injected !== undefined) return injected;
  const global = (globalThis as { fetch?: AssetFetchLike }).fetch;
  if (global === undefined) {
    throw new Error("No global fetch; pass the fetch option");
  }
  return global;
}

/** A browser window or worker, where every request is cross-origin to the CDN. */
function detectCorsSafe(): boolean {
  const scope = globalThis as {
    document?: unknown;
    WorkerGlobalScope?: unknown;
  };
  return (
    (typeof scope.document === "object" && scope.document !== null) ||
    typeof scope.WorkerGlobalScope === "function"
  );
}

function checkOffset(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`asset ${name} must be a non-negative safe integer`);
  }
  return value;
}

/**
 * Accepts a ranged answer, or says why not. A `200` to a request that carried
 * `If-Range`, another `ETag` or another total length means the object changed
 * (start over); a `200` otherwise means the host ignores `Range`.
 */
function checkRanged(
  answer: Answer,
  expected: {
    from: number;
    /** Inclusive, as requested; the host clamps it to the end. */
    to: number | undefined;
    total: number | undefined;
    etag: string | undefined;
    ifRangeSent: boolean;
    /** Only `Range` crossed: `Content-Range` may be unreadable. */
    corsSafe: boolean;
  },
): { total: number | undefined; etag: string | undefined } | Changed {
  const { status } = answer;
  if (status === 200) {
    if (expected.ifRangeSent) return changed(status);
    if (expected.etag !== undefined && answer.etag !== expected.etag) {
      return changed(status);
    }
    throw httpError(status, "the host ignores Range");
  }
  if (status === 416) {
    // The range was computed from a length the object no longer has; with
    // nothing known yet, the object is empty, which no ciphertext is.
    if (expected.total !== undefined) return changed(status);
    throw corrupt(status);
  }
  // Without `If-Range`, only the answer's own `ETag` says which object this
  // is; an answer that names none cannot be spliced onto one that did.
  if (
    expected.etag !== undefined &&
    answer.etag !== expected.etag &&
    (answer.etag !== undefined || !expected.ifRangeSent)
  ) {
    return changed(status);
  }
  const range = answer.range;
  if (range === undefined) {
    if (!expected.corsSafe) throw httpError(status, "no Content-Range");
    return { total: expected.total, etag: answer.etag ?? expected.etag };
  }
  if (range.total === undefined) {
    throw httpError(status, "no total length in Content-Range");
  }
  if (expected.total !== undefined && range.total !== expected.total) {
    return changed(status);
  }
  const end = Math.min(expected.to ?? range.total - 1, range.total - 1);
  if (range.start !== expected.from || range.end !== end) {
    throw httpError(status, "Content-Range is not the range asked for");
  }
  return { total: range.total, etag: answer.etag ?? expected.etag };
}

/** One encrypted read, opened: the body is positioned at segment `first`. */
interface Opened {
  decryptor: Decryptor;
  etag: string | undefined;
  /** The clamped plaintext window. */
  start: number;
  end: number;
  first: number;
  last: number;
  body: BodyReader;
}

/**
 * A client for one asset bundle on the yyt CDN. With a `key` it decrypts
 * `yyt-enc v1` ciphertext, verifying every segment before releasing a byte
 * of it; without one it reads a plain bundle through the same calls.
 */
export function createAssetBundleClient(
  options: AssetBundleClientOptions,
): AssetBundleClient {
  const { logger = nullLogger } = options;
  const encrypted = options.key !== undefined;
  const base: BundleBase = parseBaseUrl(options.baseUrl, encrypted);
  const corsSafe = options.corsSafe ?? detectCorsSafe();
  let crypto: BundleCrypto | undefined;
  if (encrypted) {
    const raw = parseAssetKey(options.key);
    try {
      crypto = createBundleCrypto(resolveSubtle(), raw);
    } catch (error) {
      raw.fill(0);
      throw error;
    }
  }
  const request: Requester = createRequester(
    resolveFetch(options.fetch),
    logger,
  );
  let closed = false;

  function fileOf(path: unknown): File {
    if (closed) throw new Error("asset client is closed");
    const checked = checkPath(path);
    return {
      path: checked,
      url: fileUrl(base, checked),
      ad: (base.adPrefix ?? "") + checked,
    };
  }

  function bundleCrypto(): BundleCrypto {
    if (crypto === undefined || closed) {
      throw new Error("asset client is closed");
    }
    return crypto;
  }

  async function restarting<T>(
    file: File,
    attempt: () => Promise<T | Changed>,
    onChanged: () => void | Promise<void>,
  ): Promise<T> {
    for (let restart = 0; ; restart += 1) {
      const outcome = await attempt();
      if (!isChanged(outcome)) return outcome;
      if (restart >= maxRestarts) {
        throw httpError(outcome.status, "the object kept changing");
      }
      logger.info("asset changed during a read; starting over", {
        path: file.path,
        restart: restart + 1,
      });
      await onChanged();
    }
  }

  /**
   * Opens plaintext `[start, end)` of an encrypted file: the length and the
   * `ETag` first, then one ranged request from the first segment the window
   * touches to the end of the last. `resumeEtag` is the identity an earlier
   * download recorded; another object is a change. Every body this opened and
   * did not hand back is cancelled, on success and on failure alike, so a
   * refused answer never holds its connection.
   */
  async function openEncrypted(
    file: File,
    window: { start: number; end: number | undefined },
    resumeEtag: string | undefined,
    cache: AssetCacheMode | undefined,
  ): Promise<Opened | Changed> {
    const bodies: BodyReader[] = [];
    const send = async (spec: Omit<RequestSpec, "cache">) => {
      const answer = await request(file.url, file.path, { ...spec, cache });
      bodies.push(answer.body);
      return answer;
    };
    let kept: BodyReader | undefined;
    try {
      const outcome = await openEncryptedWith(send, file, window, resumeEtag);
      if (!isChanged(outcome)) kept = outcome.body;
      return outcome;
    } finally {
      for (const body of bodies) {
        if (body !== kept) await body.cancel();
      }
    }
  }

  type Send = (spec: Omit<RequestSpec, "cache">) => Promise<Answer>;

  /** Which segments a window needs, once the length is known. */
  function planWindow(
    total: number,
    window: { start: number; end: number | undefined },
  ) {
    const segments = segmentsOf(total);
    if (segments === undefined) throw corrupt();
    const plainLength = plaintextLengthOf(total, segments);
    const start = Math.min(window.start, plainLength);
    const end = Math.min(window.end ?? plainLength, plainLength);
    // The length came from an unauthenticated header, so a window with
    // nothing in it — an empty file, a window past the end, a finished
    // resume — still fetches and verifies the last segment: its `last` flag
    // and its exact extent are what prove the length, the key and the path.
    // Nothing of it is released.
    const empty = start >= end;
    return {
      start,
      end,
      first: empty ? segments - 1 : segmentOf(start),
      last: empty ? segments - 1 : segmentOf(end - 1),
    };
  }

  async function openEncryptedWith(
    send: Send,
    file: File,
    window: { start: number; end: number | undefined },
    resumeEtag: string | undefined,
  ): Promise<Opened | Changed> {
    if (!corsSafe) return openConditional(send, file, window, resumeEtag);
    // `Content-Range` is unreadable and `If-Range` would need a preflight
    // the CDN refuses, so the length and the identity come from a HEAD.
    const head = await send({ method: "HEAD", kind: "head" });
    if (head.status !== 200) throw httpError(head.status);
    if (head.encoded || head.length === undefined) {
      throw httpError(head.status, "no usable Content-Length");
    }
    if (resumeEtag !== undefined && head.etag !== resumeEtag) {
      return changed(head.status);
    }
    const total = head.length;
    const etag = head.etag;
    try {
      return await openSafelisted(send, file, window, total, etag);
    } catch (error) {
      if (!isFetchRejection(error)) throw error;
      // The HEAD went through and a request that differs from it only by
      // `Range` did not: a browser that still preflights `Range`, which the
      // CDN refuses. The whole file still verifies segment by segment.
      logger.warn("asset ranged request refused; reading the whole file", {
        path: file.path,
      });
      return openWhole(send, file, window, total, etag);
    }
  }

  /** Outside a browser: `Content-Range` for the length, `If-Range` for identity. */
  async function openConditional(
    send: Send,
    file: File,
    window: { start: number; end: number | undefined },
    resumeEtag: string | undefined,
  ): Promise<Opened | Changed> {
    const first = segmentOf(window.start);
    const ifRange = isStrongEtag(resumeEtag) ? resumeEtag : undefined;
    // The header and the first segments arrive in one request when the
    // window starts in segment 0; the host clamps a range past the end.
    const to =
      first !== 0
        ? headerLength - 1
        : window.end === undefined
          ? undefined
          : segmentExtent(segmentOf(Math.max(window.end - 1, 0))).end - 1;
    const answer = await send({
      method: "GET",
      kind: first === 0 ? "segments" : "header",
      range: { from: 0, ...(to === undefined ? {} : { to }) },
      ...(ifRange === undefined ? {} : { ifRange }),
    });
    const checked = checkRanged(answer, {
      from: 0,
      to,
      total: undefined,
      etag: resumeEtag,
      ifRangeSent: ifRange !== undefined,
      corsSafe: false,
    });
    if (isChanged(checked)) return checked;
    const total = checked.total;
    if (total === undefined) throw httpError(answer.status, "no total length");
    const header = await answer.body.readExactly(Math.min(headerLength, total));
    const plan = planWindow(total, window);
    const decryptor = await bundleCrypto().openDecryptor(
      header,
      total,
      file.ad,
    );
    if (first === 0 && plan.first === 0) {
      return { decryptor, etag: checked.etag, ...plan, body: answer.body };
    }
    return openSegments(send, decryptor, plan, total, checked.etag);
  }

  /** In a browser: only `Range` crosses, and each answer's `ETag` is compared. */
  async function openSafelisted(
    send: Send,
    file: File,
    window: { start: number; end: number | undefined },
    total: number,
    etag: string | undefined,
  ): Promise<Opened | Changed> {
    const plan = planWindow(total, window);
    const to = plan.first === 0 ? segmentExtent(plan.last, total).end - 1 : 39;
    const answer = await send({
      method: "GET",
      kind: plan.first === 0 ? "segments" : "header",
      range: { from: 0, to },
    });
    const checked = checkRanged(answer, {
      from: 0,
      to,
      total,
      etag,
      ifRangeSent: false,
      corsSafe: true,
    });
    if (isChanged(checked)) return checked;
    const header = await answer.body.readExactly(Math.min(headerLength, total));
    const decryptor = await bundleCrypto().openDecryptor(
      header,
      total,
      file.ad,
    );
    if (plan.first === 0) {
      return { decryptor, etag, ...plan, body: answer.body };
    }
    return openSegments(send, decryptor, plan, total, etag);
  }

  /** The ranged request for segments `first … last`, after the header. */
  async function openSegments(
    send: Send,
    decryptor: Decryptor,
    plan: ReturnType<typeof planWindow>,
    total: number,
    etag: string | undefined,
  ): Promise<Opened | Changed> {
    const from = segmentExtent(plan.first, total).start;
    const to = segmentExtent(plan.last, total).end - 1;
    const ifRange = !corsSafe && isStrongEtag(etag) ? etag : undefined;
    const answer = await send({
      method: "GET",
      kind: "segments",
      range: { from, to },
      ...(ifRange === undefined ? {} : { ifRange }),
    });
    const checked = checkRanged(answer, {
      from,
      to,
      total,
      etag,
      ifRangeSent: ifRange !== undefined,
      corsSafe,
    });
    if (isChanged(checked)) return checked;
    return { decryptor, etag, ...plan, body: answer.body };
  }

  /**
   * The fallback when `Range` cannot be sent: one plain GET, the segments
   * before the window read and dropped unreleased, then the window verified
   * as usual.
   */
  async function openWhole(
    send: Send,
    file: File,
    window: { start: number; end: number | undefined },
    total: number,
    etag: string | undefined,
  ): Promise<Opened | Changed> {
    const answer = await send({ method: "GET", kind: "whole" });
    if (answer.status !== 200) throw httpError(answer.status);
    if (etag !== undefined && answer.etag !== etag) {
      return changed(answer.status);
    }
    const plan = planWindow(total, window);
    const header = await answer.body.readExactly(Math.min(headerLength, total));
    const decryptor = await bundleCrypto().openDecryptor(
      header,
      total,
      file.ad,
    );
    const target = segmentExtent(plan.first, total).start;
    for (let at = headerLength; at < target;) {
      const step = Math.min(segmentSize, target - at);
      await answer.body.readExactly(step);
      at += step;
    }
    return { decryptor, etag, ...plan, body: answer.body };
  }

  /**
   * Verifies and emits the opened window segment by segment: one segment in
   * memory at a time, and no byte of it before its tag verified.
   */
  async function emitSegments(
    opened: Opened,
    emit: (chunk: Uint8Array) => Promise<void>,
  ): Promise<void> {
    const { decryptor, body } = opened;
    try {
      for (let i = opened.first; i <= opened.last; i += 1) {
        const { start, end } = segmentExtent(i, decryptor.total);
        const plain = await decryptor.open(
          i,
          await body.readExactly(end - start),
        );
        const at = plainStart(i);
        const lo = Math.max(opened.start - at, 0);
        const hi = Math.min(opened.end - at, plain.length);
        if (lo < hi) await emit(plain.subarray(lo, hi));
      }
    } finally {
      await body.cancel();
    }
  }

  async function readEncryptedRange(
    file: File,
    window: { start: number; end: number | undefined },
    cache: AssetCacheMode | undefined,
  ): Promise<Uint8Array> {
    let chunks: Uint8Array[] = [];
    return restarting(
      file,
      async () => {
        const opened = await openEncrypted(file, window, undefined, cache);
        if (isChanged(opened)) return opened;
        await emitSegments(opened, (chunk) => {
          chunks.push(chunk);
          return Promise.resolve();
        });
        return concat(chunks);
      },
      () => {
        chunks = [];
      },
    );
  }

  async function readWhole(
    file: File,
    cache: AssetCacheMode | undefined,
  ): Promise<Uint8Array> {
    const answer = await request(file.url, file.path, {
      method: "GET",
      kind: "whole",
      cache,
    });
    try {
      if (answer.status !== 200) throw httpError(answer.status);
      if (!encrypted) return await answer.body.rest();
      // Refuse a length no ciphertext has before holding any of it, and stop
      // reading an unsized body once it has passed the largest one.
      if (
        !answer.encoded &&
        answer.length !== undefined &&
        segmentsOf(answer.length) === undefined
      ) {
        throw corrupt(answer.status);
      }
      const chunks: Uint8Array[] = [];
      let size = 0;
      for (;;) {
        const chunk = await answer.body.next();
        if (chunk === undefined) break;
        size += chunk.length;
        if (size > maxCiphertext) throw corrupt(answer.status);
        chunks.push(chunk);
      }
      const ciphertext = concat(chunks);
      const total = ciphertext.length;
      const decryptor = await bundleCrypto().openDecryptor(
        ciphertext.subarray(0, Math.min(headerLength, total)),
        total,
        file.ad,
      );
      const out = new Uint8Array(decryptor.plaintextLength);
      for (let i = 0; i < decryptor.segments; i += 1) {
        const { start, end } = segmentExtent(i, total);
        out.set(
          await decryptor.open(i, ciphertext.subarray(start, end)),
          plainStart(i),
        );
      }
      return out;
    } finally {
      await answer.body.cancel();
    }
  }

  async function readPlainRange(
    file: File,
    start: number,
    end: number | undefined,
    cache: AssetCacheMode | undefined,
  ): Promise<Uint8Array> {
    const to = end === undefined ? undefined : end - 1;
    let answer: Answer;
    try {
      answer = await request(file.url, file.path, {
        method: "GET",
        kind: "range",
        range: { from: start, ...(to === undefined ? {} : { to }) },
        cache,
      });
    } catch (error) {
      if (!corsSafe || !isFetchRejection(error)) throw error;
      logger.warn("asset ranged request refused; reading the whole file", {
        path: file.path,
      });
      answer = await request(file.url, file.path, {
        method: "GET",
        kind: "whole",
        cache,
      });
    }
    try {
      if (answer.status === 416) return new Uint8Array(0);
      if (answer.status === 200) {
        // `Range` was ignored or never sent: this is the whole file.
        return (await answer.body.rest()).slice(start, end);
      }
      const range = answer.range;
      if (range === undefined && !corsSafe) {
        throw httpError(answer.status, "no Content-Range");
      }
      if (
        range !== undefined &&
        (range.start !== start ||
          (range.total !== undefined &&
            range.end !== Math.min(to ?? range.total - 1, range.total - 1)))
      ) {
        throw httpError(
          answer.status,
          "Content-Range is not the range asked for",
        );
      }
      const bytes = await answer.body.rest();
      const expected =
        range === undefined ? undefined : range.end - range.start + 1;
      if (expected !== undefined && bytes.length < expected) {
        throw createAssetClientError({
          code: "network",
          status: answer.status,
          detail: "the body ended early",
        });
      }
      return bytes.subarray(
        0,
        Math.min(
          bytes.length,
          expected ?? bytes.length,
          (end ?? Infinity) - start,
        ),
      );
    } finally {
      await answer.body.cancel();
    }
  }

  async function downloadEncrypted(
    file: File,
    options: AssetDownloadOptions,
    offset: number,
    resumeEtag: string | undefined,
  ): Promise<AssetDownloadResult> {
    const { sink, onProgress, cache } = options;
    let written = offset;
    return restarting(
      file,
      async () => {
        const opened = await openEncrypted(
          file,
          { start: written, end: undefined },
          resumeEtag,
          cache,
        );
        if (isChanged(opened)) return opened;
        const total = opened.decryptor.plaintextLength;
        const overshot = written > total;
        let reported = false;
        const report = () => {
          reported = true;
          onProgress?.({
            written,
            total,
            ...(opened.etag === undefined ? {} : { etag: opened.etag }),
          });
        };
        await emitSegments(opened, async (chunk) => {
          await sink.write(chunk);
          written += chunk.length;
          report();
        });
        // Only now is the length authenticated (the last segment verified),
        // so only now can an offset past it be the caller's mistake.
        if (overshot) {
          throw new RangeError(
            "asset resume offset is past the end of the file",
          );
        }
        // An empty file, or a resume that was already complete: nothing was
        // written, and the caller still hears that the download is whole.
        if (!reported) report();
        return {
          bytes: total,
          ...(opened.etag === undefined ? {} : { etag: opened.etag }),
        };
      },
      async () => {
        if (written > 0) await sink.reset();
        written = 0;
        resumeEtag = undefined;
      },
    );
  }

  async function downloadPlain(
    file: File,
    options: AssetDownloadOptions,
    offset: number,
    resumeEtag: string | undefined,
  ): Promise<AssetDownloadResult> {
    const { sink, onProgress, cache } = options;
    let written = offset;
    const whole = () =>
      request(file.url, file.path, { method: "GET", kind: "whole", cache });

    async function attempt(): Promise<AssetDownloadResult | Changed> {
      const resuming = written > 0 && resumeEtag !== undefined;
      const ifRange =
        resuming && !corsSafe && isStrongEtag(resumeEtag)
          ? resumeEtag
          : undefined;
      let answer: Answer;
      if (!resuming) {
        answer = await whole();
      } else {
        try {
          answer = await request(file.url, file.path, {
            method: "GET",
            kind: "range",
            range: { from: written },
            ...(ifRange === undefined ? {} : { ifRange }),
            cache,
          });
        } catch (error) {
          if (!corsSafe || !isFetchRejection(error)) throw error;
          logger.warn("asset ranged request refused; reading the whole file", {
            path: file.path,
          });
          answer = await whole();
        }
      }
      try {
        return await consume(answer, ifRange !== undefined);
      } finally {
        await answer.body.cancel();
      }
    }

    async function consume(
      answer: Answer,
      ifRangeSent: boolean,
    ): Promise<AssetDownloadResult | Changed> {
      let total: number | undefined;
      if (answer.status === 416) {
        // Nothing at or after the offset. Under a matching `If-Range` whose
        // stated length is the offset, the earlier download was complete;
        // anything else is another object, read afresh.
        if (ifRangeSent && answer.unsatisfiedTotal === written) {
          const etag = resumeEtag as string;
          onProgress?.({ written, total: written, etag });
          return { bytes: written, etag };
        }
        return changed(answer.status);
      }
      if (answer.status === 206) {
        // Without `If-Range` only the answer's own `ETag` names the object.
        if (
          answer.etag !== resumeEtag &&
          (answer.etag !== undefined || !ifRangeSent)
        ) {
          return changed(answer.status);
        }
        const range = answer.range;
        if (range === undefined && !corsSafe) {
          throw httpError(answer.status, "no Content-Range");
        }
        if (range !== undefined && range.start !== written) {
          throw httpError(
            answer.status,
            "Content-Range is not the range asked for",
          );
        }
        total =
          range?.total ??
          (answer.length === undefined || answer.encoded
            ? undefined
            : written + answer.length);
      } else {
        // A 200 is the whole file: under `If-Range` the object changed, and
        // without it the host ignored `Range`.
        if (written > 0) await sink.reset();
        written = 0;
        // A browser cannot see `Content-Encoding` cross-origin, so there a
        // `Content-Length` may be the compressed size: no total at all.
        total = answer.encoded || corsSafe ? undefined : answer.length;
      }
      const etag = answer.etag ?? resumeEtag;
      const report = () =>
        onProgress?.({
          written,
          ...(total === undefined ? {} : { total }),
          ...(etag === undefined ? {} : { etag }),
        });
      let reported = false;
      for (;;) {
        const chunk = await answer.body.next();
        if (chunk === undefined) break;
        if (total !== undefined && written + chunk.length > total) {
          throw createAssetClientError({
            code: "network",
            status: answer.status,
            detail: "the body ran past its stated length",
          });
        }
        await sink.write(chunk);
        written += chunk.length;
        reported = true;
        report();
      }
      if (total !== undefined && written !== total) {
        throw createAssetClientError({
          code: "network",
          status: answer.status,
          detail: "the body ended early",
        });
      }
      if (!reported) report();
      return { bytes: written, ...(etag === undefined ? {} : { etag }) };
    }

    return restarting(file, attempt, async () => {
      if (written > 0) await sink.reset();
      written = 0;
      resumeEtag = undefined;
    });
  }

  return {
    async read(path, options: AssetReadOptions = {}) {
      return readWhole(fileOf(path), options.cache);
    },
    async readJson<T>(
      path: string,
      options: AssetReadOptions = {},
    ): Promise<T> {
      const bytes = await readWhole(fileOf(path), options.cache);
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        throw corrupt();
      }
      try {
        return JSON.parse(text) as T;
      } catch {
        // Not attached as `cause`: `SyntaxError` quotes the plaintext.
        throw corrupt();
      }
    },
    async readRange(path, options: AssetRangeOptions) {
      const file = fileOf(path);
      const start = checkOffset(options.start, "range start");
      const end =
        options.end === undefined
          ? undefined
          : checkOffset(options.end, "range end");
      if (end !== undefined && end <= start) return new Uint8Array(0);
      return encrypted
        ? readEncryptedRange(file, { start, end }, options.cache)
        : readPlainRange(file, start, end, options.cache);
    },
    async download(path, options: AssetDownloadOptions) {
      const file = fileOf(path);
      const { resume } = options;
      let offset = 0;
      let resumeEtag: string | undefined;
      if (resume !== undefined) {
        offset = checkOffset(resume.offset, "resume offset");
        if (typeof resume.etag !== "string" || resume.etag === "") {
          throw new RangeError("asset resume etag must be a non-empty string");
        }
        resumeEtag = resume.etag;
      }
      return encrypted
        ? downloadEncrypted(file, options, offset, resumeEtag)
        : downloadPlain(file, options, offset, resumeEtag);
    },
    close() {
      closed = true;
      crypto?.close();
      crypto = undefined;
    },
  };
}

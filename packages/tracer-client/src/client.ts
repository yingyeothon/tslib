import type { Logger } from "@yingyeothon/logger";
import { nullLogger } from "@yingyeothon/logger";
import { parseTracerDsn } from "./dsn.js";
import {
  createAbort,
  gzip,
  gzipAvailable,
  secureRandomBytes,
  startTimer,
  stopTimer,
} from "./runtime.js";
import { exceptionOf } from "./stack.js";
import type {
  TracerBreadcrumbOptions,
  TracerClient,
  TracerClientOptions,
  TracerDsn,
  TracerFeedbackOptions,
  TracerFetchLike,
  TracerFetchResponse,
  TracerFlushOptions,
  TracerLevel,
  TracerReportOptions,
  TracerState,
  TracerStats,
} from "./types.js";
import type { WireItem } from "./wire.js";
import {
  checkLevel,
  clipUtf8,
  concat,
  encodeEnvelope,
  epochSeconds,
  hexId,
  itemOverhead,
  jsonBytes,
  jsonSafe,
  logContentType,
  logLevel,
  rfc3339,
  sdkInfo,
  severityNumber,
  text,
  tracerLimits,
  tracerSdkVersion,
  typedAttribute,
  utf8,
} from "./wire.js";

/** First back-off after a failed send; doubles up to `maxBackoffMillis`. */
const baseBackoffMillis = 1000;
const maxBackoffMillis = 5 * 60 * 1000;
/** The ingest's quota refusal says 300 s; used when a 429 has no usable `Retry-After`. */
const defaultQuotaWaitMillis = 300 * 1000;
/** The longest `Retry-After` honoured. */
const maxRetryAfterMillis = 24 * 60 * 60 * 1000;
/** Tag bytes repeated as attributes on each log line. */
const maxTagAttributeBytes = 8 * 1024;
/** A `keepalive` body must fit the browser's 64 KiB in-flight budget. */
const maxKeepaliveBytes = 60 * 1024;

interface Queued {
  body: Uint8Array;
  kind: "event" | "feedback" | "log";
  /** `503` answers for this envelope since any other answer. */
  refusals: number;
}

/** `503` answers in a row after which an envelope is dropped (`send_failed`). */
const maxRefusals = 3;

/** After one attempt: keep the envelope at the head, and how long to wait. */
interface Outcome {
  keep: boolean;
  waitMillis: number;
}

const done: Outcome = { keep: false, waitMillis: 0 };

function nonEmpty(value: string | undefined): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function clampInt(value: unknown, min: number, max: number, fallback: number) {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(max, Math.max(min, Math.floor(value)))
    : fallback;
}

function resolveFetch(
  injected: TracerFetchLike | undefined,
): TracerFetchLike | undefined {
  if (injected !== undefined) return injected;
  const global = (globalThis as { fetch?: TracerFetchLike }).fetch;
  return typeof global === "function" ? global.bind(globalThis) : undefined;
}

/** `Retry-After` in milliseconds; zero, negative or junk is treated as absent. */
function retryAfter(header: string | null | undefined): number | undefined {
  if (typeof header !== "string" || !/^\s*\d+\s*$/.test(header)) {
    return undefined;
  }
  const seconds = Number(header);
  // Zero would resend at once, forever.
  if (!(seconds > 0)) return undefined;
  return Math.min(seconds * 1000, maxRetryAfterMillis);
}

/**
 * Builds a tracer client. A DSN that is empty or does not parse gives a
 * client whose `state` is `off`; nothing throws.
 */
export function createTracerClient(options: TracerClientOptions): TracerClient {
  try {
    return buildClient(options ?? { dsn: "" });
  } catch {
    // Options that throw on access (getters, proxies): an off client.
    return buildClient({ dsn: "" });
  }
}

function buildClient(options: TracerClientOptions): TracerClient {
  const logger: Logger = options.logger ?? nullLogger;
  const now = options.now ?? Date.now;
  const randomBytes = options.randomBytes ?? secureRandomBytes;
  const breadcrumbCapacity = clampInt(
    options.breadcrumbCapacity,
    0,
    tracerLimits.maxBreadcrumbs,
    tracerLimits.maxBreadcrumbs,
  );
  const logBatchSize = clampInt(
    options.logBatchSize,
    1,
    tracerLimits.maxLogsPerContainer,
    100,
  );
  const flushIntervalMillis = clampInt(
    options.flushIntervalMillis,
    0,
    maxRetryAfterMillis,
    5000,
  );
  const maxQueuedEnvelopes = clampInt(
    options.maxQueuedEnvelopes,
    1,
    10_000,
    32,
  );
  const maxQueuedBytes = clampInt(
    options.maxQueuedBytes,
    0,
    Number.MAX_SAFE_INTEGER,
    48 * 1024 * 1024,
  );
  const timeoutMillis = clampInt(
    options.timeoutMillis,
    1,
    maxRetryAfterMillis,
    30_000,
  );
  const corsSafe = options.corsSafe === true;
  let compress = options.compress !== false && !corsSafe && gzipAvailable();
  const platform = nonEmpty(options.platform) ?? "javascript";
  const release = nonEmpty(options.release);
  const dist = nonEmpty(options.dist);
  const environment = nonEmpty(options.environment);
  const userId = nonEmpty(options.userId);
  const tags = new Map<string, string>();
  for (const [k, v] of Object.entries(options.tags ?? {})) {
    if (tags.size >= tracerLimits.maxTags) break;
    if (typeof v === "string") tags.set(clipUtf8(k, 200), clipUtf8(v, 200));
  }
  const contexts = (() => {
    const safe = jsonSafe(options.contexts ?? {});
    const out: Record<string, unknown> = {};
    if (typeof safe !== "object" || safe === null || Array.isArray(safe)) {
      return out;
    }
    // Every event repeats them: keep whole contexts while they fit 16 KiB.
    let size = 2;
    for (const [k, v] of Object.entries(safe as Record<string, unknown>)) {
      const add = jsonBytes({ [k]: v }).length;
      if (size + add > tracerLimits.maxDataBytes) continue;
      out[k] = v;
      size += add;
    }
    return out;
  })();
  const deviceModel = (() => {
    const device = contexts["device"] as { model?: unknown } | undefined;
    return typeof device?.model === "string" && device.model !== ""
      ? clipUtf8(device.model, 200)
      : undefined;
  })();

  let traceId: string;
  try {
    traceId = hexId(randomBytes, 16);
  } catch {
    traceId = hexId(secureRandomBytes, 16);
  }
  let lastLogMillis = Number.NaN;
  let sameMillis = 0;
  /**
   * Float seconds with a per-millisecond counter in the microseconds: the
   * ingest keys a log line by its bytes, so two equal lines in one
   * millisecond must still differ.
   */
  const logTimestamp = () => {
    const millis = now();
    sameMillis = millis === lastLogMillis ? sameMillis + 1 : 0;
    lastLogMillis = millis;
    return epochSeconds(millis + Math.min(sameMillis, 999) / 1000);
  };
  let state: TracerState = "off";
  let dsn: TracerDsn | undefined;
  let fetchFn: TracerFetchLike | undefined;
  let url = "";
  let authHeader = "";

  const breadcrumbs: Record<string, unknown>[] = [];
  let logs: Uint8Array[] = [];
  let logBytes = 0;
  let logTimer: unknown;

  const queue: Queued[] = [];
  let queuedBytes = 0;
  let sending = false;
  let resumeTimer: unknown;
  let failures = 0;
  let idleWaiters: (() => void)[] = [];
  const inFlight = new Set<{ abort(): void }>();

  let sent = 0;
  let unconfirmed = 0;
  const dropped: Record<string, number> = {};
  let inDiag = false;

  const drop = (reason: string, count = 1) => {
    if (count > 0) dropped[reason] = (dropped[reason] ?? 0) + count;
  };

  /** The client's own diagnostics; a broken writer is not the tracer's to report. */
  const diag = (
    severity: "debug" | "info" | "warn",
    message: string,
    context?: Record<string, unknown>,
  ) => {
    if (inDiag) return;
    inDiag = true;
    try {
      if (context === undefined) logger[severity](message);
      else logger[severity](message, context);
    } catch {
      // ignored
    } finally {
      inDiag = false;
    }
  };

  /**
   * Runs `body` unless the client is not active or is re-entered from its
   * own logger (a sink fed by the logger the client writes to), and turns
   * any failure into a count.
   */
  const guard = <T>(body: () => T): T | undefined => {
    if (state !== "active" || inDiag) return undefined;
    try {
      return body();
    } catch (error) {
      drop("internal");
      diag("warn", "tracer internal error", {
        type: error instanceof Error ? error.name : typeof error,
      });
      return undefined;
    }
  };

  const baseAttributes = (): Record<string, unknown> => {
    const str = (value: string) => ({ value, type: "string" });
    const attrs: Record<string, unknown> = {
      "sentry.sdk.name": str(sdkInfo.name),
      "sentry.sdk.version": str(tracerSdkVersion),
    };
    if (release !== undefined) attrs["sentry.release"] = str(release);
    if (environment !== undefined) {
      attrs["sentry.environment"] = str(environment);
    }
    if (dist !== undefined) attrs["sentry.dist"] = str(dist);
    if (userId !== undefined) attrs["user.id"] = str(userId);
    if (deviceModel !== undefined) attrs["device.model"] = str(deviceModel);
    // Tags repeat on every line; past 8 KiB they stay on events only, so a
    // line's own attributes keep room under the 16 KiB cap.
    let size = 0;
    for (const [k, v] of tags) {
      size += k.length + v.length + 32;
      if (size > maxTagAttributeBytes) break;
      attrs[k] = str(v);
    }
    return attrs;
  };

  /** `data` as is when its JSON fits what the ingest keeps, else a marker. */
  const capData = (data: unknown): unknown =>
    data !== null &&
    data !== undefined &&
    jsonBytes(data).length > tracerLimits.maxDataBytes
      ? { "tracer.truncated": true }
      : data;

  const isRecord = (v: unknown): v is Record<string, unknown> =>
    typeof v === "object" && v !== null && !Array.isArray(v);

  const eventBase = (eventId: string, level: TracerLevel) => {
    const event: Record<string, unknown> = {
      event_id: eventId,
      timestamp: rfc3339(now()),
      platform,
      level,
    };
    if (release !== undefined) event["release"] = release;
    if (dist !== undefined) event["dist"] = dist;
    if (environment !== undefined) event["environment"] = environment;
    if (tags.size > 0) event["tags"] = Object.fromEntries(tags);
    if (userId !== undefined) event["user"] = { id: userId };
    return event;
  };

  const eventContexts = (own: Record<string, unknown>) => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(contexts)) {
      if (k !== "trace" && k !== "feedback") out[k] = v;
    }
    out["trace"] = { trace_id: traceId, span_id: hexId(randomBytes, 8) };
    return { ...out, ...own };
  };

  /**
   * The event payload, trimmed under the JSON item cap: oldest breadcrumbs
   * first, then `extra`, then the exception. `undefined` when it still does
   * not fit (its attachments would be stored without an event).
   */
  const eventPayload = (
    event: Record<string, unknown>,
  ): Uint8Array | undefined => {
    const cap = tracerLimits.maxJsonItemBytes - itemOverhead;
    let payload = jsonBytes(event);
    const crumbs = (event["breadcrumbs"] as { values?: unknown[] } | undefined)
      ?.values;
    while (payload.length > cap && crumbs !== undefined && crumbs.length > 0) {
      crumbs.splice(0, Math.ceil(crumbs.length / 2));
      payload = jsonBytes(event);
    }
    for (const key of ["extra", "exception"]) {
      if (payload.length <= cap) break;
      delete event[key];
      payload = jsonBytes(event);
    }
    return payload.length <= cap ? payload : undefined;
  };

  const envelope = (eventId: string | undefined, items: WireItem[]) =>
    encodeEnvelope(
      eventId === undefined
        ? { sent_at: rfc3339(now()), sdk: sdkInfo }
        : { event_id: eventId, sent_at: rfc3339(now()), sdk: sdkInfo },
      items,
    );

  const recountLogs = () => {
    logBytes = 0;
    for (const e of logs) logBytes += e.length + 1;
  };

  const cancelLogTimer = () => {
    stopTimer(logTimer);
    logTimer = undefined;
  };

  /**
   * One log container from the oldest buffered lines that fit `budget`
   * bytes (and the per-item caps); `undefined` when nothing fits.
   */
  const takeLogs = (budget: number): WireItem | undefined => {
    const cap = Math.min(budget, tracerLimits.maxJsonItemBytes) - itemOverhead;
    let size = '{"items":[]}'.length;
    let n = 0;
    while (
      n < logs.length &&
      n < tracerLimits.maxLogsPerContainer &&
      size + (logs[n] as Uint8Array).length + 1 <= cap
    ) {
      size += (logs[n] as Uint8Array).length + 1;
      n++;
    }
    if (n === 0) return undefined;
    const taken = logs.slice(0, n);
    logs = logs.slice(n);
    recountLogs();
    if (logs.length === 0) cancelLogTimer();
    const parts: Uint8Array[] = [utf8('{"items":[')];
    taken.forEach((entry, i) => {
      if (i > 0) parts.push(utf8(","));
      parts.push(entry);
    });
    parts.push(utf8("]}"));
    return {
      header: {
        type: "log",
        item_count: taken.length,
        content_type: logContentType,
      },
      payload: concat(parts),
    };
  };

  const trimQueue = () => {
    while (
      queue.length > 1 &&
      (queue.length > maxQueuedEnvelopes || queuedBytes > maxQueuedBytes)
    ) {
      queuedBytes -= (queue.shift() as Queued).body.length;
      drop("queue_full");
    }
  };

  const enqueue = (body: Uint8Array, kind: Queued["kind"]) => {
    queue.push({ body, kind, refusals: 0 });
    queuedBytes += body.length;
    trimQueue();
  };

  /** Moves every buffered log line into envelopes of their own. */
  const flushLogs = () => {
    cancelLogTimer();
    while (logs.length > 0) {
      const item = takeLogs(tracerLimits.maxJsonItemBytes);
      if (item === undefined) {
        // A single line over the cap cannot be sent.
        logs = logs.slice(1);
        recountLogs();
        drop("too_large");
        continue;
      }
      enqueue(envelope(undefined, [item]), "log");
    }
  };

  const settleIdle = () => {
    if (sending) return;
    const waiters = idleWaiters;
    idleWaiters = [];
    for (const w of waiters) w();
  };

  const paused = () => resumeTimer !== undefined;

  const backoff = (): number => {
    const shift = Math.min(failures, 9);
    failures++;
    const millis = Math.min(baseBackoffMillis * 2 ** shift, maxBackoffMillis);
    let jitter = 1;
    try {
      jitter = ((randomBytes(1)[0] ?? 255) / 255) * 0.5 + 0.5;
    } catch {
      // a broken random source still backs off
    }
    return Math.round(millis * jitter);
  };

  const pause = (waitMillis: number) => {
    stopTimer(resumeTimer);
    resumeTimer = startTimer(() => {
      resumeTimer = undefined;
      kick();
    }, waitMillis);
  };

  const shutdown = () => {
    cancelLogTimer();
    stopTimer(resumeTimer);
    resumeTimer = undefined;
    drop("closed", logs.length);
    logs = [];
    logBytes = 0;
    breadcrumbs.length = 0;
  };

  /** The ingest refused the key: everything held is undeliverable. */
  const stop = () => {
    if (state !== "active") return;
    state = "stopped";
    diag("warn", "tracer stopped: the ingest refused the key", {
      resource: dsn?.resourceId,
    });
    drop("unauthorized", queue.length + logs.length);
    queue.length = 0;
    queuedBytes = 0;
    logs = [];
    logBytes = 0;
    shutdown();
  };

  const exchange = async (
    item: Queued,
    useGzip: boolean,
    keepalive: boolean,
  ): Promise<TracerFetchResponse> => {
    const abort = createAbort();
    if (abort !== undefined) inFlight.add(abort);
    // The deadline covers compression too: a stream that never settles must
    // not hold the queue forever.
    const deadline =
      timeoutMillis + Math.floor(item.body.length / 65536) * 1000;
    let timer: unknown;
    const timeout = new Promise<never>((_, reject) => {
      timer = startTimer(() => {
        abort?.abort();
        reject(new Error("tracer request timed out"));
      }, deadline);
    });
    // A rejection nobody awaits any more must not become unhandled.
    timeout.catch(() => undefined);
    try {
      let body = item.body;
      if (useGzip) {
        try {
          body = await Promise.race([gzip(item.body), timeout]);
        } catch (error) {
          // A runtime whose gzip fails (or hangs) sends plain from now on.
          compress = false;
          throw error;
        }
      }
      const headers: Record<string, string> = corsSafe
        ? { "Content-Type": "text/plain;charset=UTF-8" }
        : {
            "Content-Type": "application/x-sentry-envelope",
            "X-Sentry-Auth": authHeader,
          };
      if (useGzip) headers["Content-Encoding"] = "gzip";
      const request = (fetchFn as TracerFetchLike)(url, {
        method: "POST",
        headers,
        body,
        mode: corsSafe ? "no-cors" : "cors",
        // `no-cors` refuses anything but `follow` (a TypeError before any
        // request); elsewhere a redirect is refused, so the key in
        // `X-Sentry-Auth` never travels to another host.
        redirect: corsSafe ? "follow" : "manual",
        ...(keepalive && body.length <= maxKeepaliveBytes
          ? { keepalive: true }
          : {}),
        ...(abort !== undefined ? { signal: abort.signal } : {}),
      });
      const response = await Promise.race([request, timeout]);
      // The answer is `{"id"}` or `{"detail"}`; nothing in it is needed.
      if (typeof response?.arrayBuffer === "function") {
        await Promise.race([
          Promise.resolve()
            .then(() => response.arrayBuffer())
            .catch(() => undefined),
          timeout,
        ]);
      }
      return response;
    } finally {
      stopTimer(timer);
      if (abort !== undefined) inFlight.delete(abort);
    }
  };

  const header = (response: TracerFetchResponse, name: string) => {
    try {
      return response.headers.get(name);
    } catch {
      return null;
    }
  };

  /** Sends one envelope; says whether to keep it and how long to wait. */
  const send = async (item: Queued, unloading = false): Promise<Outcome> => {
    const useGzip = compress && !unloading;
    let response: TracerFetchResponse;
    try {
      response = await exchange(item, useGzip, corsSafe || unloading);
    } catch (error) {
      if (state !== "active") {
        drop("closed");
        return done;
      }
      // Not an answer: the refusal count neither grows nor restarts.
      const waitMillis = backoff();
      diag("debug", "tracer send failed", {
        type: error instanceof Error ? error.name : typeof error,
        kind: item.kind,
        retryMs: waitMillis,
      });
      return { keep: true, waitMillis };
    }
    if (state !== "active") {
      // Answered after close(): nothing may change any more.
      drop("closed");
      return done;
    }
    const status = typeof response?.status === "number" ? response.status : -1;
    const type = typeof response?.type === "string" ? response.type : "";
    diag("debug", "tracer envelope", {
      kind: item.kind,
      status,
      bytes: item.body.length,
    });
    if (type === "opaqueredirect" || (status >= 300 && status < 400)) {
      drop("redirect");
      return done;
    }
    if (status === 0 || type === "opaque") {
      // A `no-cors` answer: sent, outcome unknown.
      unconfirmed++;
      failures = 0;
      return done;
    }
    if (status >= 200 && status < 300) {
      sent++;
      failures = 0;
      return done;
    }
    item.refusals = status === 503 ? item.refusals + 1 : 0;
    const after = () => retryAfter(header(response, "retry-after"));
    switch (status) {
      case 401:
        drop("unauthorized");
        stop();
        return done;
      case 429:
        return { keep: true, waitMillis: after() ?? defaultQuotaWaitMillis };
      case 400:
        drop("invalid");
        return done;
      case 413:
        drop("too_large");
        return done;
      case 415:
        if (useGzip) {
          compress = false;
          return { keep: true, waitMillis: 0 };
        }
        drop("encoding");
        return done;
    }
    if (status >= 500) {
      const waitMillis = after() ?? backoff();
      if (item.refusals < maxRefusals) return { keep: true, waitMillis };
      // Refused again and again (a body too slow for the ingest's pacing on
      // a bad link): give it up so newer envelopes get through, and still
      // wait as told.
      drop("send_failed");
      diag("warn", "tracer envelope dropped after refusals", {
        kind: item.kind,
        status,
        bytes: item.body.length,
      });
      return { keep: false, waitMillis };
    }
    drop(`http_${status}`);
    return done;
  };

  const requeue = (item: Queued) => {
    queue.unshift(item);
    queuedBytes += item.body.length;
    trimQueue();
  };

  const run = async () => {
    try {
      while (queue.length > 0 && !paused() && state === "active") {
        const next = queue.shift() as Queued;
        queuedBytes -= next.body.length;
        const outcome = await send(next);
        if (state !== "active") break;
        if (outcome.keep) requeue(next);
        if (outcome.waitMillis > 0) pause(outcome.waitMillis);
      }
    } catch (error) {
      drop("internal");
      diag("warn", "tracer send loop failed", {
        type: error instanceof Error ? error.name : typeof error,
      });
    } finally {
      sending = false;
      settleIdle();
    }
  };

  function kick() {
    if (sending || paused() || state !== "active" || queue.length === 0) {
      settleIdle();
      return;
    }
    sending = true;
    void run();
  }

  /**
   * The page is going away: start every queued envelope that fits the
   * browser's `keepalive` budget at once (the loop would send one, and a
   * back-off would send none), oldest first.
   */
  const sendUnloading = () => {
    let budget = maxKeepaliveBytes;
    for (const item of [...queue]) {
      if (item.body.length > budget) continue;
      budget -= item.body.length;
      queue.splice(queue.indexOf(item), 1);
      queuedBytes -= item.body.length;
      void send(item, true).then(
        (outcome) => {
          if (outcome.keep && state === "active") requeue(item);
        },
        () => drop("internal"),
      );
    }
  };

  // ---- construction --------------------------------------------------------

  if (typeof options.dsn === "string" && options.dsn.trim() !== "") {
    dsn = parseTracerDsn(options.dsn, {
      allowHttpLoopback: options.allowHttpLoopback === true,
    });
    fetchFn = resolveFetch(options.fetch);
    if (dsn === undefined) {
      diag("warn", "tracer off: DSN did not parse");
    } else if (fetchFn === undefined) {
      diag("warn", "tracer off: no fetch in this runtime");
    } else {
      const client = `yyt-ts/${tracerSdkVersion}`;
      authHeader = `Sentry sentry_key=${dsn.writeKey}, sentry_version=7, sentry_client=${client}`;
      url = corsSafe
        ? `${dsn.envelopeUrl}?sentry_key=${encodeURIComponent(dsn.writeKey)}&sentry_version=7&sentry_client=${encodeURIComponent(client)}`
        : dsn.envelopeUrl;
      state = "active";
      diag("info", "tracer active", { resource: dsn.resourceId, corsSafe });
    }
  }

  // ---- public surface ------------------------------------------------------

  const breadcrumb = (
    category: string,
    message: string,
    options?: TracerBreadcrumbOptions,
  ) => {
    guard(() => {
      if (breadcrumbCapacity === 0) return;
      const opts = options ?? {};
      const data =
        opts.data === undefined ? undefined : capData(jsonSafe(opts.data));
      const crumb: Record<string, unknown> = {
        timestamp: rfc3339(now()),
        type: "default",
        category: clipUtf8(text(category), 200),
        level: checkLevel(opts.level, "info"),
        message: clipUtf8(text(message), tracerLimits.maxTextBytes),
      };
      if (isRecord(data) && Object.keys(data).length > 0) crumb["data"] = data;
      breadcrumbs.push(crumb);
      while (breadcrumbs.length > breadcrumbCapacity) breadcrumbs.shift();
    });
  };

  const log = (
    level: TracerLevel,
    message: string,
    attributes?: Record<string, unknown>,
  ) => {
    guard(() => {
      const lvl = checkLevel(level, "info");
      const attrs = baseAttributes();
      // The ingest keeps a line's attributes only up to 16 KiB of JSON, all
      // or nothing: the base ones first, then the caller's while they fit.
      let size = jsonBytes(attrs).length;
      let cut = false;
      if (isRecord(attributes)) {
        for (const key of Object.keys(attributes)) {
          const typed = typedAttribute(attributes[key]);
          if (typed === undefined) continue;
          const k = clipUtf8(key, 200);
          const add = jsonBytes({ [k]: typed }).length;
          if (size + add > tracerLimits.maxDataBytes - 64) {
            cut = true;
            break;
          }
          attrs[k] = typed;
          size += add;
        }
      }
      if (cut) attrs["tracer.truncated"] = { value: true, type: "boolean" };
      const entry = jsonBytes({
        timestamp: logTimestamp(),
        trace_id: traceId,
        level: logLevel(lvl),
        body: clipUtf8(text(message), tracerLimits.maxTextBytes),
        severity_number: severityNumber(lvl),
        attributes: attrs,
      });
      logs.push(entry);
      logBytes += entry.length + 1;
      if (
        logs.length >= logBatchSize ||
        logBytes >= tracerLimits.maxJsonItemBytes / 2
      ) {
        flushLogs();
        kick();
      } else if (logTimer === undefined) {
        logTimer = startTimer(() => {
          logTimer = undefined;
          guard(() => {
            flushLogs();
            kick();
          });
        }, flushIntervalMillis);
      }
    });
  };

  const report = (
    message: string,
    options?: TracerReportOptions,
  ): Promise<string | undefined> => {
    const id = guard(() => {
      const opts = options ?? {};
      const eventId = hexId(randomBytes, 16);
      const level = checkLevel(opts.level, "warning");
      const data =
        opts.data === undefined ? undefined : capData(jsonSafe(opts.data));
      const event: Record<string, unknown> = {
        ...eventBase(eventId, level),
        message: clipUtf8(text(message), tracerLimits.maxTextBytes),
        contexts: eventContexts({}),
      };
      if (isRecord(data) && Object.keys(data).length > 0) event["extra"] = data;
      if (opts.error !== undefined && opts.error !== null) {
        event["exception"] = exceptionOf(opts.error);
      }
      event["breadcrumbs"] = { values: [...breadcrumbs] };
      event["sdk"] = sdkInfo;
      const payload = eventPayload(event);
      if (payload === undefined) {
        drop("too_large");
        return undefined;
      }
      const items: WireItem[] = [{ header: { type: "event" }, payload }];
      let json = payload.length + itemOverhead;
      const logItem = takeLogs(tracerLimits.maxJsonBytesPerEnvelope - json);
      if (logItem !== undefined) {
        items.push(logItem);
        json += logItem.payload.length + itemOverhead;
      }
      // Margin for gzip framing: PNG does not compress, and the ingest caps
      // the body as sent too.
      let room = tracerLimits.maxEnvelopeBytes - 64 * 1024 - json;
      const files = [
        ...(opts.screenshot instanceof Uint8Array
          ? [
              {
                filename: "screenshot.png",
                data: opts.screenshot,
                contentType: "image/png",
              },
            ]
          : []),
        ...(Array.isArray(opts.attachments) ? opts.attachments : []),
      ];
      let count = 0;
      for (const file of files) {
        if (!(file?.data instanceof Uint8Array)) {
          drop("invalid");
          continue;
        }
        const size = file.data.length + itemOverhead;
        if (count === tracerLimits.maxAttachmentsPerEnvelope || size > room) {
          drop("too_large");
          continue;
        }
        items.push({
          header: {
            type: "attachment",
            filename: clipUtf8(text(file.filename), 200),
            content_type: clipUtf8(
              text(file.contentType ?? "application/octet-stream"),
              100,
            ),
            attachment_type: clipUtf8(
              text(
                (file as { attachmentType?: string }).attachmentType ??
                  "event.attachment",
              ),
              64,
            ),
          },
          payload: file.data,
        });
        room -= size;
        count++;
      }
      enqueue(envelope(eventId, items), "event");
      flushLogs();
      kick();
      return eventId;
    });
    return Promise.resolve(id);
  };

  const feedback = (
    note: string,
    options?: TracerFeedbackOptions,
  ): Promise<string | undefined> => {
    const id = guard(() => {
      const opts = options ?? {};
      const eventId = hexId(randomBytes, 16);
      const associated =
        typeof opts.eventId === "string"
          ? opts.eventId.replace(/-/g, "").toLowerCase()
          : undefined;
      const fb: Record<string, unknown> = {
        message: clipUtf8(text(note), tracerLimits.maxTextBytes),
      };
      if (associated !== undefined && /^[0-9a-f]{32}$/.test(associated)) {
        fb["associated_event_id"] = associated;
      }
      const event: Record<string, unknown> = {
        ...eventBase(eventId, "info"),
        contexts: eventContexts({ feedback: fb }),
        sdk: sdkInfo,
      };
      const payload = eventPayload(event);
      if (payload === undefined) {
        drop("too_large");
        return undefined;
      }
      enqueue(
        envelope(eventId, [{ header: { type: "feedback" }, payload }]),
        "feedback",
      );
      kick();
      return eventId;
    });
    return Promise.resolve(id);
  };

  const flush = async (options?: TracerFlushOptions): Promise<void> => {
    if (state !== "active") return;
    try {
      const opts = options ?? {};
      flushLogs();
      if (opts.unloading === true) {
        sendUnloading();
        kick();
        return;
      }
      if (paused() || (queue.length === 0 && !sending)) return;
      const idle = new Promise<void>((resolve) => idleWaiters.push(resolve));
      kick();
      if (opts.timeoutMillis !== undefined) {
        const t = opts.timeoutMillis;
        const wait =
          typeof t === "number" && !Number.isNaN(t)
            ? Math.min(maxRetryAfterMillis, Math.max(0, t))
            : 0;
        let timer: unknown;
        await Promise.race([
          idle,
          new Promise<void>((resolve) => {
            timer = startTimer(resolve, wait);
          }),
        ]);
        stopTimer(timer);
      } else {
        await idle;
      }
    } catch {
      drop("internal");
    }
  };

  const close = async (): Promise<void> => {
    if (state === "closed") return;
    if (state === "active") await flush({ timeoutMillis });
    state = "closed";
    shutdown();
    for (const request of [...inFlight]) request.abort();
    drop("closed", queue.length);
    queue.length = 0;
    queuedBytes = 0;
    settleIdle();
  };

  return {
    get state() {
      return state;
    },
    get enabled() {
      return state === "active";
    },
    traceId,
    get stats(): TracerStats {
      return {
        envelopesSent: sent,
        envelopesUnconfirmed: unconfirmed,
        queued: queue.length,
        dropped: { ...dropped },
      };
    },
    setTag(key: string, value: string | undefined) {
      guard(() => {
        const k = clipUtf8(text(key), 200);
        if (value === undefined || value === null) tags.delete(k);
        else if (tags.has(k) || tags.size < tracerLimits.maxTags) {
          tags.set(k, clipUtf8(text(value), 200));
        }
      });
    },
    breadcrumb,
    log,
    trace(category, message, options) {
      guard(() => {
        const opts = options ?? {};
        const data = opts.data === undefined ? undefined : jsonSafe(opts.data);
        const safe = { data: isRecord(data) ? data : {}, level: opts.level };
        breadcrumb(category, message, safe);
        log(checkLevel(opts.level, "info"), message, {
          ...safe.data,
          category,
        });
      });
    },
    report,
    feedback,
    flush,
    close,
  };
}

import type { Logger } from "@yingyeothon/logger";

/**
 * Severity of a breadcrumb, a log line or a report. On the wire an event says
 * `warning` and a log line says `warn`, with the matching `severity_number`;
 * the client writes each.
 */
export type TracerLevel = "debug" | "info" | "warning" | "error" | "fatal";

/**
 * Where a client stands. `off`: the DSN was empty or did not parse, every
 * call is a no-op. `stopped`: the ingest answered `401` (wrong or rotated
 * key), nothing more is sent until a new client is built with a new DSN.
 * `closed`: `close()` ran.
 */
export type TracerState = "active" | "off" | "stopped" | "closed";

/** A counters snapshot; read `stats` again for fresh values. */
export interface TracerStats {
  /** Envelopes the ingest answered `2xx`. */
  envelopesSent: number;
  /**
   * Envelopes handed to the network without a readable answer: the
   * `corsSafe` transport sends `no-cors`, whose response is opaque.
   */
  envelopesUnconfirmed: number;
  /** Envelopes waiting to be sent. */
  queued: number;
  /**
   * What the client gave up on, by reason: `too_large` (`413`, or past a
   * limit), `invalid` (`400`), `encoding` (`415` without gzip),
   * `unauthorized` (`401`), `queue_full` (the oldest envelope made room),
   * `http_<status>`, `redirect`, `internal`, `closed`.
   */
  dropped: Readonly<Record<string, number>>;
}

/** A file sent with a report, readable with `yyt tracer attachments`. */
export interface TracerAttachment {
  /** File name shown by the read API (no directory). */
  filename: string;
  /** The bytes, sent as they are. */
  data: Uint8Array;
  /** MIME type; default `application/octet-stream`. */
  contentType?: string;
  /**
   * The Sentry `attachment_type`: `event.attachment` (default),
   * `event.view_hierarchy`, `event.minidump`, …
   */
  attachmentType?: string;
}

/** A parsed tracer DSN. Holds a credential: never log it. */
export interface TracerDsn {
  /** The resource's write key; a credential, never logged. */
  writeKey: string;
  /** The resource id, `trc_…`. */
  resourceId: string;
  /** `POST` target: `{base}/api/{trc_id}/envelope/`, trailing slash included. */
  envelopeUrl: string;
}

export interface ParseTracerDsnOptions {
  /**
   * Accept `http` for a loopback host (`127.0.0.1`, `localhost`, `::1`), for
   * a local `tracer serve`. Off by default; turn it on in a debug build only.
   */
  allowHttpLoopback?: boolean;
}

/** Structural view of the WHATWG `fetch` request the client makes. */
export interface TracerFetchRequest {
  method: "POST";
  headers: Record<string, string>;
  body: Uint8Array;
  /** `no-cors` on the `corsSafe` transport, else `cors`. */
  mode: "cors" | "no-cors";
  /**
   * `manual` (a redirect is dropped: the write key would travel with it),
   * except on the `corsSafe` transport, where `no-cors` allows only `follow`.
   */
  redirect: "manual" | "follow";
  /** Set for bodies a page may still send while it unloads. */
  keepalive?: boolean;
  signal?: unknown;
}

/** Structural view of the WHATWG `Response` the client reads. */
export interface TracerFetchResponse {
  status: number;
  /** `opaque` for a `no-cors` answer, `opaqueredirect` for a redirect. */
  type?: string;
  headers: { get(name: string): string | null };
  arrayBuffer(): Promise<ArrayBuffer>;
}

export type TracerFetchLike = (
  url: string,
  init: TracerFetchRequest,
) => Promise<TracerFetchResponse>;

export interface TracerClientOptions {
  /**
   * `https://{writeKey}@{host}/{trc_id}`, from `yyt tracer dsn <res>` through
   * the build configuration; never committed. Empty means off.
   */
  dsn: string;
  /** `version+build` of the app or server. */
  release?: string;
  /** A build discriminator; a git sha lets a reader check out the code. */
  dist?: string;
  /** `debug`, `dev`, `local`, … */
  environment?: string;
  /** Tags on every event and attributes on every log line; tracer keeps 64. */
  tags?: Record<string, string>;
  /**
   * `user.id` on events and logs: an installation or session id, never a
   * person's name or email.
   */
  userId?: string;
  /**
   * Extra event `contexts` (`device`, `os`, `runtime`, `browser`, …); `trace`
   * and `feedback` are the client's own. `device.model` also becomes a log
   * attribute.
   */
  contexts?: Record<string, unknown>;
  /** Defaults to the global `fetch`. */
  fetch?: TracerFetchLike;
  /** The client's own diagnostics (ids, statuses, counts); default `nullLogger`. */
  logger?: Logger;
  /** Clock in epoch milliseconds; default `Date.now`. */
  now?: () => number;
  /**
   * Fills a buffer with random bytes, for ids and back-off jitter; default
   * `crypto.getRandomValues`.
   */
  randomBytes?: (length: number) => Uint8Array;
  /** Breadcrumbs kept for the next report, oldest dropped first; default 500. */
  breadcrumbCapacity?: number;
  /** Buffered log lines that trigger a send; default 100, at most 1000. */
  logBatchSize?: number;
  /** The longest a buffered log line waits before it is sent; default 5000. */
  flushIntervalMillis?: number;
  /** Envelopes kept while the ingest is unreachable; default 32. */
  maxQueuedEnvelopes?: number;
  /** Bytes kept while the ingest is unreachable; default 48 MiB. */
  maxQueuedBytes?: number;
  /**
   * Deadline of one request, plus one second per 64 KiB of body; default
   * 30000.
   */
  timeoutMillis?: number;
  /**
   * Gzip bodies with `CompressionStream` where it exists; default `true`.
   * Ignored on the `corsSafe` transport (`Content-Encoding` needs a
   * preflight).
   */
  compress?: boolean;
  /** Accept an `http` DSN for a loopback host; see `parseTracerDsn`. */
  allowHttpLoopback?: boolean;
  /**
   * Send as a CORS "simple" request, which needs no preflight: the write key
   * in the query string, `Content-Type: text/plain`, no gzip, `mode:
   * "no-cors"`. The answer is opaque: every send counts as
   * `envelopesUnconfirmed` and a `401`/`429`/`503` goes unnoticed. Default
   * `false`: tracer answers CORS on ingest (`tracer/v0.2.1`), so a browser
   * sends a normal `cors` request (one cached preflight) and reads the
   * answer. Set it only for a tracer older than v0.2.1.
   */
  corsSafe?: boolean;
  /** Event `platform`; default `javascript`. */
  platform?: string;
}

export interface TracerBreadcrumbOptions {
  /** JSON-safe data shown with the breadcrumb. */
  data?: Record<string, unknown>;
  /** Default `info`. */
  level?: TracerLevel;
}

export interface TracerReportOptions {
  /** Event `extra`. */
  data?: Record<string, unknown>;
  /** PNG bytes, sent as `screenshot.png` (see `captureCanvasScreenshot`). */
  screenshot?: Uint8Array;
  /** Other files (`view-hierarchy.json`, a save file, …). */
  attachments?: TracerAttachment[];
  /** Becomes an exception with frames parsed from its `stack`. */
  error?: unknown;
  /** Default `warning`. */
  level?: TracerLevel;
}

export interface TracerFeedbackOptions {
  /** The report this note is about (the id `report` resolved with). */
  eventId?: string;
}

export interface TracerFlushOptions {
  /**
   * The page is going away (`pagehide`, a hidden tab): start every queued
   * envelope that fits the browser's 64 KiB `keepalive` budget at once,
   * even during a back-off, and resolve without waiting for answers.
   */
  unloading?: boolean;
  /**
   * Bound the wait in milliseconds; the queue is left for later past it.
   * Default: until the queue is empty or waiting out a back-off.
   */
  timeoutMillis?: number;
}

/**
 * A tracer client: a breadcrumb ring, buffered logs and a bounded send queue
 * in front of tracer's envelope ingest. It never throws into the caller and
 * never blocks it: failures become counts in `stats`.
 */
export interface TracerClient {
  readonly state: TracerState;
  /** `state === "active"`. */
  readonly enabled: boolean;
  /** The `trace_id` on every event and log line of this client. */
  readonly traceId: string;
  readonly stats: TracerStats;
  /** Adds a tag to later events and log lines; `undefined` removes it. */
  setTag(key: string, value: string | undefined): void;
  /** Remembers a step for the next report; it leaves only inside an event. */
  breadcrumb(
    category: string,
    message: string,
    options?: TracerBreadcrumbOptions,
  ): void;
  /** Buffers a log line; `attributes` become typed attributes. */
  log(
    level: TracerLevel,
    message: string,
    attributes?: Record<string, unknown>,
  ): void;
  /** `breadcrumb` and `log` in one call, the log line tagged `category`. */
  trace(
    category: string,
    message: string,
    options?: TracerBreadcrumbOptions,
  ): void;
  /**
   * Sends an event at once with the breadcrumb ring, the buffered log lines
   * and the attachments. Resolves with the event id once it is queued
   * (`undefined` when not active); pass it to `feedback`.
   */
  report(
    message: string,
    options?: TracerReportOptions,
  ): Promise<string | undefined>;
  /** Sends a user's note, linked to a report when `eventId` is given. */
  feedback(
    note: string,
    options?: TracerFeedbackOptions,
  ): Promise<string | undefined>;
  /**
   * Sends the buffered log lines and whatever is queued. Resolves when the
   * queue is empty or waiting out a back-off; never waits one out. Call it
   * before a Lambda handler returns.
   */
  flush(options?: TracerFlushOptions): Promise<void>;
  /** `flush` (bounded by `timeoutMillis`), then stops. Later calls are no-ops. */
  close(): Promise<void>;
}

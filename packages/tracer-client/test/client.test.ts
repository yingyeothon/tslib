import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTracerClient, tracerSdkVersion } from "../src/index.js";
import type { TracerClientOptions, TracerFetchResponse } from "../src/index.js";
import {
  createCapturingLogger,
  createFakeFetch,
  fixtureDsn,
  fixtureKey,
  settle,
} from "./support.js";
import type { Answer } from "./support.js";

function client(
  answers: Answer[] = [],
  extra: Partial<TracerClientOptions> = {},
  fallback?: Answer,
) {
  const fake = createFakeFetch(answers, fallback);
  const c = createTracerClient({
    dsn: fixtureDsn,
    fetch: fake.fetch,
    corsSafe: false,
    // Node's CompressionStream does not settle under fake timers; the gzip
    // path has its own tests with real ones.
    compress: false,
    ...extra,
  });
  return { c, fake };
}

describe("state", () => {
  it("is off and silent for an empty DSN", async () => {
    const fake = createFakeFetch();
    const c = createTracerClient({ dsn: "  ", fetch: fake.fetch });
    expect(c.state).toBe("off");
    expect(c.enabled).toBe(false);
    c.log("info", "x");
    c.breadcrumb("a", "b");
    c.setTag("k", "v");
    expect(await c.report("r")).toBeUndefined();
    expect(await c.feedback("f")).toBeUndefined();
    await c.flush();
    await c.close();
    expect(fake.sent).toHaveLength(0);
    expect(c.state).toBe("closed");
  });

  it("is off with one warning, never quoting the key, for a bad DSN", () => {
    const logger = createCapturingLogger();
    const c = createTracerClient({
      dsn: `ftp://${fixtureKey}@trace.invalid/trc_fixture01`,
      logger,
    });
    expect(c.state).toBe("off");
    expect(logger.lines).toEqual(["warn tracer off: DSN did not parse"]);
    expect(logger.lines.join("\n")).not.toContain(fixtureKey.slice(0, 12));
  });

  it("is off when the runtime has no fetch", () => {
    vi.stubGlobal("fetch", undefined);
    try {
      const logger = createCapturingLogger();
      const c = createTracerClient({ dsn: fixtureDsn, logger });
      expect(c.state).toBe("off");
      expect(logger.lines).toEqual([
        "warn tracer off: no fetch in this runtime",
      ]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("uses the global fetch by default", async () => {
    const fake = createFakeFetch();
    vi.stubGlobal("fetch", fake.fetch);
    try {
      const c = createTracerClient({ dsn: fixtureDsn, corsSafe: false });
      await c.report("r");
      await c.flush();
      expect(fake.sent).toHaveLength(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("logs its activation with the resource and never the key", () => {
    const logger = createCapturingLogger();
    createTracerClient({
      dsn: fixtureDsn,
      logger,
      fetch: createFakeFetch().fetch,
    });
    expect(logger.lines.join("\n")).toContain("trc_fixture01");
    expect(logger.lines.join("\n")).not.toContain(fixtureKey);
  });
});

describe("transport", () => {
  it("posts a gzipped envelope with X-Sentry-Auth outside a browser", async () => {
    const { c, fake } = client([], { compress: true });
    const id = await c.report("hello");
    await c.flush();
    const sent = fake.sent[0]!;
    expect(sent.url).toBe("https://trace.invalid/api/trc_fixture01/envelope/");
    expect(sent.init.method).toBe("POST");
    expect(sent.init.mode).toBe("cors");
    expect(sent.init.redirect).toBe("manual");
    expect(sent.init.keepalive).toBeUndefined();
    expect(sent.init.headers).toEqual({
      "Content-Type": "application/x-sentry-envelope",
      "Content-Encoding": "gzip",
      "X-Sentry-Auth": `Sentry sentry_key=${fixtureKey}, sentry_version=7, sentry_client=yyt-ts/${tracerSdkVersion}`,
    });
    expect(sent.envelope.header["event_id"]).toBe(id);
    expect(c.stats).toEqual({
      envelopesSent: 1,
      envelopesUnconfirmed: 0,
      queued: 0,
      dropped: {},
    });
  });

  it("sends plain bodies when compress is false", async () => {
    const { c, fake } = client([], { compress: false });
    await c.report("hello");
    await c.flush();
    expect(fake.sent[0]!.init.headers["Content-Encoding"]).toBeUndefined();
    expect(fake.sent[0]!.init.body).toEqual(fake.sent[0]!.body);
  });

  it("sends a CORS-simple no-cors request when corsSafe", async () => {
    const { c, fake } = client([{ status: 0, type: "opaque" }], {
      corsSafe: true,
    });
    await c.report("hello");
    await c.flush();
    const sent = fake.sent[0]!;
    const url = new URL(sent.url);
    expect(url.pathname).toBe("/api/trc_fixture01/envelope/");
    expect(url.searchParams.get("sentry_key")).toBe(fixtureKey);
    expect(url.searchParams.get("sentry_version")).toBe("7");
    expect(url.searchParams.get("sentry_client")).toBe(
      `yyt-ts/${tracerSdkVersion}`,
    );
    expect(sent.init.headers).toEqual({
      "Content-Type": "text/plain;charset=UTF-8",
    });
    expect(sent.init.mode).toBe("no-cors");
    expect(sent.init.redirect).toBe("follow");
    expect(sent.init.keepalive).toBe(true);
    expect(c.stats.envelopesUnconfirmed).toBe(1);
    expect(c.stats.envelopesSent).toBe(0);
  });

  it("drops keepalive for a body over the browser's budget", async () => {
    const { c, fake } = client([{ status: 0, type: "opaque" }], {
      corsSafe: true,
    });
    await c.report("big", {
      attachments: [{ filename: "a.bin", data: new Uint8Array(70 * 1024) }],
    });
    await c.flush();
    expect(fake.sent[0]!.init.keepalive).toBeUndefined();
  });

  it("sends cors from a browser window by default (tracer answers CORS)", async () => {
    vi.stubGlobal("document", {});
    try {
      const fake = createFakeFetch([{ status: 200 }]);
      const c = createTracerClient({ dsn: fixtureDsn, fetch: fake.fetch });
      await c.report("r");
      await c.flush();
      expect(fake.sent[0]!.init.mode).toBe("cors");
      expect(c.stats.envelopesSent).toBe(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("responses", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("stops on 401 and drops the queue", async () => {
    const logger = createCapturingLogger();
    const { c, fake } = client([{ status: 401 }], { logger });
    await c.report("a");
    await c.report("b");
    c.log("info", "buffered");
    await c.flush();
    expect(c.state).toBe("stopped");
    expect(c.stats.dropped).toEqual({ unauthorized: 3 });
    expect(c.stats.queued).toBe(0);
    c.log("info", "after");
    await c.report("after");
    await c.flush();
    expect(fake.sent).toHaveLength(1);
    expect(logger.lines.join("\n")).not.toContain(fixtureKey);
  });

  it("waits out a 429's Retry-After and never resends sooner", async () => {
    const { c, fake } = client([
      { status: 429, headers: { "Retry-After": "30" } },
    ]);
    await c.report("a");
    await c.flush();
    expect(fake.sent).toHaveLength(1);
    expect(c.stats.queued).toBe(1);
    await vi.advanceTimersByTimeAsync(29_000);
    expect(fake.sent).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_000);
    await settle();
    expect(fake.sent).toHaveLength(2);
    expect(c.stats.envelopesSent).toBe(1);
  });

  it("treats Retry-After: 0 as absent (a 429 waits the quota's 300 s)", async () => {
    const { c, fake } = client([
      { status: 429, headers: { "Retry-After": "0" } },
    ]);
    await c.report("a");
    await c.flush();
    await vi.advanceTimersByTimeAsync(299_000);
    expect(fake.sent).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_000);
    await settle();
    expect(fake.sent).toHaveLength(2);
  });

  it("honours a 503's Retry-After, else backs off with jitter", async () => {
    const { c, fake } = client(
      [
        { status: 503, headers: { "Retry-After": "60" } },
        { status: 503 },
        { reject: new TypeError("fetch failed") },
      ],
      { randomBytes: (n) => new Uint8Array(n).fill(255) },
    );
    await c.report("a");
    await c.flush();
    await vi.advanceTimersByTimeAsync(59_999);
    expect(fake.sent).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await settle();
    expect(fake.sent).toHaveLength(2);
    // First back-off: 1 s (jitter at its top).
    await vi.advanceTimersByTimeAsync(1_000);
    await settle();
    expect(fake.sent).toHaveLength(3);
    // Second: 2 s.
    await vi.advanceTimersByTimeAsync(1_999);
    expect(fake.sent).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(1);
    await settle();
    expect(fake.sent).toHaveLength(4);
    expect(c.stats.envelopesSent).toBe(1);
  });

  it.each([
    [400, "invalid"],
    [413, "too_large"],
    [418, "http_418"],
    [302, "redirect"],
  ])("drops on %i as %s", async (status, reason) => {
    const { c, fake } = client([{ status }]);
    await c.report("a");
    await c.flush();
    expect(fake.sent).toHaveLength(1);
    expect(c.stats.dropped).toEqual({ [reason]: 1 });
    expect(c.state).toBe("active");
  });

  it("drops an opaque redirect (a browser's answer to redirect: manual)", async () => {
    const { c } = client([{ status: 0, type: "opaqueredirect" }]);
    await c.report("a");
    await c.flush();
    expect(c.stats.dropped).toEqual({ redirect: 1 });
  });

  it("resends plain once on 415 to gzip, then drops a plain 415", async () => {
    const { c, fake } = client(
      [{ status: 415 }, { status: 200 }, { status: 415 }],
      { compress: true },
    );
    await c.report("a");
    await c.flush();
    expect(fake.sent.map((s) => s.init.headers["Content-Encoding"])).toEqual([
      "gzip",
      undefined,
    ]);
    await c.report("b");
    await c.flush();
    expect(c.stats.dropped).toEqual({ encoding: 1 });
    expect(c.stats.envelopesSent).toBe(1);
  });

  it("aborts a request past its deadline and backs off", async () => {
    const { c, fake } = client([{ hang: true }], { timeoutMillis: 1000 });
    await c.report("a");
    const flushed = c.flush();
    await vi.advanceTimersByTimeAsync(1000);
    await flushed;
    expect(c.stats.queued).toBe(1);
    await vi.advanceTimersByTimeAsync(2000);
    await settle();
    expect(fake.sent).toHaveLength(2);
    expect(c.stats.envelopesSent).toBe(1);
  });

  it("flush resolves while paused instead of waiting out the back-off", async () => {
    const { c } = client([{ status: 429 }]);
    await c.report("a");
    await c.flush();
    await expect(c.flush()).resolves.toBeUndefined();
    expect(c.stats.queued).toBe(1);
  });

  it("flush honours its own timeout", async () => {
    const { c } = client([{ hang: true }], { timeoutMillis: 60_000 });
    await c.report("a");
    const flushed = c.flush({ timeoutMillis: 500 });
    await vi.advanceTimersByTimeAsync(500);
    await expect(flushed).resolves.toBeUndefined();
    expect(c.stats.envelopesSent).toBe(0);
  });

  it("close drops what is left and later calls do nothing", async () => {
    const { c, fake } = client([{ status: 429 }]);
    c.log("info", "buffered");
    await c.report("a");
    await c.flush();
    await c.close();
    expect(c.state).toBe("closed");
    expect(c.stats.dropped).toEqual({ closed: 1 });
    await c.report("b");
    await c.close();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(fake.sent).toHaveLength(1);
  });

  it("close aborts a request in flight and ignores its late answer", async () => {
    let answer: ((r: TracerFetchResponse) => void) | undefined;
    let aborted = false;
    const c = createTracerClient({
      dsn: fixtureDsn,
      corsSafe: false,
      compress: false,
      timeoutMillis: 1000,
      fetch: (_url, init) => {
        (
          init.signal as { addEventListener(t: string, l: () => void): void }
        ).addEventListener("abort", () => {
          aborted = true;
        });
        return new Promise((resolve) => {
          answer = resolve;
        });
      },
    });
    // Over 64 KiB: the request's own deadline (2 s) outlives close's (1 s).
    await c.report("a", {
      attachments: [{ filename: "a.bin", data: new Uint8Array(70 * 1024) }],
    });
    const closed = c.close();
    await vi.advanceTimersByTimeAsync(1000);
    await closed;
    expect(c.state).toBe("closed");
    expect(aborted).toBe(true);
    answer?.({
      status: 401,
      headers: { get: () => null },
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
    });
    await settle();
    expect(c.state).toBe("closed");
    expect(c.stats.dropped).toEqual({ closed: 1 });
  });

  it("drops an envelope after three 503s in a row, still waiting as told", async () => {
    const { c, fake } = client(
      [],
      {},
      { status: 503, headers: { "Retry-After": "1" } },
    );
    await c.report("a");
    await c.flush();
    for (let i = 0; i < 2; i++) {
      await vi.advanceTimersByTimeAsync(1000);
      await settle();
    }
    expect(fake.sent).toHaveLength(3);
    expect(c.stats).toMatchObject({ queued: 0, dropped: { send_failed: 1 } });
    fake.queue.push({ status: 200 });
    await c.report("b");
    await settle();
    expect(fake.sent).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(1000);
    await settle();
    expect(fake.sent).toHaveLength(4);
  });

  it("a 503 count restarts on any other answer", async () => {
    const { c, fake } = client([
      { status: 503, headers: { "Retry-After": "1" } },
      { status: 503, headers: { "Retry-After": "1" } },
      { status: 429, headers: { "Retry-After": "1" } },
      { status: 503, headers: { "Retry-After": "1" } },
      { status: 503, headers: { "Retry-After": "1" } },
    ]);
    await c.report("a");
    await c.flush();
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(1000);
      await settle();
    }
    expect(fake.sent).toHaveLength(6);
    expect(c.stats.envelopesSent).toBe(1);
    expect(c.stats.dropped).toEqual({});
  });

  it("treats a response without a body reader or headers as an answer", async () => {
    const c = createTracerClient({
      dsn: fixtureDsn,
      corsSafe: false,
      compress: false,
      fetch: () =>
        Promise.resolve({
          status: 503,
          headers: {
            get: () => {
              throw new Error("headers");
            },
          },
        } as unknown as TracerFetchResponse),
    });
    await c.report("a");
    await c.flush();
    expect(c.stats.queued).toBe(1);
    expect(c.stats.dropped).toEqual({});
  });

  it("clamps an unbounded flush timeout", async () => {
    const { c } = client([{ hang: true }], { timeoutMillis: 60_000 });
    await c.report("a");
    let done = false;
    void c.flush({ timeoutMillis: Infinity }).then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(10);
    expect(done).toBe(false);
  });
});

describe("queue", () => {
  it("drops the oldest envelope past maxQueuedEnvelopes", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const { c } = client([], { maxQueuedEnvelopes: 2 }, { status: 503 });
      await c.report("a");
      await c.report("b");
      await c.report("c");
      await settle();
      expect(c.stats.queued).toBe(2);
      expect(c.stats.dropped).toEqual({ queue_full: 1 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops the oldest envelope past maxQueuedBytes but keeps the newest", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const { c } = client([], { maxQueuedBytes: 10 }, { status: 503 });
      await c.report("a");
      await c.report("b");
      await settle();
      expect(c.stats.queued).toBe(1);
      expect(c.stats.dropped).toEqual({ queue_full: 1 });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("logs and breadcrumbs", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends logs by batch size", async () => {
    const { c, fake } = client([], { logBatchSize: 2 });
    c.log("info", "one");
    await settle();
    expect(fake.sent).toHaveLength(0);
    c.log("debug", "two", { n: 1 });
    await settle();
    expect(fake.sent).toHaveLength(1);
    const env = fake.sent[0]!.envelope;
    expect(env.header["event_id"]).toBeUndefined();
    expect(env.items[0]!.header["item_count"]).toBe(2);
    const entries = env.items[0]!.json["items"] as Record<string, unknown>[];
    expect(entries.map((e) => [e["level"], e["severity_number"]])).toEqual([
      ["info", 9],
      ["debug", 5],
    ]);
    expect(entries[0]!["trace_id"]).toBe(c.traceId);
  });

  it("sends logs after flushIntervalMillis", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { c, fake } = client([], { flushIntervalMillis: 1000 });
    c.log("error", "late");
    c.log("fatal", "later");
    await vi.advanceTimersByTimeAsync(999);
    expect(fake.sent).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    await settle();
    expect(fake.sent).toHaveLength(1);
    const entries = fake.sent[0]!.envelope.items[0]!.json["items"] as Record<
      string,
      unknown
    >[];
    expect(entries.map((e) => e["severity_number"])).toEqual([17, 21]);
  });

  it("keeps attributes under 16 KiB, marking the cut", async () => {
    const { c, fake } = client();
    c.log("info", "wide", {
      a: "x".repeat(9000),
      b: "y".repeat(9000),
      nested: { deep: [1, 2] },
      gone: undefined,
    });
    await c.flush();
    const entry = (
      fake.sent[0]!.envelope.items[0]!.json["items"] as Record<
        string,
        unknown
      >[]
    )[0]!;
    const attrs = entry["attributes"] as Record<string, { value: unknown }>;
    expect(attrs["a"]!.value).toHaveLength(8192);
    expect(attrs["b"]).toBeUndefined();
    // Past the cut nothing more is converted.
    expect(attrs["nested"]).toBeUndefined();
    expect(attrs["gone"]).toBeUndefined();
    expect(attrs["tracer.truncated"]).toEqual({ value: true, type: "boolean" });
  });

  it("keeps the newest breadcrumbs up to breadcrumbCapacity", async () => {
    const { c, fake } = client([], { breadcrumbCapacity: 2 });
    for (const m of ["1", "2", "3"]) c.breadcrumb("step", m);
    await c.report("r");
    await c.flush();
    const crumbs = (
      fake.sent[0]!.envelope.items[0]!.json["breadcrumbs"] as {
        values: { message: string }[];
      }
    ).values;
    expect(crumbs.map((b) => b.message)).toEqual(["2", "3"]);
  });

  it("keeps no breadcrumbs at capacity zero", async () => {
    const { c, fake } = client([], { breadcrumbCapacity: 0 });
    c.breadcrumb("step", "1");
    await c.report("r");
    await c.flush();
    expect(
      (fake.sent[0]!.envelope.items[0]!.json["breadcrumbs"] as { values: [] })
        .values,
    ).toEqual([]);
  });

  it("replaces breadcrumb data over 16 KiB with a marker", async () => {
    const { c, fake } = client();
    c.breadcrumb("big", "m", {
      data: { a: "z".repeat(8000), b: "z".repeat(8000), c: "z".repeat(8000) },
    });
    await c.report("r");
    await c.flush();
    const crumb = (
      fake.sent[0]!.envelope.items[0]!.json["breadcrumbs"] as {
        values: Record<string, unknown>[];
      }
    ).values[0]!;
    expect(crumb["data"]).toEqual({ "tracer.truncated": true });
  });

  it("trace writes a breadcrumb and a log line tagged with its category", async () => {
    const { c, fake } = client();
    c.trace("net", "connect", { data: { ms: 3 }, level: "warning" });
    await c.report("r");
    await c.flush();
    const [event, logs] = fake.sent[0]!.envelope.items;
    const crumb = (
      event!.json["breadcrumbs"] as { values: Record<string, unknown>[] }
    ).values[0]!;
    expect(crumb).toMatchObject({
      category: "net",
      level: "warning",
      data: { ms: 3 },
    });
    const entry = (logs!.json["items"] as Record<string, unknown>[])[0]!;
    expect(entry["level"]).toBe("warn");
    expect(entry["attributes"]).toMatchObject({
      category: { value: "net", type: "string" },
      ms: { value: 3, type: "integer" },
    });
  });

  it("setTag adds, replaces and removes, up to 64 tags", async () => {
    const tags: Record<string, string> = {};
    for (let i = 0; i < 63; i++) tags[`t${i}`] = "v";
    const { c, fake } = client([], { tags });
    c.setTag("extra", "1");
    c.setTag("overflow", "1");
    c.setTag("t0", "changed");
    c.setTag("t1", undefined);
    await c.report("r");
    await c.flush();
    const sentTags = fake.sent[0]!.envelope.items[0]!.json["tags"] as Record<
      string,
      string
    >;
    expect(Object.keys(sentTags)).toHaveLength(63);
    expect(sentTags["extra"]).toBe("1");
    expect(sentTags["overflow"]).toBeUndefined();
    expect(sentTags["t0"]).toBe("changed");
    expect(sentTags["t1"]).toBeUndefined();
  });
});

describe("report and feedback", () => {
  it("links feedback to a report", async () => {
    const { c, fake } = client();
    const id = await c.report("r");
    const fid = await c.feedback("it froze", {
      eventId: `${id!.slice(0, 8)}-${id!.slice(8)}`.toUpperCase(),
    });
    await c.flush();
    const fb = fake.sent[1]!.envelope;
    expect(fb.header["event_id"]).toBe(fid);
    expect(fb.items[0]!.header["type"]).toBe("feedback");
    expect(
      (fb.items[0]!.json["contexts"] as Record<string, unknown>)["feedback"],
    ).toEqual({ message: "it froze", associated_event_id: id });
  });

  it("leaves out a malformed associated event id", async () => {
    const { c, fake } = client();
    await c.feedback("note", { eventId: "nope" });
    await c.flush();
    expect(
      (
        fake.sent[0]!.envelope.items[0]!.json["contexts"] as Record<
          string,
          unknown
        >
      )["feedback"],
    ).toEqual({ message: "note" });
  });

  it("keeps the client's own trace and feedback contexts", async () => {
    const { c, fake } = client([], {
      contexts: {
        trace: { trace_id: "x" },
        feedback: { message: "x" },
        app: { a: 1 },
      },
    });
    await c.report("r", { level: "fatal" });
    await c.flush();
    const event = fake.sent[0]!.envelope.items[0]!.json;
    const contexts = event["contexts"] as Record<
      string,
      Record<string, unknown>
    >;
    expect(contexts["trace"]!["trace_id"]).toBe(c.traceId);
    expect(contexts["feedback"]).toBeUndefined();
    expect(contexts["app"]).toEqual({ a: 1 });
    expect(event["level"]).toBe("fatal");
  });

  it("turns a thrown non-Error into an exception", async () => {
    const { c, fake } = client();
    await c.report("r", { error: "plain string" });
    await c.report("r", { error: { name: 7, message: 8 } });
    await c.flush();
    const ex = (i: number) =>
      (
        fake.sent[i]!.envelope.items[0]!.json["exception"] as {
          values: Record<string, unknown>[];
        }
      ).values[0];
    expect(ex(0)).toEqual({ type: "string", value: "plain string" });
    expect(ex(1)).toEqual({ type: "Object", value: "[object Object]" });
  });

  it("drops attachments past the count and size limits, and non-bytes", async () => {
    const { c, fake } = client([], { compress: false });
    const attachments = Array.from({ length: 21 }, (_, i) => ({
      filename: `f${i}`,
      data: new Uint8Array(1),
    }));
    await c.report("r", {
      attachments: [
        ...attachments,
        { filename: "huge", data: new Uint8Array(21 * 1024 * 1024) },
        { filename: "bad", data: "nope" as unknown as Uint8Array },
      ],
    });
    await c.flush();
    expect(fake.sent[0]!.envelope.items).toHaveLength(21);
    expect(c.stats.dropped).toEqual({ too_large: 2, invalid: 1 });
  });

  it("trims an oversized event: breadcrumbs, then extra, then the exception", async () => {
    const { c, fake } = client([], { compress: false });
    for (let i = 0; i < 500; i++) c.breadcrumb("c", "m".repeat(8000));
    await c.report("r", {
      data: { a: "x".repeat(8000) },
      error: new Error("boom"),
    });
    await c.flush();
    const event = fake.sent[0]!.envelope.items[0]!;
    expect(event.payload.length).toBeLessThanOrEqual(1024 * 1024);
    const crumbs = (event.json["breadcrumbs"] as { values: unknown[] }).values;
    expect(crumbs.length).toBeGreaterThan(0);
    expect(crumbs.length).toBeLessThan(500);
    expect(event.json["extra"]).toBeDefined();
  });

  it("splits buffered logs that do not fit one container", async () => {
    const { c, fake } = client([], { compress: false, logBatchSize: 1000 });
    for (let i = 0; i < 200; i++) c.log("info", "l".repeat(8000));
    await c.report("r");
    await c.flush();
    const total = fake.sent
      .flatMap((s) => s.envelope.items)
      .filter((i) => i.header["type"] === "log")
      .reduce((n, i) => n + (i.header["item_count"] as number), 0);
    expect(total).toBe(200);
    for (const s of fake.sent) {
      for (const item of s.envelope.items) {
        expect(item.payload.length).toBeLessThanOrEqual(1024 * 1024);
      }
    }
  });
});

describe("never throws", () => {
  it("survives hostile input", async () => {
    const { c, fake } = client();
    const cyclic: Record<string, unknown> = {
      n: 1n,
      inf: Infinity,
      d: new Date(0),
    };
    cyclic["self"] = cyclic;
    const hostile = {
      get boom(): never {
        throw new Error("getter");
      },
    };
    c.log("info", "cyclic", cyclic);
    c.log("info", "hostile", { hostile });
    c.log("nope" as never, 42 as never, [1] as never);
    c.breadcrumb(
      Symbol("s") as never,
      {
        toString: () => {
          throw new Error("x");
        },
      } as never,
      {
        data: {
          m: new Map([[1, { s: new Set([1]) }]]),
          b: new Uint8Array(3),
          f: () => 1,
        },
      },
    );
    await c.report("r", { data: { hostile }, attachments: "x" as never });
    await c.flush();
    expect(fake.sent.length).toBeGreaterThan(0);
    expect(c.state).toBe("active");
  });

  it("survives a fetch that throws synchronously", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const c = createTracerClient({
        dsn: fixtureDsn,
        corsSafe: false,
        fetch: () => {
          throw new Error("sync");
        },
      });
      await c.report("r");
      await c.flush();
      expect(c.stats.queued).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("survives a logger that throws", async () => {
    const thrower = () => {
      throw new Error("logger");
    };
    const c = createTracerClient({
      dsn: fixtureDsn,
      corsSafe: false,
      fetch: createFakeFetch().fetch,
      logger: {
        severity: "debug",
        debug: thrower,
        info: thrower,
        warn: thrower,
        error: thrower,
      },
    });
    await c.report("r");
    await c.flush();
    expect(c.stats.envelopesSent).toBe(1);
  });

  it("ignores lines its own logger feeds back into it", async () => {
    const fake = createFakeFetch();
    let calls = 0;
    // eslint-disable-next-line prefer-const
    let c: ReturnType<typeof createTracerClient>;
    const loop = () => {
      calls++;
      c.log("info", "from the logger");
    };
    c = createTracerClient({
      dsn: fixtureDsn,
      corsSafe: false,
      fetch: fake.fetch,
      logger: {
        severity: "debug",
        debug: loop,
        info: loop,
        warn: loop,
        error: loop,
      },
    });
    await c.report("r");
    await c.flush();
    expect(calls).toBeGreaterThan(0);
    const logItems = fake.sent
      .flatMap((s) => s.envelope.items)
      .filter((i) => i.header["type"] === "log");
    expect(logItems).toHaveLength(0);
  });
});

describe("hostile input and options", () => {
  it("trace never throws, whatever its options", () => {
    const { c } = client();
    const proxy = new Proxy(
      {},
      {
        ownKeys: () => {
          throw new Error("ownKeys");
        },
      },
    );
    for (const c2 of [c, createTracerClient({ dsn: "" })]) {
      expect(() => c2.trace("c", "m", null as never)).not.toThrow();
      expect(() =>
        c2.trace("c", "m", {
          get data(): never {
            throw new Error("getter");
          },
        }),
      ).not.toThrow();
      expect(() => c2.trace("c", "m", { data: proxy })).not.toThrow();
      expect(() => c2.log("info", "m", proxy)).not.toThrow();
      expect(() => c2.breadcrumb("c", "m", null as never)).not.toThrow();
    }
  });

  it("the caller's data cannot replace a trace's category", async () => {
    const { c, fake } = client();
    c.trace("net", "m", { data: { category: "spoofed" } });
    await c.report("r");
    await c.flush();
    const entry = (
      fake.sent[0]!.envelope.items[1]!.json["items"] as Record<
        string,
        unknown
      >[]
    )[0]!;
    expect(entry["attributes"]).toMatchObject({
      category: { value: "net", type: "string" },
    });
  });

  it("report, feedback and flush accept null options", async () => {
    const { c, fake } = client();
    expect(await c.report("r", null as never)).toMatch(/^[0-9a-f]{32}$/);
    expect(await c.feedback("f", null as never)).toMatch(/^[0-9a-f]{32}$/);
    await c.flush(null as never);
    expect(fake.sent).toHaveLength(2);
  });

  it("construction never throws: hostile options make an off client", () => {
    const throwing = new Proxy(
      {},
      {
        get: () => {
          throw new Error("options");
        },
      },
    );
    expect(createTracerClient(throwing as never).state).toBe("off");
    expect(createTracerClient(null as never).state).toBe("off");
    const c = createTracerClient({
      dsn: fixtureDsn,
      fetch: createFakeFetch().fetch,
      randomBytes: () => {
        throw new Error("random");
      },
    });
    expect(c.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(c.state).toBe("active");
  });

  it("parses a huge, stack-shaped message quickly", async () => {
    const { c, fake } = client();
    const error = new Error("x".repeat(120_000));
    error.stack = `Error: ${"@a:1:1 ".repeat(20_000)}\n    at f (/a.js:1:1)`;
    const started = Date.now();
    await c.report("r", { error });
    expect(Date.now() - started).toBeLessThan(200);
    await c.flush();
    expect(fake.sent).toHaveLength(1);
  });

  it("accepts warn as warning", async () => {
    const { c, fake } = client();
    await c.report("r", { level: "warn" as never });
    await c.flush();
    expect(fake.sent[0]!.envelope.items[0]!.json["level"]).toBe("warning");
  });

  it("keeps whole contexts under 16 KiB and tags under 8 KiB per log line", async () => {
    const tags: Record<string, string> = {};
    for (let i = 0; i < 64; i++) tags[`tag${i}`] = "v".repeat(200);
    const { c, fake } = client([], {
      tags,
      contexts: {
        small: { a: 1 },
        big: { b: "x".repeat(8000), c: "y".repeat(8000), d: "z".repeat(8000) },
      },
    });
    c.log("info", "line", { mine: 1 });
    await c.report("r");
    await c.flush();
    const [event, logs] = fake.sent[0]!.envelope.items;
    const contexts = event!.json["contexts"] as Record<string, unknown>;
    expect(contexts["small"]).toEqual({ a: 1 });
    expect(contexts["big"]).toBeUndefined();
    expect(Object.keys(event!.json["tags"] as object)).toHaveLength(64);
    const entry = (logs!.json["items"] as Record<string, unknown>[])[0]!;
    const attrs = entry["attributes"] as Record<string, unknown>;
    expect(JSON.stringify(attrs).length).toBeLessThan(16 * 1024);
    expect(attrs["mine"]).toEqual({ value: 1, type: "integer" });
    expect(attrs["tag0"]).toBeDefined();
    expect(attrs["tag63"]).toBeUndefined();
  });

  it("gives equal log lines in one millisecond distinct timestamps", async () => {
    const { c, fake } = client([], { now: () => 1_700_000_000_000 });
    c.log("info", "same");
    c.log("info", "same");
    await c.flush();
    const entries = fake.sent[0]!.envelope.items[0]!.json["items"] as Record<
      string,
      number
    >[];
    expect(entries[0]!["timestamp"]).toBe(1_700_000_000);
    expect(entries[1]!["timestamp"]).toBeGreaterThan(1_700_000_000);
    expect(entries[1]!["timestamp"]).toBeLessThan(1_700_000_000.001);
  });
});

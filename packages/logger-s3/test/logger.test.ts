import type { LogSeverity } from "@yingyeothon/logger";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createS3Logger,
  createS3cbLogFlush,
  s3cbLogFlushOptionsFromEnv,
  serializeAsJSON,
} from "../src/index.js";
import type { Appended } from "./helpers.js";
import { fakeS3cbClient, parseLines } from "./helpers.js";

function buildLogFileName(date: Date, severity: LogSeverity) {
  function zeroPad(value: number, length: number) {
    return `0${value}`.slice(-length);
  }
  return [
    "logging",
    "mylog",
    severity,
    date.getFullYear() +
      zeroPad(date.getMonth() + 1, 2) +
      zeroPad(date.getDate(), 2),
  ].join("/");
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("createS3Logger", () => {
  it("runs the legacy basic scenario and flushes every record", async () => {
    vi.spyOn(console, "debug").mockImplementation(() => undefined);
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const appends: Appended[] = [];
    const { logger, flush } = createS3Logger({
      client: fakeS3cbClient(appends),
      asKey: buildLogFileName,
      autoFlushIntervalMillis: 100,
      autoFlushMaxBufferSize: 10,
      severity: "debug",
      withConsole: true,
    });

    for (let i = 0; i < 10; ++i) {
      logger.debug("Hello from DEBUG", i);
      logger.info("Hello from INFO", i);
      logger.error("Bye from ERROR", i);
    }
    await flush();

    logger.error("Step B", "Bye, once more!");
    await flush();
    await flush();
    await flush();

    logger.debug("Step C", "Hi");
    logger.info("Step C", "Hello");
    logger.error("Step C", "Bye");

    try {
      throw new Error("Oops!");
    } catch (error) {
      logger.error("Error!", error);
    }

    await new Promise<void>((resolve) => setTimeout(resolve, 200));
    logger.error("Finish", "FlushALL");

    await flush();

    const records = parseLines(appends);
    const today = new Date();
    const debugKey = buildLogFileName(today, "debug");
    const infoKey = buildLogFileName(today, "info");
    const errorKey = buildLogFileName(today, "error");
    expect(records[debugKey]).toHaveLength(11);
    expect(records[infoKey]).toHaveLength(11);
    expect(records[errorKey]).toHaveLength(14);
    expect(records[errorKey]?.[0]).toMatchObject({
      level: "error",
      args: ["Bye from ERROR", 0],
    });
  });

  it("buffers records and appends nothing before a flush trigger", async () => {
    const appends: Appended[] = [];
    const client = fakeS3cbClient(appends);
    const { logger, flush } = createS3Logger({
      client,
      asKey: (_date, severity) => `log/${severity}`,
      severity: "debug",
    });

    logger.debug("a");
    logger.info("b");
    logger.error("c");
    expect(appends).toHaveLength(0);

    await flush();
    expect(parseLines(appends)).toMatchObject({
      "log/debug": [{ level: "debug", args: ["a"] }],
      "log/info": [{ level: "info", args: ["b"] }],
      "log/error": [{ level: "error", args: ["c"] }],
    });
  });

  it("writes warn records through the full LogWriter contract", async () => {
    const appends: Appended[] = [];
    const { logger, flush } = createS3Logger({
      client: fakeS3cbClient(appends),
      asKey: (_date, severity) => `log/${severity}`,
      severity: "warn",
    });

    logger.info("dropped");
    logger.warn("kept");
    await flush();

    const records = parseLines(appends);
    expect(records["log/info"]).toBeUndefined();
    expect(records["log/warn"]).toEqual([
      expect.objectContaining({ level: "warn", args: ["kept"] }),
    ]);
  });

  it("filters records below the configured severity", async () => {
    const appends: Appended[] = [];
    const { logger, flush } = createS3Logger({
      client: fakeS3cbClient(appends),
      asKey: (_date, severity) => severity,
      severity: "info",
    });

    logger.debug("dropped");
    logger.info("kept");
    await flush();

    const records = parseLines(appends);
    expect(records["debug"]).toBeUndefined();
    expect(records["info"]).toEqual([
      expect.objectContaining({ args: ["kept"] }),
    ]);
  });

  it("auto flushes when the buffer exceeds autoFlushMaxBufferSize", async () => {
    const appends: Appended[] = [];
    const { logger, flush } = createS3Logger({
      client: fakeS3cbClient(appends),
      asKey: () => "log",
      severity: "debug",
      autoFlushMaxBufferSize: 2,
    });

    logger.info("one");
    logger.info("two");
    expect(appends).toHaveLength(0);
    logger.info("three");
    await flush(); // Chained after the pending auto flush.
    expect(parseLines(appends)["log"]).toHaveLength(3);
  });

  it("auto flushes when autoFlushIntervalMillis has elapsed", async () => {
    vi.useFakeTimers();
    const appends: Appended[] = [];
    const { logger, flush } = createS3Logger({
      client: fakeS3cbClient(appends),
      asKey: () => "log",
      severity: "debug",
      autoFlushIntervalMillis: 1000,
      autoFlushMaxBufferSize: 1024,
    });

    logger.info("early");
    expect(appends).toHaveLength(0);

    vi.advanceTimersByTime(1500);
    logger.info("late");
    await flush();
    expect(parseLines(appends)["log"]).toHaveLength(2);
  });

  it("aggregates records that share the same key into one append", async () => {
    const appends: Appended[] = [];
    const { logger, flush } = createS3Logger({
      client: fakeS3cbClient(appends),
      asKey: () => "same-key",
      severity: "debug",
    });

    logger.info("first");
    logger.error("second");
    await flush();

    expect(appends).toHaveLength(1);
    expect(parseLines(appends)["same-key"]).toHaveLength(2);
  });

  it("serializes Error arguments with serialize-error", async () => {
    const appends: Appended[] = [];
    const { logger, flush } = createS3Logger({
      client: fakeS3cbClient(appends),
      asKey: () => "errors",
      severity: "debug",
    });

    logger.error("boom", new Error("Oops!"));
    await flush();

    const [record] = parseLines(appends)["errors"] as Array<{
      args: [string, { name: string; message: string; stack: string }];
    }>;
    expect(record?.args[0]).toBe("boom");
    expect(record?.args[1]).toMatchObject({
      name: "Error",
      message: "Oops!",
    });
    expect(record?.args[1].stack).toContain("Error: Oops!");
  });

  it("supports a custom serializer", async () => {
    const appends: Appended[] = [];
    const { logger, flush } = createS3Logger({
      client: fakeS3cbClient(appends),
      asKey: () => "custom",
      severity: "debug",
      serializer: (timestamp, level, args) =>
        [timestamp.getTime(), level, ...args].join(" ") + "\n",
    });

    logger.info("hello", 42);
    await flush();
    expect(appends[0]?.body).toMatch(/^\d+ info hello 42\n$/);
  });

  it("invokes a withConsole callback for every written record", async () => {
    const seen: unknown[][] = [];
    const { logger, flush } = createS3Logger({
      client: fakeS3cbClient([]),
      asKey: () => "log",
      severity: "debug",
      withConsole: ({ severity, args }) => seen.push([severity, ...args]),
    });

    logger.info("hi");
    logger.error("bye");
    await flush();
    expect(seen).toEqual([
      ["info", "hi"],
      ["error", "bye"],
    ]);
  });

  it("rejects the flush when the append call fails, and poisons later flushes", async () => {
    const { logger, flush } = createS3Logger({
      client: fakeS3cbClient([], () =>
        Promise.reject(new Error("append failed")),
      ),
      asKey: () => "log",
      severity: "debug",
    });

    logger.info("doomed");
    await expect(flush()).rejects.toThrow("append failed");

    // Legacy behavior: the internal promise chain stays rejected.
    logger.info("after failure");
    await expect(flush()).rejects.toThrow("append failed");
  });

  it("resolves immediately when there is nothing to flush", async () => {
    const appends: Appended[] = [];
    const { flush } = createS3Logger({
      client: fakeS3cbClient(appends),
      asKey: () => "log",
    });
    await flush();
    expect(appends).toHaveLength(0);
  });
});

describe("createS3cbLogFlush", () => {
  it("throws when neither a client nor an apiUrl is given", () => {
    expect(() => createS3cbLogFlush({})).toThrow("No URL for S3CB");
  });

  it("does not read process.env implicitly", () => {
    vi.stubEnv("S3CB_URL", "http://from-env.example.com/");
    try {
      expect(() => createS3cbLogFlush({})).toThrow("No URL for S3CB");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("reads the documented variables via s3cbLogFlushOptionsFromEnv", () => {
    vi.stubEnv("S3CB_URL", "http://from-env.example.com/");
    vi.stubEnv("S3CB_ID", "env-id");
    vi.stubEnv("S3CB_PASSWORD", "env-password");
    try {
      expect(s3cbLogFlushOptionsFromEnv()).toEqual({
        apiUrl: "http://from-env.example.com/",
        apiId: "env-id",
        apiPassword: "env-password",
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("uses the real S3cb client over fetch when no client is injected", async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(new Response("", { status: 200 })),
    );
    vi.stubGlobal("fetch", fetchMock);

    const flush = createS3cbLogFlush({
      apiUrl: "http://localhost:3000/",
      apiId: "test",
      apiPassword: "test",
    });
    const timestamp = new Date("2026-08-20T00:00:00.000Z");
    await flush(
      [{ key: "a/b", timestamp, severity: "info", args: ["hello"] }],
      timestamp.getTime(),
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toContain("http://localhost:3000/a/b");
    expect(url).toContain("append=1");
    expect(init.method).toBe("PUT");
    expect(Buffer.from(init.body as Uint8Array).toString("utf8")).toBe(
      serializeAsJSON(timestamp, "info", ["hello"]),
    );
  });

  it("propagates HTTP failures from the real client", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(new Response("nope", { status: 500 }))),
    );
    const flush = createS3cbLogFlush({ apiUrl: "http://localhost:3000/" });
    await expect(
      flush(
        [{ key: "k", timestamp: new Date(), severity: "error", args: [] }],
        Date.now(),
      ),
    ).rejects.toThrow("500");
  });
});

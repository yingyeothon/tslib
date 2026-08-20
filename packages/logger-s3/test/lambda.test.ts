import { afterEach, describe, expect, it, vi } from "vitest";

import { createLambdaS3Logger } from "../src/index.js";
import type { Appended } from "./helpers.js";
import { fakeS3cbClient, parseLines } from "./helpers.js";

function todayAsYyyyMMdd(): string {
  const now = new Date();
  const pad = (value: number) => `0${value}`.slice(-2);
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
}

interface LambdaRecord {
  timestamp: string;
  level: string;
  systemName?: string;
  systemId?: string;
  handlerName?: string;
  lambdaId?: string;
  args: unknown[];
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createLambdaS3Logger", () => {
  it("runs the legacy basic lambda scenario", async () => {
    const consoleSpies = [
      vi.spyOn(console, "debug").mockImplementation(() => undefined),
      vi.spyOn(console, "info").mockImplementation(() => undefined),
      vi.spyOn(console, "error").mockImplementation(() => undefined),
    ];

    const appends: Appended[] = [];
    const { logger, flush, updateSystemId } = createLambdaS3Logger({
      // Lambda information
      systemName: "HelloWorld",
      lambdaId: "2f40adbe-b450-40fe-9796-cc3d072b4c62",
      handlerName: "testHandler",
      logKeyPrefix: "logging",

      // Logger behavior
      severity: "debug",
      autoFlushIntervalMillis: 100,
      autoFlushMaxBufferSize: 10,

      // S3CB connection replaced by an injected fake client.
      client: fakeS3cbClient(appends),
    });

    logger.info("Info before systemId is set");
    updateSystemId("COMPLEX-SYSTEM-ID");
    logger.debug("Debug before systemId is set");

    try {
      throw new Error("Something is broken :)");
    } catch (error) {
      logger.error("There is an error", error);
    }

    logger.info("All logs should have systemId properly!");
    await flush();

    const key = `logging/HelloWorld/${todayAsYyyyMMdd()}`;
    const records = parseLines(appends)[key] as LambdaRecord[];
    expect(records).toHaveLength(4);
    for (const record of records) {
      // Serialization happens at flush time, so every record carries the
      // systemId that was set before the flush (legacy behavior).
      expect(record).toMatchObject({
        systemName: "HelloWorld",
        systemId: "COMPLEX-SYSTEM-ID",
        handlerName: "testHandler",
        lambdaId: "2f40adbe-b450-40fe-9796-cc3d072b4c62",
      });
    }
    const errorRecord = records[2];
    expect(errorRecord?.level).toBe("error");
    expect(errorRecord?.args[0]).toBe("There is an error");
    expect(errorRecord?.args[1]).toMatchObject({
      name: "Error",
      message: "Something is broken :)",
    });
    expect(consoleSpies[1]).toHaveBeenCalled();
  });

  it("writes to the console with 'null' placeholders for missing fields", async () => {
    const infoSpy = vi
      .spyOn(console, "info")
      .mockImplementation(() => undefined);

    const { logger, flush } = createLambdaS3Logger({
      systemName: "OnlyName",
      severity: "debug",
      client: fakeS3cbClient([]),
    });

    logger.info("hello");
    await flush();

    expect(infoSpy).toHaveBeenCalledTimes(1);
    const call = infoSpy.mock.calls[0] as unknown[];
    expect(call.slice(1)).toEqual([
      "INFO",
      "OnlyName",
      "null",
      "null",
      "null",
      "hello",
    ]);
  });

  it("throws when none of asKey, logKeyPrefix and systemName is given", () => {
    expect(() => createLambdaS3Logger({ client: fakeS3cbClient([]) })).toThrow(
      "Please set one of `asKey`, `logKeyPrefix` and `systemName`",
    );
  });

  it("builds the log key without a prefix when only systemName is set", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const appends: Appended[] = [];
    const { logger, flush } = createLambdaS3Logger({
      systemName: "Solo",
      client: fakeS3cbClient(appends),
    });

    logger.info("key check");
    await flush();
    expect(appends[0]?.key).toBe(`Solo/${todayAsYyyyMMdd()}`);
  });

  it("prefers a user-provided asKey over the generated one", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const appends: Appended[] = [];
    const { logger, flush } = createLambdaS3Logger({
      systemName: "Ignored",
      asKey: (_date, severity) => `custom/${severity}`,
      severity: "debug",
      client: fakeS3cbClient(appends),
    });

    logger.error("routed");
    await flush();
    expect(appends[0]?.key).toBe("custom/error");
  });

  it("rejects the flush when the underlying append fails", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const { logger, flush } = createLambdaS3Logger({
      systemName: "Broken",
      client: fakeS3cbClient([], () => Promise.reject(new Error("s3 down"))),
    });

    logger.info("will fail");
    await expect(flush()).rejects.toThrow("s3 down");
  });
});

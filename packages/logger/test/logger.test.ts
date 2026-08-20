import { describe, expect, it, vi } from "vitest";
import {
  combine,
  consoleWriter,
  createConsoleLogger,
  createFilteredLogger,
  nullLogger,
  type Logger,
  type LogWriter,
} from "../src/index.js";

function bufferWriter(buffer: string[]): LogWriter {
  return {
    debug: (...args) => buffer.push(`debug ${args.join(" ")}`),
    info: (...args) => buffer.push(`info ${args.join(" ")}`),
    warn: (...args) => buffer.push(`warn ${args.join(" ")}`),
    error: (...args) => buffer.push(`error ${args.join(" ")}`),
  };
}

describe("createFilteredLogger", () => {
  it("writes only records at or above the configured severity", () => {
    const buffer: string[] = [];
    const logger: Logger = createFilteredLogger({
      severity: "info",
      writer: bufferWriter(buffer),
    });

    logger.debug("hi");
    logger.info("hello");
    logger.warn("careful");
    logger.error("bye");
    expect(buffer).toEqual(["info hello", "warn careful", "error bye"]);

    logger.severity = "debug";
    logger.debug("again");
    expect(buffer).toEqual([
      "info hello",
      "warn careful",
      "error bye",
      "debug again",
    ]);
  });

  it("writes nothing when severity is none", () => {
    const buffer: string[] = [];
    const logger = createFilteredLogger({
      severity: "none",
      writer: bufferWriter(buffer),
    });
    logger.debug("a");
    logger.info("b");
    logger.warn("c");
    logger.error("d");
    expect(buffer).toEqual([]);
  });

  it("writes everything when severity is debug", () => {
    const buffer: string[] = [];
    const logger = createFilteredLogger({
      severity: "debug",
      writer: bufferWriter(buffer),
    });
    logger.debug("a");
    logger.info("b");
    logger.warn("c");
    logger.error("d");
    expect(buffer).toEqual(["debug a", "info b", "warn c", "error d"]);
  });

  it("hides warn when severity is error", () => {
    const buffer: string[] = [];
    const logger = createFilteredLogger({
      severity: "error",
      writer: bufferWriter(buffer),
    });
    logger.warn("hidden");
    logger.error("shown");
    expect(buffer).toEqual(["error shown"]);
  });
});

describe("combine", () => {
  it("fans out each record to every writer", () => {
    const first: string[] = [];
    const second: string[] = [];
    const combined = combine(bufferWriter(first), bufferWriter(second));

    combined.debug("d");
    combined.info("i");
    combined.warn("w");
    combined.error("e");
    expect(first).toEqual(["debug d", "info i", "warn w", "error e"]);
    expect(second).toEqual(first);
  });

  it("skips the null logger", () => {
    const buffer: string[] = [];
    const combined = combine(nullLogger, bufferWriter(buffer));
    combined.info("only once");
    expect(buffer).toEqual(["info only once"]);
  });
});

describe("nullLogger", () => {
  it("accepts records without writing anywhere", () => {
    expect(nullLogger.severity).toBe("none");
    expect(nullLogger.debug("x")).toBeUndefined();
    expect(nullLogger.info("x")).toBeUndefined();
    expect(nullLogger.warn("x")).toBeUndefined();
    expect(nullLogger.error("x")).toBeUndefined();
  });
});

describe("createConsoleLogger", () => {
  it("filters through to the console writer", () => {
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const logger = createConsoleLogger();
      logger.debug("hidden");
      logger.info("shown");
      logger.warn("watch out");
      logger.error("failed");
      expect(debugSpy).not.toHaveBeenCalled();
      expect(infoSpy).toHaveBeenCalledWith("shown");
      expect(warnSpy).toHaveBeenCalledWith("watch out");
      expect(errorSpy).toHaveBeenCalledWith("failed");

      consoleWriter.debug("direct");
      expect(debugSpy).toHaveBeenCalledWith("direct");
    } finally {
      vi.restoreAllMocks();
    }
  });
});

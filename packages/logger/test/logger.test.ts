import { describe, expect, it, vi } from "vitest";
import {
  combine,
  ConsoleLogger,
  consoleWriter,
  FilteredLogger,
  nullLogger,
  type Logger,
  type LogWriter,
} from "../src/index.js";

function bufferWriter(buffer: string[]): LogWriter {
  return {
    debug: (...args) => buffer.push(`debug ${args.join(" ")}`),
    info: (...args) => buffer.push(`info ${args.join(" ")}`),
    error: (...args) => buffer.push(`error ${args.join(" ")}`),
  };
}

describe("FilteredLogger", () => {
  it("writes only records at or above the configured severity", () => {
    const buffer: string[] = [];
    const logger: Logger = new FilteredLogger("info", bufferWriter(buffer));

    logger.debug("hi");
    logger.info("hello");
    logger.error("bye");
    expect(buffer).toEqual(["info hello", "error bye"]);

    logger.severity = "debug";
    logger.debug("again");
    expect(buffer).toEqual(["info hello", "error bye", "debug again"]);
  });

  it("writes nothing when severity is none", () => {
    const buffer: string[] = [];
    const logger = new FilteredLogger("none", bufferWriter(buffer));
    logger.debug("a");
    logger.info("b");
    logger.error("c");
    expect(buffer).toEqual([]);
  });

  it("writes everything when severity is debug", () => {
    const buffer: string[] = [];
    const logger = new FilteredLogger("debug", bufferWriter(buffer));
    logger.debug("a");
    logger.info("b");
    logger.error("c");
    expect(buffer).toEqual(["debug a", "info b", "error c"]);
  });
});

describe("combine", () => {
  it("fans out each record to every writer", () => {
    const first: string[] = [];
    const second: string[] = [];
    const combined = combine(bufferWriter(first), bufferWriter(second));

    combined.debug("d");
    combined.info("i");
    combined.error("e");
    expect(first).toEqual(["debug d", "info i", "error e"]);
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
    expect(nullLogger.error("x")).toBeUndefined();
  });
});

describe("ConsoleLogger", () => {
  it("filters through to the console writer", () => {
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const logger = new ConsoleLogger();
      logger.debug("hidden");
      logger.info("shown");
      logger.error("failed");
      expect(debugSpy).not.toHaveBeenCalled();
      expect(infoSpy).toHaveBeenCalledWith("shown");
      expect(errorSpy).toHaveBeenCalledWith("failed");

      consoleWriter.debug("direct");
      expect(debugSpy).toHaveBeenCalledWith("direct");
    } finally {
      vi.restoreAllMocks();
    }
  });
});

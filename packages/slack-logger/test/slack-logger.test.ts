import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  asYlogger,
  flushSlack,
  getLogger,
  LogLevel,
  parseLogLevel,
  toLogLevelName,
  useLogger,
} from "../src/index.js";

const WEBHOOK_URL = "https://hooks.slack.com/services/T000/B000/XXX";

function createFetchMock(text = "ok") {
  return vi.fn((..._args: unknown[]) =>
    Promise.resolve({ text: () => Promise.resolve(text) }),
  );
}

function slackBody(fetchMock: ReturnType<typeof vi.fn>, callIndex = 0) {
  const init = fetchMock.mock.calls[callIndex]?.[1] as { body: string };
  return JSON.parse(init.body) as {
    text: string;
    channel?: string;
    username: string;
  };
}

let fetchMock: ReturnType<typeof createFetchMock>;

beforeEach(() => {
  fetchMock = createFetchMock();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("SLACK_WEBHOOK_URL", WEBHOOK_URL);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "debug").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(async () => {
  await flushSlack();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("parseLogLevel", () => {
  it("parses every known level name case-insensitively", () => {
    expect(parseLogLevel("trace")).toBe(LogLevel.trace);
    expect(parseLogLevel("DEBUG")).toBe(LogLevel.debug);
    expect(parseLogLevel("info")).toBe(LogLevel.info);
    expect(parseLogLevel("Warn")).toBe(LogLevel.warn);
    expect(parseLogLevel("error")).toBe(LogLevel.error);
    expect(parseLogLevel("fatal")).toBe(LogLevel.fatal);
    expect(parseLogLevel("silent")).toBe(LogLevel.silent);
  });

  it("falls back to info for missing or unknown input", () => {
    expect(parseLogLevel()).toBe(LogLevel.info);
    expect(parseLogLevel("nonsense")).toBe(LogLevel.info);
  });
});

describe("toLogLevelName", () => {
  it("maps every level value back to its name", () => {
    expect(toLogLevelName(LogLevel.trace)).toBe("trace");
    expect(toLogLevelName(LogLevel.debug)).toBe("debug");
    expect(toLogLevelName(LogLevel.info)).toBe("info");
    expect(toLogLevelName(LogLevel.warn)).toBe("warn");
    expect(toLogLevelName(LogLevel.error)).toBe("error");
    expect(toLogLevelName(LogLevel.fatal)).toBe("fatal");
    expect(toLogLevelName(LogLevel.silent)).toBe("silent");
  });
});

describe("useLogger", () => {
  it("posts to the webhook URL with the legacy payload shape", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-08-20T01:02:03.000Z"));

    const logger = useLogger({ componentName: "comp", fileName: "file.ts" });
    logger.error({ requestId: "r-1" }, "boom happened");
    await logger.flushSlack();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: expect.any(String) as string,
    });

    const body = slackBody(fetchMock);
    expect(body.username).toBe("Logger");
    expect(body.channel).toBeUndefined();
    expect(body.text).toBe(
      "[ERROR] boom happened\n```" +
        JSON.stringify(
          {
            timestamp: "2026-08-20T01:02:03.000Z",
            componentName: "comp",
            fileName: "file.ts",
            context: { requestId: "r-1" },
          },
          null,
          2,
        ) +
        "```",
    );
  });

  it("uses SLACK_CHANNEL and SLACK_USER_NAME when set", async () => {
    vi.stubEnv("SLACK_CHANNEL", "#alerts");
    vi.stubEnv("SLACK_USER_NAME", "yyt-bot");

    const logger = useLogger({ componentName: "c", fileName: "f" });
    logger.fatal({}, "down");
    await flushSlack();

    const body = slackBody(fetchMock);
    expect(body.channel).toBe("#alerts");
    expect(body.username).toBe("yyt-bot");
    expect(body.text.startsWith("[FATAL] down\n")).toBe(true);
  });

  it("does not post to Slack when SLACK_WEBHOOK_URL is missing", async () => {
    vi.stubEnv("SLACK_WEBHOOK_URL", "");

    const logger = useLogger({ componentName: "c", fileName: "f" });
    logger.error({}, "nobody hears this");
    await expect(logger.flushSlack()).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("writes everything to console but only warn+ to Slack by default", async () => {
    const logger = useLogger({ componentName: "c", fileName: "f" });
    logger.trace({}, "t");
    logger.debug({}, "d");
    logger.info({}, "i");
    logger.warn({}, "w");
    await flushSlack();

    expect(console.log).toHaveBeenCalledTimes(4);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(slackBody(fetchMock).text.startsWith("[WARN] w\n")).toBe(true);
  });

  it("honors CONSOLE_LOG_LEVEL and SLACK_LOG_LEVEL envs", async () => {
    vi.stubEnv("CONSOLE_LOG_LEVEL", "error");
    vi.stubEnv("SLACK_LOG_LEVEL", "fatal");

    const logger = useLogger({ componentName: "c", fileName: "f" });
    logger.warn({}, "skipped everywhere");
    logger.error({}, "console only");
    logger.fatal({}, "both");
    await flushSlack();

    expect(console.log).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(slackBody(fetchMock).text.startsWith("[FATAL] both\n")).toBe(true);
  });

  it("honors explicit consoleLevel/slackLevel over envs", async () => {
    vi.stubEnv("SLACK_LOG_LEVEL", "fatal");

    const logger = useLogger({
      componentName: "c",
      fileName: "f",
      consoleLevel: LogLevel.silent,
      slackLevel: LogLevel.info,
    });
    logger.info({}, "to slack only");
    await flushSlack();

    expect(console.log).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("batches records in order on a single chain", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const texts: string[] = [];
    fetchMock.mockImplementation(async (...args: unknown[]) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      const { body } = args[1] as { body: string };
      texts.push((JSON.parse(body) as { text: string }).text.split("\n")[0]!);
      inFlight -= 1;
      return { text: () => Promise.resolve("ok") };
    });

    const logger = useLogger({ componentName: "c", fileName: "f" });
    logger.warn({}, "first");
    logger.error({}, "second");
    logger.fatal({}, "third");
    await logger.flushSlack();

    expect(texts).toEqual(["[WARN] first", "[ERROR] second", "[FATAL] third"]);
    expect(maxInFlight).toBe(1);
  });

  it("serializes Error values found in the context", async () => {
    const error = new Error("kaboom");
    const context: Record<string, unknown> = { error, plain: "kept" };

    const logger = useLogger({ componentName: "c", fileName: "f" });
    logger.error(context, "failed");
    await flushSlack();

    const text = slackBody(fetchMock).text;
    expect(text).toContain('"message": "kaboom"');
    expect(text).toContain('"name": "Error"');
    expect(text).toContain('"plain": "kept"');
    // Legacy behavior: the context object is mutated in place.
    expect(context.error).not.toBeInstanceOf(Error);
    expect((context.error as { message: string }).message).toBe("kaboom");
  });

  it("passes non-object contexts through untouched", async () => {
    const logger = useLogger({ componentName: "c", fileName: "f" });
    logger.error("just a string", "failed");
    await flushSlack();

    expect(slackBody(fetchMock).text).toContain('"context": "just a string"');
  });

  it("truncates the serialized context to maxSlackTextLength", async () => {
    const logger = useLogger({
      componentName: "c",
      fileName: "f",
      maxSlackTextLength: 10,
    });
    logger.error({ padding: "x".repeat(100) }, "big");
    await flushSlack();

    const text = slackBody(fetchMock).text;
    expect(text).toBe("[ERROR] big\n```" + '{\n  "times' + "```");
  });

  it("swallows webhook failures and keeps the chain alive", async () => {
    fetchMock.mockRejectedValueOnce(new Error("network down"));

    const logger = useLogger({ componentName: "c", fileName: "f" });
    logger.error({}, "lost");
    await logger.flushSlack();

    expect(console.error).toHaveBeenCalledWith(
      "Cannot send a message to slack",
      expect.any(Error),
    );

    logger.error({}, "delivered");
    await logger.flushSlack();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(slackBody(fetchMock, 1).text.startsWith("[ERROR] delivered")).toBe(
      true,
    );
  });

  it("logs the webhook response body via console.debug", async () => {
    fetchMock = createFetchMock("slack says ok");
    vi.stubGlobal("fetch", fetchMock);

    const logger = useLogger({ componentName: "c", fileName: "f" });
    logger.error({}, "ping");
    await flushSlack();

    expect(console.debug).toHaveBeenCalledWith(
      "Into the Slack",
      "slack says ok",
    );
  });
});

describe("getLogger", () => {
  it("builds a logger from componentName and fileName", async () => {
    const logger = getLogger("api", "handler.ts");
    logger.warn({}, "heads up");
    await logger.flushSlack();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(slackBody(fetchMock).text).toContain('"componentName": "api"');
    expect(slackBody(fetchMock).text).toContain('"fileName": "handler.ts"');
  });
});

describe("asYlogger", () => {
  it("adapts the slack logger to the @yingyeothon/logger interface", async () => {
    vi.stubEnv("SLACK_LOG_LEVEL", "debug");
    const ylogger = asYlogger(getLogger("comp", "file"));

    expect(ylogger.severity).toBe("debug");
    ylogger.info("joined", "words", 3);
    await flushSlack();

    expect(
      slackBody(fetchMock).text.startsWith("[INFO] joined words 3\n"),
    ).toBe(true);
  });

  it("derives severity from CONSOLE_LOG_LEVEL, defaulting to info", () => {
    expect(asYlogger(getLogger("c", "f")).severity).toBe("info");
    vi.stubEnv("CONSOLE_LOG_LEVEL", "error");
    expect(asYlogger(getLogger("c", "f")).severity).toBe("error");
  });
});

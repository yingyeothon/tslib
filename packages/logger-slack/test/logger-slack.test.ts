import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createSlackLogger,
  createSlackLogWriter,
  slackLogWriterOptionsFromEnv,
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
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("createSlackLogWriter", () => {
  it("posts to the webhook URL with the batched payload shape", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-08-20T01:02:03.000Z"));

    const writer = createSlackLogWriter({ webhookUrl: WEBHOOK_URL });
    writer.error("boom happened", { requestId: "r-1" });
    await writer.flush();

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
            context: { requestId: "r-1" },
          },
          null,
          2,
        ) +
        "```",
    );
  });

  it("sends channel and userName when provided", async () => {
    const writer = createSlackLogWriter({
      webhookUrl: WEBHOOK_URL,
      channel: "#alerts",
      userName: "yyt-bot",
    });
    writer.warn("down");
    await writer.flush();

    const body = slackBody(fetchMock);
    expect(body.channel).toBe("#alerts");
    expect(body.username).toBe("yyt-bot");
    expect(body.text).toBe("[WARN] down");
  });

  it("does nothing when webhookUrl is missing", async () => {
    const writer = createSlackLogWriter();
    writer.error("nobody hears this");
    await expect(writer.flush()).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
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

    const writer = createSlackLogWriter({ webhookUrl: WEBHOOK_URL });
    writer.warn("first");
    writer.error("second");
    writer.info("third");
    await writer.flush();

    expect(texts).toEqual(["[WARN] first", "[ERROR] second", "[INFO] third"]);
    expect(maxInFlight).toBe(1);
  });

  it("keeps pending state per writer, not module-global", async () => {
    const a = createSlackLogWriter({ webhookUrl: WEBHOOK_URL });
    const b = createSlackLogWriter();
    a.error("only a posts");
    b.error("b skips");
    await Promise.all([a.flush(), b.flush()]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("serializes Error values without mutating the caller's context", async () => {
    const error = new Error("kaboom");
    const context: Record<string, unknown> = { error, plain: "kept" };

    const writer = createSlackLogWriter({ webhookUrl: WEBHOOK_URL });
    writer.error("failed", context);
    await writer.flush();

    const text = slackBody(fetchMock).text;
    expect(text).toContain('"message": "kaboom"');
    expect(text).toContain('"name": "Error"');
    expect(text).toContain('"plain": "kept"');
    expect(context.error).toBe(error);
  });

  it("serializes a bare Error argument", async () => {
    const writer = createSlackLogWriter({ webhookUrl: WEBHOOK_URL });
    writer.error("failed", new Error("bare"));
    await writer.flush();

    expect(slackBody(fetchMock).text).toContain('"message": "bare"');
  });

  it("collects multiple extra arguments into a context array", async () => {
    const writer = createSlackLogWriter({ webhookUrl: WEBHOOK_URL });
    writer.info("multi", { a: 1 }, "second");
    await writer.flush();

    const text = slackBody(fetchMock).text;
    expect(text.startsWith("[INFO] multi\n")).toBe(true);
    expect(text).toContain('"a": 1');
    expect(text).toContain('"second"');
  });

  it("truncates the serialized context to maxTextLength", async () => {
    const writer = createSlackLogWriter({
      webhookUrl: WEBHOOK_URL,
      maxTextLength: 10,
    });
    writer.error("big", { padding: "x".repeat(100) });
    await writer.flush();

    expect(slackBody(fetchMock).text).toBe(
      "[ERROR] big\n```" + '{\n  "times' + "```",
    );
  });

  it("reports webhook failures via onDeliveryError and keeps the chain alive", async () => {
    fetchMock.mockRejectedValueOnce(new Error("network down"));
    const onDeliveryError = vi.fn();

    const writer = createSlackLogWriter({
      webhookUrl: WEBHOOK_URL,
      onDeliveryError,
    });
    writer.error("lost");
    await writer.flush();

    expect(onDeliveryError).toHaveBeenCalledWith(expect.any(Error));

    writer.error("delivered");
    await writer.flush();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(slackBody(fetchMock, 1).text).toBe("[ERROR] delivered");
  });

  it("swallows webhook failures silently without onDeliveryError", async () => {
    fetchMock.mockRejectedValueOnce(new Error("network down"));

    const writer = createSlackLogWriter({ webhookUrl: WEBHOOK_URL });
    writer.error("lost");
    await expect(writer.flush()).resolves.toBeUndefined();
  });
});

describe("createSlackLogger", () => {
  it("filters below the default warn severity", async () => {
    const logger = createSlackLogger({ webhookUrl: WEBHOOK_URL });
    logger.debug("d");
    logger.info("i");
    logger.warn("w");
    logger.error("e");
    await logger.flush();

    expect(logger.severity).toBe("warn");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(slackBody(fetchMock, 0).text).toBe("[WARN] w");
    expect(slackBody(fetchMock, 1).text).toBe("[ERROR] e");
  });

  it("honors an explicit severity", async () => {
    const logger = createSlackLogger({
      webhookUrl: WEBHOOK_URL,
      severity: "debug",
    });
    logger.debug("visible");
    await logger.flush();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(slackBody(fetchMock).text).toBe("[DEBUG] visible");
  });

  it("logs nothing at severity none", async () => {
    const logger = createSlackLogger({
      webhookUrl: WEBHOOK_URL,
      severity: "none",
    });
    logger.error("dropped");
    await logger.flush();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("also writes to the console when withConsole is set", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);

    const logger = createSlackLogger({
      webhookUrl: WEBHOOK_URL,
      severity: "info",
      withConsole: true,
    });
    logger.info("both", { requestId: "r-1" });
    await logger.flush();

    expect(info).toHaveBeenCalledWith("both", { requestId: "r-1" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(slackBody(fetchMock).text.startsWith("[INFO] both\n")).toBe(true);
  });
});

describe("slackLogWriterOptionsFromEnv", () => {
  it("reads the documented variables", () => {
    vi.stubEnv("SLACK_WEBHOOK_URL", WEBHOOK_URL);
    vi.stubEnv("SLACK_CHANNEL", "#alerts");
    vi.stubEnv("SLACK_USER_NAME", "yyt-bot");

    expect(slackLogWriterOptionsFromEnv()).toEqual({
      webhookUrl: WEBHOOK_URL,
      channel: "#alerts",
      userName: "yyt-bot",
    });
  });

  it("returns undefined fields when the variables are unset", () => {
    delete process.env.SLACK_WEBHOOK_URL;
    delete process.env.SLACK_CHANNEL;
    delete process.env.SLACK_USER_NAME;

    expect(slackLogWriterOptionsFromEnv()).toEqual({
      webhookUrl: undefined,
      channel: undefined,
      userName: undefined,
    });
  });
});

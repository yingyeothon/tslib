import type { LogWriter } from "@yingyeothon/logger";
import { serializeError } from "serialize-error";

export interface SlackLogWriterOptions {
  webhookUrl?: string;
  channel?: string;
  userName?: string;
  maxTextLength?: number;
  onDeliveryError?: (error: unknown) => void;
}

export interface SlackLogWriter extends LogWriter {
  flush: () => Promise<void>;
}

type Level = "debug" | "info" | "warn" | "error";

export function createSlackLogWriter({
  webhookUrl,
  channel,
  userName = "Logger",
  maxTextLength = 24 * 1024,
  onDeliveryError,
}: SlackLogWriterOptions = {}): SlackLogWriter {
  let pending: Promise<void> = Promise.resolve();

  async function post(text: string): Promise<void> {
    if (!webhookUrl) {
      return;
    }
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        text,
        channel,
        username: userName,
      }),
    });
    await response.text();
  }

  function write(level: Level) {
    const levelLabel = level.toUpperCase();
    return function (...args: unknown[]): void {
      if (!webhookUrl) {
        return;
      }
      const text = formatRecord(levelLabel, args, maxTextLength);
      pending = pending
        .then(() => post(text))
        .catch((error) => {
          onDeliveryError?.(error);
        });
    };
  }

  return {
    debug: write("debug"),
    info: write("info"),
    warn: write("warn"),
    error: write("error"),
    flush: () => pending,
  };
}

function formatRecord(
  levelLabel: string,
  args: unknown[],
  maxTextLength: number,
): string {
  const [message, ...rest] = args;
  const head = `[${levelLabel}] ${stringify(message)}`;
  if (rest.length === 0) {
    return head;
  }
  const context = rest.length === 1 ? rest[0] : rest;
  const content = JSON.stringify(
    {
      timestamp: new Date().toISOString(),
      context: withSerializedErrors(context),
    },
    null,
    2,
  ).slice(0, maxTextLength);
  return head + "\n```" + content + "```";
}

function stringify(message: unknown): string {
  if (message === undefined) {
    return "";
  }
  return typeof message === "string" ? message : JSON.stringify(message);
}

function withSerializedErrors(context: unknown): unknown {
  if (context instanceof Error) {
    return serializeError(context);
  }
  if (Array.isArray(context)) {
    return context.map(withSerializedErrors);
  }
  if (context instanceof Object) {
    return Object.fromEntries(
      Object.entries(context as Record<string, unknown>).map(([key, value]) => [
        key,
        value instanceof Error ? serializeError(value) : value,
      ]),
    );
  }
  return context;
}

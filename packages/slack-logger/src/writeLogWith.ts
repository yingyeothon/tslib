import { globalContext } from "./globalContext.js";
import type { LogLevelValue } from "./logLevel.js";
import { toLogLevelName } from "./logLevel.js";
import { postToSlack } from "./postToSlack.js";
import { serializeErrorInContext } from "./serializeErrorInContext.js";

export interface LogWritePosition {
  componentName: string;
  fileName: string;
}

export interface LogWriteConfig {
  consoleLevel: LogLevelValue;
  slackLevel: LogLevelValue;
  maxSlackTextLength: number;
}

export type LogWriter = (context: unknown, message: string) => void;

export function writeLogWith({
  componentName,
  fileName,
  consoleLevel,
  slackLevel,
  maxSlackTextLength,
}: Required<LogWritePosition & LogWriteConfig>): (
  level: LogLevelValue,
) => LogWriter {
  return function (level: LogLevelValue): LogWriter {
    const levelLabel = toLogLevelName(level).toUpperCase();

    function writeToConsole(context: unknown, message: string): void {
      console.log(now(), componentName, fileName, levelLabel, message, context);
    }

    function writeToSlack(context: unknown, message: string): void {
      serializeErrorInContext(context);
      const content = JSON.stringify(
        { timestamp: now(), componentName, fileName, context },
        null,
        2,
      ).slice(0, maxSlackTextLength);
      globalContext.slackPromise = globalContext.slackPromise
        .then(() =>
          postToSlack(`[${levelLabel}] ${message}\n` + "```" + content + "```"),
        )
        .catch((error) => {
          // Ignore error
          console.error("Cannot send a message to slack", error);
        });
    }

    return function (context: unknown, message: string): void {
      if (consoleLevel <= level) {
        writeToConsole(context, message);
      }
      if (slackLevel <= level) {
        writeToSlack(context, message);
      }
    };
  };
}

function now(): string {
  return new Date().toISOString();
}

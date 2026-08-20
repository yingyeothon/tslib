import type { Logger, LogSeverity } from "@yingyeothon/logger";
import {
  combine,
  consoleWriter,
  createFilteredLogger,
} from "@yingyeothon/logger";
import type { SlackLogWriterOptions } from "./writer.js";
import { createSlackLogWriter } from "./writer.js";

export interface SlackLoggerOptions extends SlackLogWriterOptions {
  severity?: LogSeverity;
  withConsole?: boolean;
}

export interface SlackLogger extends Logger {
  flush: () => Promise<void>;
}

export function createSlackLogger({
  severity = "warn",
  withConsole = false,
  ...writerOptions
}: SlackLoggerOptions = {}): SlackLogger {
  const slackWriter = createSlackLogWriter(writerOptions);
  const writer = withConsole
    ? combine(consoleWriter, slackWriter)
    : slackWriter;
  const logger = createFilteredLogger({ severity, writer });
  return { ...logger, flush: slackWriter.flush };
}

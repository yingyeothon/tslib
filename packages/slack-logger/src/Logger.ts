import type { FlushSlack } from "./flushSlack.js";
import type { LogLevels } from "./logLevel.js";
import type { LogWriter } from "./writeLogWith.js";

export type Logger = { [K in LogLevels]: LogWriter } & {
  flushSlack: FlushSlack;
};

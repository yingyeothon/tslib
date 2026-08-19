import type { Logger } from "./types.js";

export const nullLogger: Logger = {
  severity: "none",
  debug: () => undefined,
  info: () => undefined,
  error: () => undefined,
};

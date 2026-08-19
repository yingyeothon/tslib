import type { Logger } from "./Logger.js";
import { useLogger } from "./useLogger.js";

export function getLogger(componentName: string, fileName: string): Logger {
  return useLogger({
    componentName,
    fileName,
  });
}

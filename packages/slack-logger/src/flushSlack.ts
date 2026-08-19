import { globalContext } from "./globalContext.js";

export type FlushSlack = () => Promise<void>;

export async function flushSlack(): Promise<void> {
  return await globalContext.slackPromise;
}

import type {
  BaseGameContext,
  BaseGameRequest,
  NetworkOptions,
} from "@yingyeothon/lambda-gamebase";
import { processEnter } from "./processEnter.js";
import { processLeave } from "./processLeave.js";

export interface ProcessEnterLeaveOptions {
  context: BaseGameContext;
  message: BaseGameRequest;
  /** Network options (gamebase context or explicit client) for `broadcast`. */
  network?: NetworkOptions;
}

/** Dispatches an "enter" or "leave" request to its processor. */
export async function processEnterLeave({
  context,
  message,
  network,
}: ProcessEnterLeaveOptions): Promise<void> {
  switch (message.type) {
    case "enter":
      return await processEnter({ context, message, network });
    case "leave":
      return processLeave({ context, message });
  }
}

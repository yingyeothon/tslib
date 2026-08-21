import type {
  BaseGameContext,
  BaseGameRequest,
  NetworkOptions,
} from "@yingyeothon/lambda-gamebase";
import type { GameHooks } from "../models/hooks.js";
import { processEnter } from "./processEnter.js";
import { processLeave } from "./processLeave.js";

export interface ProcessEnterLeaveOptions {
  context: BaseGameContext;
  message: BaseGameRequest;
  /** Network options (gamebase context or explicit client) for `broadcast`. */
  network?: NetworkOptions;
  onMemberEntered?: GameHooks["onMemberEntered"];
}

/** Dispatches an "enter" or "leave" request to its processor. */
export async function processEnterLeave({
  context,
  message,
  network,
  onMemberEntered,
}: ProcessEnterLeaveOptions): Promise<void> {
  switch (message.type) {
    case "enter":
      return await processEnter({
        context,
        message,
        network,
        ...(onMemberEntered ? { onMemberEntered } : {}),
      });
    case "leave":
      return processLeave({ context, message });
  }
}

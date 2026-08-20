import type {
  BaseGameContext,
  BaseGameRequest,
} from "@yingyeothon/lambda-gamebase";
import { processEnter } from "./processEnter.js";
import { processLeave } from "./processLeave.js";

/** Dispatches an "enter" or "leave" request to its processor. */
export async function processEnterLeave({
  context,
  message,
}: {
  context: BaseGameContext;
  message: BaseGameRequest;
}): Promise<void> {
  switch (message.type) {
    case "enter":
      return await processEnter({ context, message });
    case "leave":
      return processLeave({ context, message });
  }
}

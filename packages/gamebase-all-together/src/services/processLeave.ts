import type {
  BaseGameConnectionIdRequest,
  BaseGameContext,
} from "@yingyeothon/lambda-gamebase";

export interface ProcessLeaveOptions {
  context: BaseGameContext;
  message: BaseGameConnectionIdRequest;
}

/**
 * Unbinds a leaving connection. A leaving user stays in `users` so they
 * can reconnect later; only the connection mapping is removed.
 */
export function processLeave({
  context,
  message: { connectionId },
}: ProcessLeaveOptions): void {
  const leaver = context.connectedUsers[connectionId];
  const observer = context.observers.find(
    (o) => o.connectionId === connectionId,
  );

  if (observer) {
    observer.connectionId = "";
  } else if (leaver) {
    leaver.connectionId = "";
    leaver.load = false;
    delete context.connectedUsers[connectionId];
  }
}

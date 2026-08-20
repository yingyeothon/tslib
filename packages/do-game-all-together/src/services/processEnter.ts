import {
  broadcast,
  type BaseGameContext,
  type BaseGameEnterRequest,
} from "@yingyeothon/lambda-gamebase";

/**
 * Binds an entering member's connection: observers are silently attached,
 * users are registered as connected and their entrance is broadcast.
 */
export async function processEnter({
  context,
  message: { connectionId, memberId },
}: {
  context: BaseGameContext;
  message: BaseGameEnterRequest;
}): Promise<void> {
  const newbie = context.users.find((u) => u.memberId === memberId);
  const observer = context.observers.find((o) => o.memberId === memberId);
  if (observer) {
    observer.connectionId = connectionId;
  } else if (newbie) {
    newbie.connectionId = connectionId;
    newbie.load = false;

    context.connectedUsers[connectionId] = newbie;
    await broadcast(Object.keys(context.connectedUsers), {
      type: "enter",
      payload: { memberId },
    });
  }
}

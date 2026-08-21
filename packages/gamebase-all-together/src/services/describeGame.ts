import type { BaseGameContext } from "@yingyeothon/lambda-gamebase";

export interface GameDescriptor {
  users: number;
  connected: number;
  observers: number;
}

/**
 * A log-safe summary of a game context. Consumers plug real writers into
 * `Logger` that persist indefinitely, and the context holds every member
 * id and connection id, so counts go to the log instead of the object.
 */
export function describeGame(context: BaseGameContext): GameDescriptor {
  return {
    users: context.users.length,
    connected: Object.keys(context.connectedUsers).length,
    observers: context.observers.length,
  };
}

import {
  broadcast,
  type BaseGameEnterRequest,
  type BaseGameContext,
  type NetworkOptions,
} from "@yingyeothon/lambda-gamebase";
import type { GameHooks, MemberEnteredOptions } from "../models/hooks.js";

export interface ProcessEnterOptions {
  context: BaseGameContext;
  message: BaseGameEnterRequest;
  /** Network options (gamebase context or explicit client) for `broadcast`. */
  network?: NetworkOptions;
  /** Replaces {@link broadcastMemberEntered}. */
  onMemberEntered?: GameHooks["onMemberEntered"];
}

/** The default `onMemberEntered`: announces the member to everyone. */
export function broadcastMemberEntered({
  context,
  memberId,
  network,
}: MemberEnteredOptions): Promise<unknown> {
  return broadcast(
    Object.keys(context.connectedUsers),
    {
      type: "enter",
      payload: { memberId },
    },
    network,
  );
}

/**
 * Binds an entering member's connection: observers are silently attached,
 * users are registered as connected and reported through the
 * `onMemberEntered` hook — which is also where a reconnecting member can
 * be sent the current state.
 */
export async function processEnter({
  context,
  message: { connectionId, memberId },
  network,
  onMemberEntered = broadcastMemberEntered,
}: ProcessEnterOptions): Promise<void> {
  const newbie = context.users.find((u) => u.memberId === memberId);
  const observer = context.observers.find((o) => o.memberId === memberId);
  if (observer) {
    observer.connectionId = connectionId;
  } else if (newbie) {
    // A member who reconnects before its `leave` arrives would otherwise
    // stay in the map under both connection ids, and the wait stage counts
    // those entries to decide whether the party is complete.
    const previous = newbie.connectionId;
    if (
      previous !== "" &&
      previous !== connectionId &&
      context.connectedUsers[previous] === newbie
    ) {
      delete context.connectedUsers[previous];
    }

    newbie.connectionId = connectionId;
    newbie.load = false;

    context.connectedUsers[connectionId] = newbie;
    await onMemberEntered({ context, connectionId, memberId, network });
  }
}

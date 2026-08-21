import {
  broadcast,
  type BaseGameContext,
  type RespondResult,
} from "@yingyeothon/lambda-gamebase";
import type { StageChangedOptions } from "../models/hooks.js";

export type { StageChangedOptions };

/**
 * The default `onStageChanged`: broadcasts the current stage and age to
 * every connected user and reports per-connection delivery.
 */
export function broadcastStage({
  context,
  stage,
  age,
  network,
}: StageChangedOptions): Promise<RespondResult> {
  return broadcast(
    Object.keys(context.connectedUsers),
    {
      type: "stage",
      payload: { stage, age },
    },
    network,
  );
}

export interface PruneUndeliveredUsersOptions {
  context: BaseGameContext;
  /** A `broadcast` result: connection id to whether it was delivered. */
  delivered: RespondResult;
}

/**
 * Unbinds every connection a broadcast could not reach, so a client that
 * vanished without a `$disconnect` stops holding the game open.
 *
 * Delivery also fails on a transient network error, so this evicts a
 * player who might still be there — that is why it is opt-in via
 * `dropUndeliveredConnections` and offered to custom hooks as a helper
 * rather than applied automatically.
 */
export function pruneUndeliveredUsers({
  context,
  delivered,
}: PruneUndeliveredUsersOptions): string[] {
  const undelivered = Object.entries(delivered)
    .filter(([, success]) => !success)
    .map(([connectionId]) => connectionId);
  for (const connectionId of undelivered) {
    const user = context.connectedUsers[connectionId];
    if (user === undefined) {
      continue;
    }
    user.connectionId = "";
    user.load = false;
    delete context.connectedUsers[connectionId];
  }
  return undelivered;
}

import { nullLogger, type Logger } from "@yingyeothon/logger";
import { loadActorStartEvent } from "./loadActorStartEvent.js";
import type { GameActorStartEvent } from "./models/GameActorStartEvent.js";

export interface AuthorizeGameConnectionOptions {
  /** Client-supplied, and therefore the thing being checked. */
  gameId: string;
  /** From a verified principal — never from the client. */
  memberId: string;
  eventKeyPrefix: string;
  /** Reads the start event key, e.g. `(key) => redisGet(connection, key)`. */
  get: (key: string) => Promise<string | null>;
  /** Log context only, so a refusal stays attributable to one connection. */
  connectionId?: string;
  logger?: Logger;
}

export type GameConnectionAuthorization =
  | { authorized: true; startEvent: GameActorStartEvent }
  | { authorized: false; reason: "unknownGame" | "notAMember" };

/**
 * Decides whether a member may speak for a game.
 *
 * A token proves who the caller is, not which game they belong to, so this
 * is the check that a JWT cannot make on its own — and `gameId` arrives
 * from the client. A gateway that skips it lets anyone push messages into
 * any game's queue, so a gateway replacing `handleConnect` owns this and
 * should call it rather than re-derive it.
 */
export async function authorizeGameConnection({
  gameId,
  memberId,
  eventKeyPrefix,
  get,
  connectionId,
  logger = nullLogger,
}: AuthorizeGameConnectionOptions): Promise<GameConnectionAuthorization> {
  const startEvent = await loadActorStartEvent({ gameId, get, eventKeyPrefix });
  if (startEvent === null) {
    logger.error("invalid game context from gameId", { gameId, connectionId });
    return { authorized: false, reason: "unknownGame" };
  }
  if (startEvent.members.every((member) => member.memberId !== memberId)) {
    // `members` carries names and e-mail addresses; log the count only.
    logger.error("not registered member", {
      gameId,
      memberId,
      connectionId,
      memberCount: startEvent.members.length,
    });
    return { authorized: false, reason: "notAMember" };
  }
  return { authorized: true, startEvent };
}

import type { BaseGameContext } from "../models/BaseGameContext.js";
import type { BaseGameObserver } from "../models/BaseGameObserver.js";
import type { BaseGameUser } from "../models/BaseGameUser.js";
import type { GameStartMember } from "../models/GameStartMember.js";

/** Builds the initial game context from the starting member list. */
export function setupBaseGameContext(
  members: GameStartMember[],
): BaseGameContext {
  const users = members
    .filter((member) => !member.observer)
    .map((member): BaseGameUser => ({
      connectionId: "",
      load: false,
      memberId: member.memberId,
    }));
  const observers = members
    .filter((member) => member.observer)
    .map((member): BaseGameObserver => ({
      memberId: member.memberId,
      connectionId: "",
    }));
  return { users, observers, connectedUsers: {} };
}

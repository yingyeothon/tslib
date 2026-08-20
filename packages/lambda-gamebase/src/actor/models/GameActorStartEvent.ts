import type { GameStartMember } from "../../models/GameStartMember.js";

export interface GameActorStartEvent {
  gameId: string;
  members: GameStartMember[];
  callbackUrl?: string;
}

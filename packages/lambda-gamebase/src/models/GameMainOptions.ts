import type { GameStartMember } from "./GameStartMember.js";

export interface GameMainOptions<M> {
  gameId: string;
  members: GameStartMember[];
  pollMessages: () => Promise<M[]>;
}

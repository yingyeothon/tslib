import type { GameStartMember } from "./GameStartMember.js";

export interface GameMainArguments<M> {
  gameId: string;
  members: GameStartMember[];
  pollMessages: () => Promise<M[]>;
}

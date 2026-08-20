import { broadcast, type BaseGameContext } from "@yingyeothon/lambda-gamebase";
import type { GameStage } from "../models/GameStage.js";

/** Broadcasts the current stage and age to every connected user. */
export async function broadcastStage({
  context,
  stage,
  age,
}: {
  context: BaseGameContext;
  stage: GameStage;
  age: number;
}): Promise<void> {
  await broadcast(Object.keys(context.connectedUsers), {
    type: "stage",
    payload: { stage, age },
  });
}

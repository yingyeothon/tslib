import {
  broadcast,
  type BaseGameContext,
  type NetworkOptions,
} from "@yingyeothon/lambda-gamebase";
import type { GameStage } from "../models/GameStage.js";

export interface BroadcastStageOptions {
  context: BaseGameContext;
  stage: GameStage;
  age: number;
  /** Network options (gamebase context or explicit client) for `broadcast`. */
  network?: NetworkOptions;
}

/** Broadcasts the current stage and age to every connected user. */
export async function broadcastStage({
  context,
  stage,
  age,
  network,
}: BroadcastStageOptions): Promise<void> {
  await broadcast(
    Object.keys(context.connectedUsers),
    {
      type: "stage",
      payload: { stage, age },
    },
    network,
  );
}

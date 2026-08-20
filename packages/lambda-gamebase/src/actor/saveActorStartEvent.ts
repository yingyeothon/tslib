import type { GameActorStartEvent } from "./models/GameActorStartEvent.js";

export async function saveActorStartEvent({
  event,
  set,
  eventKeyPrefix,
}: {
  event: GameActorStartEvent;
  set: (key: string, value: string) => Promise<unknown>;
  eventKeyPrefix: string;
}): Promise<boolean> {
  if (!event.gameId) {
    return false;
  }
  await set(eventKeyPrefix + event.gameId, JSON.stringify(event));
  return true;
}

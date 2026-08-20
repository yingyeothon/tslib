import type { GameActorStartEvent } from "./models/GameActorStartEvent.js";

export async function loadActorStartEvent({
  gameId,
  get,
  eventKeyPrefix,
}: {
  gameId: string;
  get: (key: string) => Promise<string | null>;
  eventKeyPrefix: string;
}): Promise<GameActorStartEvent | null> {
  const value = await get(eventKeyPrefix + gameId);
  if (value === null) {
    return null;
  }
  try {
    const event = JSON.parse(value) as GameActorStartEvent;
    if (!event.gameId) {
      return null;
    }
    return event;
  } catch {
    // A malformed event is treated as missing.
  }
  return null;
}

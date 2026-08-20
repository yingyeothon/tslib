export async function clearActorStartEvent({
  gameId,
  del,
  eventKeyPrefix,
}: {
  gameId: string;
  del: (key: string) => Promise<unknown>;
  eventKeyPrefix: string;
}): Promise<unknown> {
  return del(eventKeyPrefix + gameId);
}

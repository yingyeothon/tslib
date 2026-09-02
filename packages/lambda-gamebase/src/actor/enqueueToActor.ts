import { enqueue } from "@yingyeothon/actor-system";
import { createRedisQueue } from "@yingyeothon/actor-system-redis";
import type { Logger } from "@yingyeothon/logger";
import type { RedisConnection } from "@yingyeothon/naive-redis";

export interface EnqueueToActorOptions {
  connection: RedisConnection;
  gameId: string;
  actorQueueKeyPrefix: string;
  /** TTL re-applied to the queue key on this push. */
  queueTtlSeconds: number;
  logger: Logger;
  item: unknown;
}

/**
 * Pushes one item onto a game actor's Redis queue: the shape every
 * gateway handler (`$connect`, `$default`, `$disconnect`) shares.
 */
export async function enqueueToActor({
  connection,
  gameId,
  actorQueueKeyPrefix,
  queueTtlSeconds,
  logger,
  item,
}: EnqueueToActorOptions): Promise<void> {
  await enqueue(
    {
      id: gameId,
      queue: createRedisQueue({
        connection,
        keyPrefix: actorQueueKeyPrefix,
        logger,
        ttlSeconds: queueTtlSeconds,
      }),
      logger,
    },
    { item },
  );
}

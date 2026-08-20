import { enqueue } from "@yingyeothon/actor-system";
import { createRedisQueue } from "@yingyeothon/actor-system-redis";
import { nullLogger, type Logger } from "@yingyeothon/logger";
import {
  redisDel,
  redisGet,
  type RedisConnection,
} from "@yingyeothon/naive-redis";
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { requireRedisOptions, type GamebaseContext } from "../context.js";
import { useRedis } from "../infra/useRedis.js";
import { OK } from "./responses.js";

export interface HandleDisconnectOptions {
  event: APIGatewayProxyEvent;
  connectionIdAndGameIdKeyPrefix: string;
  actorQueueKeyPrefix: string;
  logger?: Logger;
  /** Supplies Redis options for a short-lived, per-invocation connection. */
  context?: GamebaseContext;
  /** Overrides the per-invocation Redis connection, e.g. in tests. */
  redisConnection?: RedisConnection;
}

/**
 * `$disconnect` handler: looks up the game bound to the connection id,
 * enqueues a "leave" message to the actor, and removes the mapping.
 */
export async function handleDisconnect({
  event,
  connectionIdAndGameIdKeyPrefix,
  actorQueueKeyPrefix,
  logger = nullLogger,
  context,
  redisConnection,
}: HandleDisconnectOptions): Promise<APIGatewayProxyResult> {
  const { connectionId } = event.requestContext;

  async function withConnection(connection: RedisConnection): Promise<void> {
    const gameId = await redisGet(
      connection,
      connectionIdAndGameIdKeyPrefix + connectionId,
    );
    logger.info("game id", { connectionId, gameId });

    // Send a leave message to the actor queue and delete the mapping.
    if (!gameId) {
      return;
    }
    await enqueue(
      {
        id: gameId,
        queue: createRedisQueue({
          connection,
          keyPrefix: actorQueueKeyPrefix,
          logger,
        }),
        logger,
      },
      { item: { type: "leave", connectionId } },
    );
    await redisDel(connection, connectionIdAndGameIdKeyPrefix + connectionId);
    logger.info("cleanup and game leaved", { connectionId, gameId });
  }

  if (redisConnection) {
    await withConnection(redisConnection);
    return OK;
  }
  if (!context) {
    throw new Error(
      "handleDisconnect requires either redisConnection or context",
    );
  }
  await useRedis(withConnection, requireRedisOptions(context.options));
  return OK;
}

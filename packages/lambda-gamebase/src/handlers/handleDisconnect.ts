import { enqueue } from "@yingyeothon/actor-system";
import { RedisQueue } from "@yingyeothon/actor-system-redis-support";
import { ConsoleLogger, type Logger } from "@yingyeothon/logger";
import {
  redisDel,
  redisGet,
  type RedisConnection,
} from "@yingyeothon/naive-redis";
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { useRedis } from "../infra/useRedis.js";
import { OK } from "./responses.js";

const defaultLogger = new ConsoleLogger("debug");

export interface HandleDisconnectArgs {
  event: APIGatewayProxyEvent;
  connectionIdAndGameIdKeyPrefix: string;
  actorQueueKeyPrefix: string;
  logger?: Logger;
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
  logger = defaultLogger,
  redisConnection,
}: HandleDisconnectArgs): Promise<APIGatewayProxyResult> {
  const { connectionId } = event.requestContext;

  async function withConnection(connection: RedisConnection): Promise<void> {
    const gameId = await redisGet(
      connection,
      connectionIdAndGameIdKeyPrefix + connectionId,
    );
    logger.info({ connectionId, gameId }, "Game id");

    // Send a leave message to the actor queue and delete the mapping.
    if (!gameId) {
      return;
    }
    await enqueue(
      {
        id: gameId,
        queue: new RedisQueue({
          connection,
          keyPrefix: actorQueueKeyPrefix,
          logger,
        }),
        logger,
      },
      { item: { type: "leave", connectionId } },
    );
    await redisDel(connection, connectionIdAndGameIdKeyPrefix + connectionId);
    logger.info({ connectionId, gameId }, "Cleanup and game leaved");
  }

  await (redisConnection
    ? withConnection(redisConnection)
    : useRedis(withConnection));
  return OK;
}

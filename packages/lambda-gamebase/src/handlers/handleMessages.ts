import { enqueue } from "@yingyeothon/actor-system";
import { createRedisQueue } from "@yingyeothon/actor-system-redis";
import { nullLogger, type Logger } from "@yingyeothon/logger";
import { redisGet, type RedisConnection } from "@yingyeothon/naive-redis";
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import type { GamebaseContext } from "../context.js";
import { NotFound, OK } from "./responses.js";

export interface HandleMessagesOptions<M> {
  event: APIGatewayProxyEvent;
  connectionIdAndGameIdKeyPrefix: string;
  actorQueueKeyPrefix: string;
  validateMessage: (maybe: M) => boolean;
  logger?: Logger;
  /** Supplies the shared Redis connection when `redisConnection` is unset. */
  context?: GamebaseContext;
  /** Overrides the context's Redis connection, e.g. in tests. */
  redisConnection?: RedisConnection;
}

/**
 * `$default` handler: validates the client message, resolves the game
 * bound to the connection id, and enqueues the message (stamped with the
 * connection id) to the actor.
 */
export async function handleMessages<M>({
  event,
  connectionIdAndGameIdKeyPrefix,
  actorQueueKeyPrefix,
  validateMessage,
  logger = nullLogger,
  context,
  redisConnection,
}: HandleMessagesOptions<M>): Promise<APIGatewayProxyResult> {
  if (!event.body) {
    return NotFound;
  }

  const { connectionId } = event.requestContext;

  // Parse and validate a message from the client.
  let request: M;
  try {
    request = JSON.parse(event.body) as M;
    if (!validateMessage(request)) {
      logger.error("invalid message", { connectionId, request });
      return NotFound;
    }
  } catch (error) {
    logger.error("invalid message", { connectionId, error });
    return NotFound;
  }

  const connection = redisConnection ?? context?.getRedisConnection();
  if (!connection) {
    throw new Error(
      "handleMessages requires either redisConnection or context",
    );
  }

  // Read the gameId bound to this connectionId.
  const gameId = await redisGet(
    connection,
    connectionIdAndGameIdKeyPrefix + connectionId,
  );
  logger.info("game id", { connectionId, gameId });
  if (!gameId) {
    logger.error("no gameId for connection", { connectionId });
    return NotFound;
  }

  // Encode the game message and send it to the actor queue.
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
    { item: { ...request, connectionId } },
  );
  logger.info("game message sent", { connectionId, gameId, request });
  return OK;
}

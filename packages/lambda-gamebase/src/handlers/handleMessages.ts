import { enqueue } from "@yingyeothon/actor-system";
import { RedisQueue } from "@yingyeothon/actor-system-redis-support";
import { ConsoleLogger, type Logger } from "@yingyeothon/logger";
import { redisGet, type RedisConnection } from "@yingyeothon/naive-redis";
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { getRedisConnection } from "../infra/redisConnection.js";
import { NotFound, OK } from "./responses.js";

const defaultLogger = new ConsoleLogger("debug");

export interface HandleMessagesArgs<M> {
  event: APIGatewayProxyEvent;
  connectionIdAndGameIdKeyPrefix: string;
  actorQueueKeyPrefix: string;
  validateMessage: (maybe: M) => boolean;
  logger?: Logger;
  /** Overrides the shared Redis connection, e.g. in tests. */
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
  logger = defaultLogger,
  redisConnection,
}: HandleMessagesArgs<M>): Promise<APIGatewayProxyResult> {
  if (!event.body) {
    return NotFound;
  }

  const { connectionId } = event.requestContext;

  // Parse and validate a message from the client.
  let request: M;
  try {
    request = JSON.parse(event.body) as M;
    if (!validateMessage(request)) {
      logger.error({ connectionId, request }, "Invalid message");
      return NotFound;
    }
  } catch (error) {
    logger.error({ connectionId, error }, "Invalid message");
    return NotFound;
  }

  const connection = redisConnection ?? getRedisConnection();

  // Read the gameId bound to this connectionId.
  const gameId = await redisGet(
    connection,
    connectionIdAndGameIdKeyPrefix + connectionId,
  );
  logger.info({ connectionId, gameId }, "Game id");
  if (!gameId) {
    logger.error({ connectionId }, "No GameID for connection");
    return NotFound;
  }

  // Encode the game message and send it to the actor queue.
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
    { item: { ...request, connectionId } },
  );
  logger.info({ connectionId, gameId, request }, "Game message sent");
  return OK;
}

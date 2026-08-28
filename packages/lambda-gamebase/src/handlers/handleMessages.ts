import { enqueue } from "@yingyeothon/actor-system";
import { createRedisQueue } from "@yingyeothon/actor-system-redis";
import { nullLogger, type Logger } from "@yingyeothon/logger";
import {
  redisExpire,
  redisGet,
  type RedisConnection,
} from "@yingyeothon/naive-redis";
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import type { GamebaseContext } from "../context.js";
import { isReservedRequestType } from "../requests/reserved.js";
import { defaultConnectionMappingTtlMillis } from "./handleConnect.js";
import { BadRequest, NotFound, OK } from "./responses.js";

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
  /**
   * Lifetime the `connectionId -> gameId` mapping is refreshed to on every
   * inbound message. Must match `handleConnect`'s. Default: 900000.
   */
  connectionMappingTtlMillis?: number;
  /**
   * TTL re-applied to the actor's queue key on every push, so a queue
   * nobody drains disappears instead of growing forever behind a dead
   * actor. The producer is the only party that can set it — the actor
   * itself never pushes. Required: every runtime key carries a TTL.
   */
  queueTtlSeconds: number;
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
  connectionMappingTtlMillis = defaultConnectionMappingTtlMillis,
  queueTtlSeconds,
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
      // The body may hold PII, so only the shape of the failure is logged.
      logger.error("invalid message", { connectionId });
      return NotFound;
    }
  } catch (error) {
    // A JSON.parse failure names the input it choked on, and the body may
    // hold PII, so only the error's name survives.
    logger.error("invalid message", {
      connectionId,
      error: error instanceof Error ? error.name : "unknown",
    });
    return NotFound;
  }

  // `enter`/`leave` are produced by the connection handlers and decide
  // which member a connection speaks for. Accepting them from a client
  // would let one member bind another member's slot to its own
  // connection, so they are refused here rather than in the game loop.
  const requestType = (request as { type?: unknown }).type;
  if (isReservedRequestType(requestType)) {
    logger.error("reserved message type from a client", {
      connectionId,
      type: requestType,
    });
    return BadRequest;
  }

  const connection = redisConnection ?? context?.getRedisConnection();
  if (!connection) {
    throw new Error(
      "handleMessages requires either redisConnection or context",
    );
  }

  // Read the gameId bound to this connectionId.
  const mappingKey = connectionIdAndGameIdKeyPrefix + connectionId;
  const gameId = await redisGet(connection, mappingKey);
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
        ttlSeconds: queueTtlSeconds,
      }),
      logger,
    },
    { item: { ...request, connectionId } },
  );

  // Keep the routing entry alive for as long as the connection is used;
  // without this a session outliving the mapping stops resolving its game.
  //
  // Housekeeping, so it runs after the delivery and cannot prevent one: a
  // blip here would otherwise drop the player's message on the floor, and
  // the next message refreshes the mapping anyway.
  try {
    await redisExpire(
      connection,
      mappingKey,
      Math.ceil(connectionMappingTtlMillis / 1000),
    );
  } catch (error) {
    logger.warn("cannot refresh the connection mapping", {
      connectionId,
      error,
    });
  }
  logger.info("game message sent", {
    connectionId,
    gameId,
    type: requestType,
  });
  return OK;
}

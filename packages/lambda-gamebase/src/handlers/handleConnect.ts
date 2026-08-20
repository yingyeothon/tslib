import { enqueue } from "@yingyeothon/actor-system";
import { createRedisQueue } from "@yingyeothon/actor-system-redis";
import { nullLogger, type Logger } from "@yingyeothon/logger";
import {
  redisGet,
  redisSet,
  type RedisConnection,
} from "@yingyeothon/naive-redis";
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { loadActorStartEvent } from "../actor/loadActorStartEvent.js";
import { requireRedisOptions, type GamebaseContext } from "../context.js";
import { useRedis } from "../infra/useRedis.js";
import { BadRequest, OK } from "./responses.js";

const expirationMillis = 900 * 1000;

export interface HandleConnectOptions {
  event: APIGatewayProxyEvent;
  connectionIdAndGameIdKeyPrefix: string;
  actorEventKeyPrefix: string;
  actorQueueKeyPrefix: string;
  logger?: Logger;
  /** Supplies Redis options for a short-lived, per-invocation connection. */
  context?: GamebaseContext;
  /** Overrides the per-invocation Redis connection, e.g. in tests. */
  redisConnection?: RedisConnection;
}

/**
 * `$connect` handler: validates the game id and member id sent by the
 * client (via `x-game-id` / `x-member-id` header or query string), maps the
 * connection id to the game, and enqueues an "enter" message to the actor.
 */
export async function handleConnect({
  event,
  connectionIdAndGameIdKeyPrefix,
  actorEventKeyPrefix,
  actorQueueKeyPrefix,
  logger = nullLogger,
  context,
  redisConnection,
}: HandleConnectOptions): Promise<APIGatewayProxyResult> {
  function getParameter(key: string): string | undefined {
    return event.headers[key] ?? (event.queryStringParameters ?? {})[key];
  }

  const { connectionId } = event.requestContext;
  // A client should send a "X-GAME-ID" via HTTP header.
  const gameId = getParameter("x-game-id");
  const memberId = getParameter("x-member-id");

  // Validate starting information.
  if (!gameId || !memberId) {
    logger.error("invalid gameId from connection", { connectionId });
    return BadRequest;
  }
  const checkedGameId: string = gameId;

  async function withConnection(
    connection: RedisConnection,
  ): Promise<APIGatewayProxyResult> {
    const startEvent = await loadActorStartEvent({
      gameId: checkedGameId,
      get: (key) => redisGet(connection, key),
      eventKeyPrefix: actorEventKeyPrefix,
    });
    if (startEvent === null) {
      logger.error("invalid game context from gameId", { gameId });
      return BadRequest;
    }
    if (startEvent.members.every((m) => m.memberId !== memberId)) {
      logger.error("not registered member", { startEvent, memberId });
      return BadRequest;
    }

    // Register the connection and start a game.
    await redisSet(
      connection,
      connectionIdAndGameIdKeyPrefix + connectionId,
      checkedGameId,
      { expirationMillis },
    );
    await enqueue(
      {
        id: checkedGameId,
        queue: createRedisQueue({
          connection,
          keyPrefix: actorQueueKeyPrefix,
          logger,
        }),
        logger,
      },
      { item: { type: "enter", connectionId, memberId } },
    );
    logger.info("game logged", { gameId, connectionId });
    return OK;
  }

  if (redisConnection) {
    return withConnection(redisConnection);
  }
  if (!context) {
    throw new Error("handleConnect requires either redisConnection or context");
  }
  return useRedis(withConnection, requireRedisOptions(context.options));
}

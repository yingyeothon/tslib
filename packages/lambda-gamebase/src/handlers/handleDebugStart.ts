import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { nullLogger, type Logger } from "@yingyeothon/logger";
import { redisDel, type RedisConnection } from "@yingyeothon/naive-redis";
import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
} from "aws-lambda";
import type { GameActorStartEvent } from "../actor/models/GameActorStartEvent.js";
import { requireRedisOptions, type GamebaseContext } from "../context.js";
import { useRedis } from "../infra/useRedis.js";
import { NotFound, OK } from "./responses.js";

export interface HandleDebugStartOptions {
  event: APIGatewayProxyEventV2;
  actorLockKeyPrefix: string;
  /**
   * Supplies `isOffline` and `gameActorLambdaName`, plus Redis options for
   * a short-lived connection when `redisConnection` is unset.
   */
  context: GamebaseContext;
  logger?: Logger;
  /** Overrides the Lambda client, e.g. in tests. */
  lambdaClient?: LambdaClient;
  /** Overrides the per-invocation Redis connection, e.g. in tests. */
  redisConnection?: RedisConnection;
}

/**
 * Debug-only handler for serverless-offline: breaks the actor lock of the
 * posted game and invokes the game actor Lambda locally. It answers
 * 404 unless `context.options.isOffline` is set.
 */
export async function handleDebugStart({
  event,
  actorLockKeyPrefix,
  context,
  logger = nullLogger,
  lambdaClient,
  redisConnection,
}: HandleDebugStartOptions): Promise<APIGatewayProxyResultV2> {
  if (!context.options.isOffline || !event.body) {
    return NotFound;
  }

  const startEvent = JSON.parse(event.body) as GameActorStartEvent;
  // The start event carries a name and an email per member, so only its
  // size is logged.
  logger.debug("start for debugging", {
    gameId: startEvent.gameId,
    memberCount: startEvent.members.length,
  });

  async function breakLock(connection: RedisConnection): Promise<void> {
    // A forced break, not a release: this process never acquired the lock,
    // so the token-checked `release` would correctly refuse. Breaking a
    // stale lock by hand is the whole point of this offline-only handler.
    await redisDel(connection, actorLockKeyPrefix + startEvent.gameId);
  }
  await (redisConnection
    ? breakLock(redisConnection)
    : useRedis(breakLock, requireRedisOptions(context.options)));
  logger.debug("break actor's lock", { gameId: startEvent.gameId });

  // Start a new Lambda to process game messages.
  const client =
    lambdaClient ?? new LambdaClient({ endpoint: "http://localhost:3002" });
  const invocation = client.send(
    new InvokeCommand({
      FunctionName: context.options.gameActorLambdaName,
      InvocationType: "Event",
      Qualifier: "$LATEST",
      Payload: Buffer.from(JSON.stringify(startEvent)),
    }),
  );

  if (event.queryStringParameters?.waitSetup) {
    await invocation;
  } else {
    invocation.catch((error: unknown) =>
      logger.error("cannot invoke the game actor lambda", { error }),
    );
  }
  return OK;
}

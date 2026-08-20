import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { createRedisLock } from "@yingyeothon/actor-system-redis";
import { nullLogger, type Logger } from "@yingyeothon/logger";
import type { RedisConnection } from "@yingyeothon/naive-redis";
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
 * Debug-only handler for serverless-offline: releases the actor lock of
 * the posted game and invokes the game actor Lambda locally. It answers
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
  logger.debug("start for debugging", { startEvent });

  async function releaseLock(connection: RedisConnection): Promise<void> {
    await createRedisLock({
      connection,
      keyPrefix: actorLockKeyPrefix,
      logger,
    }).release(startEvent.gameId);
  }
  await (redisConnection
    ? releaseLock(redisConnection)
    : useRedis(releaseLock, requireRedisOptions(context.options)));
  logger.debug("release actor's lock", { gameId: startEvent.gameId });

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

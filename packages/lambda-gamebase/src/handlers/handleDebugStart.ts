import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { RedisLock } from "@yingyeothon/actor-system-redis-support";
import { ConsoleLogger, type Logger } from "@yingyeothon/logger";
import type { RedisConnection } from "@yingyeothon/naive-redis";
import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
} from "aws-lambda";
import type { GameActorStartEvent } from "../actor/models/GameActorStartEvent.js";
import { env } from "../env.js";
import { useRedis } from "../infra/useRedis.js";
import { NotFound, OK } from "./responses.js";

const defaultLogger = new ConsoleLogger("debug");

export interface HandleDebugStartArgs {
  event: APIGatewayProxyEventV2;
  actorLockKeyPrefix: string;
  logger?: Logger;
  /** Overrides the Lambda client, e.g. in tests. */
  lambdaClient?: LambdaClient;
  /** Overrides the per-invocation Redis connection, e.g. in tests. */
  redisConnection?: RedisConnection;
}

/**
 * Debug-only handler for serverless-offline: releases the actor lock of
 * the posted game and invokes the game actor Lambda locally. It answers
 * 404 unless `IS_OFFLINE` is set.
 */
export async function handleDebugStart({
  event,
  actorLockKeyPrefix,
  logger = defaultLogger,
  lambdaClient,
  redisConnection,
}: HandleDebugStartArgs): Promise<APIGatewayProxyResultV2> {
  if (!env.isOffline || !event.body) {
    return NotFound;
  }

  const startEvent = JSON.parse(event.body) as GameActorStartEvent;
  logger.debug({ startEvent }, "Start for debugging");

  async function releaseLock(connection: RedisConnection): Promise<void> {
    await new RedisLock({
      connection,
      keyPrefix: actorLockKeyPrefix,
      logger,
    }).release(startEvent.gameId);
  }
  await (redisConnection
    ? releaseLock(redisConnection)
    : useRedis(releaseLock));
  logger.debug({ gameId: startEvent.gameId }, "Release actor's lock");

  // Start a new Lambda to process game messages.
  const client =
    lambdaClient ?? new LambdaClient({ endpoint: "http://localhost:3002" });
  const invocation = client.send(
    new InvokeCommand({
      FunctionName: env.gameActorLambdaName,
      InvocationType: "Event",
      Qualifier: "$LATEST",
      Payload: Buffer.from(JSON.stringify(startEvent)),
    }),
  );

  if (event.queryStringParameters?.waitSetup) {
    await invocation;
  } else {
    invocation.catch((error: unknown) =>
      logger.error({ error }, "Cannot invoke the game actor lambda"),
    );
  }
  return OK;
}

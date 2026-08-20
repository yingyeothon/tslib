import { nullLogger, type Logger } from "@yingyeothon/logger";
import { redisSet, type RedisConnection } from "@yingyeothon/naive-redis";
import type { GamebaseContext } from "../context.js";
import type { GameMainOptions } from "../models/GameMainOptions.js";
import { createActorSubsystem } from "./createActorSubsystem.js";
import { readyCall } from "./lobby/readyCall.js";
import type { GameActorStartEvent } from "./models/GameActorStartEvent.js";
import { saveActorStartEvent } from "./saveActorStartEvent.js";
import {
  startActorLoop,
  type StartActorLoopOptions,
} from "./startActorLoop.js";

const aliveMarginSeconds = 10;

export interface HandleActorOptions<M> {
  event: GameActorStartEvent;
  eventKeyPrefix: string;
  awaiterKeyPrefix: string;
  queueKeyPrefix: string;
  lockKeyPrefix: string;
  lifetimeSeconds: number;
  gameMain: (args: GameMainOptions<M>) => Promise<unknown>;
  logger?: Logger;
  actorLogger?: Logger;
  /** Supplies the shared Redis connection when `redisConnection` is unset. */
  context?: GamebaseContext;
  /** Overrides the context's Redis connection, e.g. in tests. */
  redisConnection?: RedisConnection;
  /** Overrides the Redis-backed actor subsystem, e.g. with in-memory ones. */
  subsystem?: StartActorLoopOptions<M>["subsystem"];
  /** Overrides how the start event is persisted, e.g. in tests. */
  saveStartEvent?: (key: string, value: string) => Promise<unknown>;
  /** Overrides how the start event is cleared when the game ends. */
  deleteStartEvent?: (key: string) => Promise<unknown>;
}

/**
 * Entry point of the game actor Lambda: persists the start event, signals
 * the lobby via `callbackUrl` when present, and runs the actor game loop
 * until `gameMain` returns.
 */
export async function handleActor<M>({
  event,
  eventKeyPrefix,
  awaiterKeyPrefix,
  queueKeyPrefix,
  lockKeyPrefix,
  lifetimeSeconds,
  gameMain,
  logger = nullLogger,
  actorLogger = nullLogger,
  context,
  redisConnection,
  subsystem,
  saveStartEvent,
  deleteStartEvent,
}: HandleActorOptions<M>): Promise<void> {
  logger.debug("start a new game lambda", { event });

  const { gameId, members } = event;
  if (!gameId) {
    logger.error("no gameId from payload", { event });
    return;
  }

  const aliveSeconds = lifetimeSeconds + aliveMarginSeconds;
  const connection = redisConnection ?? context?.getRedisConnection();
  if (!connection) {
    throw new Error("handleActor requires either redisConnection or context");
  }

  // First, store the game context into Redis.
  await saveActorStartEvent({
    event,
    set:
      saveStartEvent ??
      ((key, value) =>
        redisSet(connection, key, value, {
          expirationMillis: aliveSeconds * 1000,
        })),
    eventKeyPrefix,
  });

  // Send the ready signal to the lobby.
  if (event.callbackUrl !== undefined) {
    const response = await readyCall(event.callbackUrl);
    logger.debug("mark this game as ready", { response });
  }

  await startActorLoop<M>({
    gameId,
    members,
    logger,
    eventKeyPrefix,
    subsystem:
      subsystem ??
      createActorSubsystem({
        awaiterKeyPrefix,
        lockKeyPrefix,
        queueKeyPrefix,
        lockTimeoutSeconds: aliveSeconds,
        logger: actorLogger,
        redisConnection: connection,
      }),
    redisConnection: connection,
    ...(deleteStartEvent ? { deleteStartEvent } : {}),
    gameMain,
  });
}

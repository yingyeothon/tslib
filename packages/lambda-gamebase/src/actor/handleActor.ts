import { ConsoleLogger, type Logger } from "@yingyeothon/logger";
import { redisSet, type RedisConnection } from "@yingyeothon/naive-redis";
import { getRedisConnection } from "../infra/redisConnection.js";
import type { GameMainArguments } from "../models/GameMainArguments.js";
import { readyCall } from "./lobby/readyCall.js";
import type { GameActorStartEvent } from "./models/GameActorStartEvent.js";
import { newActorSubsys } from "./newActorSubsys.js";
import { saveActorStartEvent } from "./saveActorStartEvent.js";
import { startActorLoop, type StartActorLoopArgs } from "./startActorLoop.js";

const aliveMarginSeconds = 10;

export interface HandleActorArgs<M> {
  event: GameActorStartEvent;
  eventKeyPrefix: string;
  awaiterKeyPrefix: string;
  queueKeyPrefix: string;
  lockKeyPrefix: string;
  lifetimeSeconds: number;
  gameMain: (args: GameMainArguments<M>) => Promise<unknown>;
  logger?: Logger;
  actorLogger?: Logger;
  /** Overrides the shared Redis connection, e.g. in tests. */
  redisConnection?: RedisConnection;
  /** Overrides the Redis-backed actor subsystem, e.g. with in-memory ones. */
  subsys?: StartActorLoopArgs<M>["subsys"];
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
  logger = new ConsoleLogger("debug"),
  actorLogger = new ConsoleLogger("info"),
  redisConnection,
  subsys,
  saveStartEvent,
  deleteStartEvent,
}: HandleActorArgs<M>): Promise<void> {
  logger.debug({ event }, "Start a new game lambda");

  const { gameId, members } = event;
  if (!gameId) {
    logger.error({ event }, "No gameId from payload");
    return;
  }

  const aliveSeconds = lifetimeSeconds + aliveMarginSeconds;
  const connection = redisConnection ?? getRedisConnection();

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
    logger.debug({ response }, "Mark this game as ready");
  }

  await startActorLoop<M>({
    gameId,
    members,
    logger,
    eventKeyPrefix,
    subsys:
      subsys ??
      newActorSubsys({
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

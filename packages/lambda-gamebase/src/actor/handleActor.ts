import { nullLogger, type Logger } from "@yingyeothon/logger";
import {
  redisDel,
  redisSet,
  type RedisConnection,
} from "@yingyeothon/naive-redis";
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
const defaultLockTimeoutSeconds = 30;

export interface HandleActorOptions<M> {
  event: GameActorStartEvent;
  eventKeyPrefix: string;
  awaiterKeyPrefix: string;
  queueKeyPrefix: string;
  lockKeyPrefix: string;
  lifetimeSeconds: number;
  /**
   * Lock lease in seconds, refreshed by a heartbeat while the game runs.
   *
   * It is deliberately far shorter than the game: a lease as long as the
   * game means a crash at t=30s leaves the `gameId` unstartable for the
   * remaining minutes, because nothing detects the crash and nothing
   * shortens the lease. Default: 30.
   */
  lockTimeoutSeconds?: number;
  /**
   * TTL for the actor's own queue key. The actor only drains, so this is
   * applied only if its subsystem is ever used to push; the producers'
   * `queueTtlSeconds` is what normally governs the key. Default: the
   * actor's alive window (`lifetimeSeconds + 10`).
   */
  queueTtlSeconds?: number;
  gameMain: (args: GameMainOptions<M>) => Promise<unknown>;
  logger?: Logger;
  actorLogger?: Logger;
  /**
   * Supplies the shared Redis connection when `redisConnection` is unset.
   * Required unless `subsystem`, `saveStartEvent` and `deleteStartEvent` are
   * all supplied — together those are every use this function has for one.
   */
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
  lockTimeoutSeconds = defaultLockTimeoutSeconds,
  queueTtlSeconds,
  gameMain,
  logger = nullLogger,
  actorLogger = nullLogger,
  context,
  redisConnection,
  subsystem,
  saveStartEvent,
  deleteStartEvent,
}: HandleActorOptions<M>): Promise<void> {
  const { gameId, members } = event;
  // The start event carries a name and an email per member.
  logger.debug("start a new game lambda", {
    gameId,
    memberCount: members?.length ?? 0,
  });
  if (!gameId) {
    logger.error("no gameId from payload", {
      memberCount: members?.length ?? 0,
    });
    return;
  }

  const aliveSeconds = lifetimeSeconds + aliveMarginSeconds;
  // A connection is needed for exactly three things, each of which the caller
  // may supply instead. Demanding one regardless made an in-memory run
  // impossible even though nothing would have used it.
  //
  // Resolved lazily, and only when a default actually needs it: a context whose
  // options carry no `redis` throws when asked for a connection, so asking
  // eagerly would defeat the escape hatch for every caller that passes one —
  // and `context` is exactly what `reply` and `broadcast` need.
  let resolved: RedisConnection | undefined;
  const connectionOrThrow = (): RedisConnection => {
    resolved ??= redisConnection ?? context?.getRedisConnection();
    if (!resolved) {
      throw new Error(
        "handleActor requires either redisConnection or context, unless " +
          "subsystem, saveStartEvent and deleteStartEvent are all supplied",
      );
    }
    return resolved;
  };

  // Every default that needs a connection is resolved here, before the first
  // side effect. Resolving them later left a persisted start event behind when
  // the call turned out to be misconfigured.
  const actorSubsystem =
    subsystem ??
    createActorSubsystem({
      awaiterKeyPrefix,
      lockKeyPrefix,
      queueKeyPrefix,
      lockTimeoutSeconds,
      queueTtlSeconds: queueTtlSeconds ?? aliveSeconds,
      logger: actorLogger,
      redisConnection: connectionOrThrow(),
    });
  const set =
    saveStartEvent ??
    ((key: string, value: string) =>
      redisSet(connectionOrThrow(), key, value, {
        expirationMillis: aliveSeconds * 1000,
      }));
  // Resolved here rather than inside startActorLoop, so the message names the
  // function the caller actually called.
  const del =
    deleteStartEvent ?? ((key: string) => redisDel(connectionOrThrow(), key));
  if (!saveStartEvent || !deleteStartEvent) connectionOrThrow();

  // Only now, with nothing left that can refuse, does anything get written.
  await saveActorStartEvent({ event, set, eventKeyPrefix });

  const { callbackUrl } = event;
  await startActorLoop<M>({
    gameId,
    members,
    logger,
    eventKeyPrefix,
    subsystem: actorSubsystem,
    // A third of the lease, so one lost heartbeat is not a lost lock.
    lockRenewIntervalMillis: Math.max(
      1000,
      Math.floor((lockTimeoutSeconds * 1000) / 3),
    ),
    // Always supplied, so startActorLoop never needs a connection of its own.
    deleteStartEvent: del,
    // Signal the lobby only once this invocation owns the game. Fired
    // before the lock, a duplicate invocation announces "ready" too, and
    // the lobby hands clients a game that this call will never run.
    ...(callbackUrl !== undefined
      ? {
          onReady: async () => {
            await readyCall(callbackUrl);
            logger.debug("mark this game as ready", { gameId });
          },
        }
      : {}),
    gameMain,
  });
}

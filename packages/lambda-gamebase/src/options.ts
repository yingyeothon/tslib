import type { RedisConnectionOptions } from "@yingyeothon/naive-redis";

/**
 * Configuration for the gamebase package. Library code never reads
 * `process.env`; build this object yourself or with
 * `gamebaseOptionsFromEnv()` and pass it to `createGamebaseContext`.
 */
export interface GamebaseOptions {
  /** Redis connection options for the actor queue/lock/event storage. */
  redis?: RedisConnectionOptions;
  /** Name of the game actor Lambda, used by `handleDebugStart`. */
  gameActorLambdaName?: string;
  /** True when running under serverless-offline. */
  isOffline?: boolean;
  /** API Gateway WebSocket management endpoint for `reply` and friends. */
  webSocketEndpoint?: string;
}

/**
 * Reads the documented environment variables (`REDIS_HOST`,
 * `REDIS_PASSWORD`, `GAME_ACTOR_LAMBDA_NAME`, `IS_OFFLINE`, `WS_ENDPOINT`)
 * and returns a `GamebaseOptions`. Calling it is the caller's choice.
 */
export function gamebaseOptionsFromEnv(): GamebaseOptions {
  return {
    redis: process.env.REDIS_HOST
      ? {
          host: process.env.REDIS_HOST,
          password: process.env.REDIS_PASSWORD,
        }
      : undefined,
    gameActorLambdaName: process.env.GAME_ACTOR_LAMBDA_NAME,
    isOffline: !!process.env.IS_OFFLINE,
    webSocketEndpoint: process.env.WS_ENDPOINT,
  };
}

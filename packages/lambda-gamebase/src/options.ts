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
 * Reads the documented environment variables (`REDIS_HOST`, `REDIS_PORT`,
 * `REDIS_USER`, `REDIS_PASSWORD`, `REDIS_TLS`, `GAME_ACTOR_LAMBDA_NAME`,
 * `IS_OFFLINE`, `WS_ENDPOINT`)
 * and returns a `GamebaseOptions`. Calling it is the caller's choice.
 */
export function gamebaseOptionsFromEnv(): GamebaseOptions {
  return {
    redis: process.env.REDIS_HOST
      ? {
          host: process.env.REDIS_HOST,
          port: process.env.REDIS_PORT
            ? Number(process.env.REDIS_PORT)
            : undefined,
          // An empty REDIS_USER must not become `AUTH "" <password>`.
          username: process.env.REDIS_USER || undefined,
          password: process.env.REDIS_PASSWORD,
          // Without this the documented env path cannot turn TLS on, and
          // the connection carries `AUTH` in the clear.
          tls: process.env.REDIS_TLS ? true : undefined,
        }
      : undefined,
    gameActorLambdaName: process.env.GAME_ACTOR_LAMBDA_NAME,
    isOffline: !!process.env.IS_OFFLINE,
    webSocketEndpoint: process.env.WS_ENDPOINT,
  };
}

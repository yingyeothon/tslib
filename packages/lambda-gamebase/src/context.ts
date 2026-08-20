import { ApiGatewayManagementApiClient } from "@aws-sdk/client-apigatewaymanagementapi";
import {
  createRedisConnection,
  type RedisConnection,
  type RedisConnectionOptions,
} from "@yingyeothon/naive-redis";
import type { GamebaseOptions } from "./options.js";

export interface GamebaseContextOptions extends GamebaseOptions {
  /** Overrides the lazily created Redis connection, e.g. in tests. */
  redisConnection?: RedisConnection;
  /** Overrides the lazily created management client, e.g. in tests. */
  apiGatewayManagementClient?: ApiGatewayManagementApiClient;
}

/**
 * Owns the shared, lazily created resources that used to live in module
 * singletons: the Redis connection and the API Gateway management client.
 * Create one context per Lambda container (module scope of the caller)
 * and pass it to the handlers and network functions.
 */
export interface GamebaseContext {
  readonly options: GamebaseOptions;
  /**
   * Returns the shared Redis connection built from `options.redis`. It is
   * created lazily on first use and then reused, which suits long-running
   * actor Lambdas.
   */
  getRedisConnection: () => RedisConnection;
  /**
   * Returns the shared API Gateway management client used by `reply` and
   * `dropConnection`. It is created lazily from `options.webSocketEndpoint`
   * (or the serverless-offline endpoint when `options.isOffline` is set)
   * and then reused.
   */
  getApiGatewayManagementClient: () => ApiGatewayManagementApiClient;
}

export function createGamebaseContext(
  options: GamebaseContextOptions = {},
): GamebaseContext {
  const {
    redisConnection: initialConnection,
    apiGatewayManagementClient: initialClient,
    ...gamebaseOptions
  } = options;
  let connection: RedisConnection | undefined = initialConnection;
  let client: ApiGatewayManagementApiClient | undefined = initialClient;
  return {
    options: gamebaseOptions,
    getRedisConnection: () => {
      connection ??= createRedisConnection(
        requireRedisOptions(gamebaseOptions),
      );
      return connection;
    },
    getApiGatewayManagementClient: () => {
      client ??= new ApiGatewayManagementApiClient({
        endpoint: gamebaseOptions.isOffline
          ? "http://localhost:3001"
          : gamebaseOptions.webSocketEndpoint,
      });
      return client;
    },
  };
}

export function requireRedisOptions(
  options: GamebaseOptions,
): RedisConnectionOptions {
  if (!options.redis) {
    throw new Error(
      "GamebaseOptions.redis is required to connect to Redis; set it explicitly or via gamebaseOptionsFromEnv()",
    );
  }
  return options.redis;
}

export interface GamebaseEnv {
  redisHost: string;
  redisPassword: string | undefined;
  gameActorLambdaName: string;
  isOffline: boolean;
  webSocketEndpoint: string;
}

/**
 * Environment configuration read from `process.env`. Values are read
 * lazily on each property access so tests (and late-initialized Lambda
 * environments) can set variables after this module is imported.
 */
export const env: GamebaseEnv = {
  get redisHost(): string {
    return process.env.REDIS_HOST!;
  },
  get redisPassword(): string | undefined {
    return process.env.REDIS_PASSWORD;
  },
  get gameActorLambdaName(): string {
    return process.env.GAME_ACTOR_LAMBDA_NAME!;
  },
  get isOffline(): boolean {
    return !!process.env.IS_OFFLINE;
  },
  get webSocketEndpoint(): string {
    return process.env.WS_ENDPOINT!;
  },
};

import { afterEach, describe, expect, it, vi } from "vitest";
import { gamebaseOptionsFromEnv } from "../src/index.js";

afterEach(() => vi.unstubAllEnvs());

describe("gamebaseOptionsFromEnv", () => {
  it("reads the documented environment variables", () => {
    vi.stubEnv("REDIS_HOST", "redis.yyt.life");
    vi.stubEnv("REDIS_PASSWORD", "secret");
    vi.stubEnv("GAME_ACTOR_LAMBDA_NAME", "game-actor");
    vi.stubEnv("IS_OFFLINE", "true");
    vi.stubEnv("WS_ENDPOINT", "https://example.com/ws");

    expect(gamebaseOptionsFromEnv()).toEqual({
      redis: { host: "redis.yyt.life", password: "secret" },
      gameActorLambdaName: "game-actor",
      isOffline: true,
      webSocketEndpoint: "https://example.com/ws",
    });
  });

  it("leaves redis unset without REDIS_HOST", () => {
    vi.stubEnv("REDIS_HOST", "");
    vi.stubEnv("IS_OFFLINE", "");
    const options = gamebaseOptionsFromEnv();
    expect(options.redis).toBeUndefined();
    expect(options.isOffline).toBe(false);
  });
});

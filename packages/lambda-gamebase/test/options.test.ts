import { afterEach, describe, expect, it, vi } from "vitest";
import { gamebaseOptionsFromEnv } from "../src/index.js";

afterEach(() => vi.unstubAllEnvs());

describe("gamebaseOptionsFromEnv", () => {
  it("reads the documented environment variables", () => {
    vi.stubEnv("REDIS_HOST", "redis.yyt.life");
    vi.stubEnv("REDIS_PORT", "6380");
    vi.stubEnv("REDIS_USER", "game-acl-user");
    vi.stubEnv("REDIS_PASSWORD", "secret");
    vi.stubEnv("GAME_ACTOR_LAMBDA_NAME", "game-actor");
    vi.stubEnv("IS_OFFLINE", "true");
    vi.stubEnv("WS_ENDPOINT", "https://example.com/ws");

    expect(gamebaseOptionsFromEnv()).toEqual({
      redis: {
        host: "redis.yyt.life",
        port: 6380,
        username: "game-acl-user",
        password: "secret",
      },
      gameActorLambdaName: "game-actor",
      isOffline: true,
      webSocketEndpoint: "https://example.com/ws",
    });
  });

  it("omits port and username when unset", () => {
    vi.stubEnv("REDIS_HOST", "redis.yyt.life");
    vi.stubEnv("REDIS_PORT", "");
    vi.stubEnv("REDIS_USER", "");
    expect(gamebaseOptionsFromEnv().redis).toEqual({
      host: "redis.yyt.life",
      port: undefined,
      username: undefined,
      password: undefined,
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

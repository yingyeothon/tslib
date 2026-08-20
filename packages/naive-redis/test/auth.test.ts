import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  redisAuth,
  createRedisConnection,
  redisDel,
  redisGet,
  redisSend,
  redisSet,
  type RedisConnectionOptions,
} from "../src/index.js";
import { redisConnectionOptionsFromEnv } from "./fixture.js";

const password = "naive-redis-test-password-1234";

async function configSetRequirepass(
  config: RedisConnectionOptions,
  value: string,
): Promise<void> {
  const connection = createRedisConnection(config);
  try {
    await redisSend({
      connection,
      commands: [`CONFIG SET requirepass "${value}"`],
      match: (m) => m.capture("\r\n"),
      transform: (result) => result[0],
    });
  } finally {
    connection.socket.disconnect();
  }
}

describe("auth", () => {
  beforeAll(async () => {
    await configSetRequirepass(redisConnectionOptionsFromEnv(), password);
  });

  afterAll(async () => {
    await configSetRequirepass(
      { ...redisConnectionOptionsFromEnv(), password },
      "",
    );
  });

  it("authenticates automatically when a password is configured", async () => {
    const config = { ...redisConnectionOptionsFromEnv(), password };
    const connection = createRedisConnection(config);
    try {
      const testKey = "naive-redis-auth-test";
      expect(await redisGet(connection, testKey)).toBeNull();
      expect(await redisSet(connection, testKey, "secured")).toBe(true);
      expect(await redisGet(connection, testKey)).toEqual("secured");
      expect(await redisDel(connection, testKey)).toBe(1);
    } finally {
      connection.socket.disconnect();
    }
  });

  it("authenticates explicitly via redisAuth", async () => {
    const connection = createRedisConnection(redisConnectionOptionsFromEnv());
    try {
      expect(await redisAuth(connection, password)).toBe(true);
      expect(await redisGet(connection, "naive-redis-auth-test")).toBeNull();
    } finally {
      connection.socket.disconnect();
    }
  });

  it("rejects commands without authentication", async () => {
    const connection = createRedisConnection(redisConnectionOptionsFromEnv());
    try {
      await expect(redisGet(connection, "any-key")).rejects.toThrow(/NOAUTH/);
    } finally {
      connection.socket.disconnect();
    }
  });

  it("rejects commands with a wrong password", async () => {
    const connection = createRedisConnection({
      ...redisConnectionOptionsFromEnv(),
      password: "wrong-password",
    });
    try {
      await expect(redisGet(connection, "any-key")).rejects.toThrow();
      // Consume the failed authentication to avoid an unhandled rejection.
      await expect(
        connection.authenticated ?? Promise.resolve(false),
      ).rejects.toThrow();
    } finally {
      connection.socket.disconnect();
    }
  });
});

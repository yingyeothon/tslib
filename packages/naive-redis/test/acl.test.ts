import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createRedisConnection,
  createRedisSubscriber,
  redisAuth,
  redisDel,
  redisGet,
  redisPublish,
  redisSend,
  redisSet,
  type RedisConnectionOptions,
} from "../src/index.js";
import { redisConnectionOptionsFromEnv } from "./fixture.js";

const username = "naive-redis-acl-user";
const password = "naive-redis-acl-password-1234";

async function acl(config: RedisConnectionOptions, args: string[]) {
  const connection = createRedisConnection(config);
  try {
    await redisSend({
      connection,
      commands: [`ACL ${args.join(" ")}`],
      match: (m) => m.capture("\r\n"),
      transform: (result) => result[0],
    });
  } finally {
    connection.socket.disconnect();
  }
}

describe("acl user", () => {
  beforeAll(async () => {
    await acl(redisConnectionOptionsFromEnv(), [
      "SETUSER",
      username,
      "on",
      `>${password}`,
      "~acl:*",
      "resetchannels",
      "&acl:*",
      "+@all",
      "-@dangerous",
    ]);
  });

  afterAll(async () => {
    await acl(redisConnectionOptionsFromEnv(), ["DELUSER", username]);
  });

  it("authenticates as the ACL user when username is configured", async () => {
    const connection = createRedisConnection({
      ...redisConnectionOptionsFromEnv(),
      username,
      password,
    });
    try {
      expect(await redisSet(connection, "acl:key", "v")).toBe(true);
      expect(await redisGet(connection, "acl:key")).toBe("v");
      expect(await redisDel(connection, "acl:key")).toBe(1);
      // Outside the user's key pattern the server answers NOPERM.
      await expect(redisGet(connection, "other:key")).rejects.toThrow(/NOPERM/);
    } finally {
      connection.socket.disconnect();
    }
  });

  it("sends the two-argument AUTH via redisAuth", async () => {
    const connection = createRedisConnection(redisConnectionOptionsFromEnv());
    try {
      expect(await redisAuth(connection, password, { username })).toBe(true);
      expect(await redisGet(connection, "acl:missing")).toBeNull();
    } finally {
      connection.socket.disconnect();
    }
  });

  it("rejects a wrong ACL password", async () => {
    const connection = createRedisConnection({
      ...redisConnectionOptionsFromEnv(),
      username,
      password: "wrong",
    });
    try {
      // The test server has no `requirepass`, so the socket would stay
      // usable as `default` — but a failed AUTH drops it anyway so the
      // command in flight fails with the AUTH error instead of silently
      // running as the wrong user.
      await expect(redisGet(connection, "acl:key")).rejects.toThrow(
        /WRONGPASS/,
      );
      expect(connection.authenticated).toBeUndefined();
    } finally {
      connection.socket.disconnect();
    }
  });

  it("subscribes as the ACL user", async () => {
    const received: string[] = [];
    const subscriber = createRedisSubscriber({
      ...redisConnectionOptionsFromEnv(),
      username,
      password,
      onMessage: ({ message }) => received.push(message),
    });
    const publisher = createRedisConnection({
      ...redisConnectionOptionsFromEnv(),
      username,
      password,
    });
    try {
      await subscriber.subscribe("acl:channel");
      await redisPublish(publisher, "acl:channel", "hello");
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(received).toEqual(["hello"]);
    } finally {
      subscriber.disconnect();
      publisher.socket.disconnect();
    }
  });
});

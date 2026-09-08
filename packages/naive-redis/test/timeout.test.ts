import { afterEach, describe, expect, it } from "vitest";
import { createRedisConnection, redisGet } from "../src/index.js";
import { startFakeRedis, type FakeRedis } from "./fake-redis.js";

const password = "timeout-secret-4b8";

describe("command timeout", () => {
  let fake: FakeRedis | undefined;
  afterEach(async () => {
    await fake?.close();
    fake = undefined;
  });

  it("gives a command five seconds by default", () => {
    // A connection is opened lazily, so this asserts the default without
    // reaching a server. 1000 was not a budget for a round trip that can
    // carry a whole actor queue back on a store under load.
    const connection = createRedisConnection({ host: "127.0.0.1", port: 1 });
    expect(connection.timeoutMillis).toBe(5000);
  });

  it("does not spend a command's budget on the AUTH ahead of it", async () => {
    // The frozen-container shape: the command is queued first, and the
    // automatic `AUTH` is put in front of it the moment the socket
    // connects. Handshake and command take 60ms each, so the command is
    // answered 120ms after it was queued but only 60ms after it reached
    // the wire — which is the only wait its own budget describes.
    fake = await startFakeRedis((command, { client }) => {
      const answer = command.startsWith("AUTH") ? "+OK\r\n" : "$5\r\nvalue\r\n";
      setTimeout(() => client.write(answer), 60);
      return undefined;
    });
    const connection = createRedisConnection({
      host: "127.0.0.1",
      port: fake.port,
      password,
      timeoutMillis: 100,
    });
    try {
      await expect(redisGet(connection, "a")).resolves.toBe("value");
      expect(fake.received).toEqual([`AUTH ${password}`, 'GET "a"']);
      expect(fake.connections).toBe(1);
    } finally {
      connection.socket.disconnect();
    }
  });

  it("still rejects a command the server never answers", async () => {
    // The budget is restarted, not abandoned: a server that takes the
    // command and says nothing must still surface as a timeout.
    fake = await startFakeRedis((command) =>
      command.startsWith("AUTH") ? "+OK\r\n" : undefined,
    );
    const connection = createRedisConnection({
      host: "127.0.0.1",
      port: fake.port,
      password,
      timeoutMillis: 80,
    });
    try {
      await expect(redisGet(connection, "a")).rejects.toThrow(/Timeout/);
    } finally {
      connection.socket.disconnect();
    }
  });
});

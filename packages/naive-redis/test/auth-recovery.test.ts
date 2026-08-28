import { createServer, type Server, type Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createRedisConnection, redisGet, redisSet } from "../src/index.js";

/**
 * A scripted Redis stand-in: every inbound line is recorded in order, and
 * `reply` decides what goes back. Auth recovery is about the sequence of
 * connections and commands, which a real server cannot be told to break on
 * cue, so this runs without Docker.
 */
interface FakeRedis {
  port: number;
  readonly connections: number;
  received: string[];
  /** Destroys every accepted socket, like a server restart would. */
  dropClients: () => Promise<void>;
  close: () => Promise<void>;
}

type Reply = (
  command: string,
  context: { connection: number },
) => string | undefined;

function startFakeRedis(reply: Reply): Promise<FakeRedis> {
  return new Promise((resolve) => {
    const clients: Socket[] = [];
    const received: string[] = [];
    const server: Server = createServer((client) => {
      clients.push(client);
      const connection = clients.length;
      client.on("data", (chunk) => {
        for (const line of chunk.toString("utf-8").split("\r\n")) {
          if (line.length === 0) {
            continue;
          }
          received.push(line);
          const answer = reply(line, { connection });
          if (answer !== undefined) {
            client.write(answer);
          }
        }
      });
      client.on("error", () => undefined);
    });
    const fake: FakeRedis = {
      port: 0,
      get connections() {
        return clients.length;
      },
      received,
      dropClients: () =>
        new Promise((done) => {
          for (const client of clients) {
            client.destroy();
          }
          // Let the client side observe the close before the next command.
          setTimeout(done, 20);
        }),
      close: () =>
        new Promise((done) => {
          for (const client of clients) {
            client.destroy();
          }
          server.close(() => done());
        }),
    };
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      fake.port = typeof address === "object" && address ? address.port : 0;
      resolve(fake);
    });
  });
}

const password = "recovery-secret-7c1";

describe("authentication recovery", () => {
  let fake: FakeRedis | undefined;
  afterEach(async () => {
    await fake?.close();
    fake = undefined;
  });

  it("reconnects and authenticates again after AUTH is rejected", async () => {
    fake = await startFakeRedis((command, { connection }) => {
      if (command.startsWith("AUTH")) {
        return connection === 1 ? "-ERR invalid password\r\n" : "+OK\r\n";
      }
      return "$-1\r\n";
    });
    const redis = createRedisConnection({
      host: "127.0.0.1",
      port: fake.port,
      password,
    });
    try {
      await expect(redisGet(redis, "k")).rejects.toThrow(/invalid password/);
      await expect(redisGet(redis, "k")).resolves.toBeNull();
      expect(fake.connections).toBe(2);
      // The first GET is already on the wire behind the urgent AUTH when the
      // rejection arrives; it fails with the AUTH error, not with its reply.
      expect(fake.received).toEqual([
        `AUTH ${password}`,
        'GET "k"',
        `AUTH ${password}`,
        'GET "k"',
      ]);
    } finally {
      redis.socket.disconnect();
    }
  });

  it("reconnects after AUTH times out instead of keeping the socket", async () => {
    fake = await startFakeRedis((command, { connection }) => {
      if (command.startsWith("AUTH")) {
        return connection === 1 ? undefined : "+OK\r\n";
      }
      return "$-1\r\n";
    });
    const redis = createRedisConnection({
      host: "127.0.0.1",
      port: fake.port,
      password,
      authTimeoutMillis: 50,
    });
    try {
      await expect(redisGet(redis, "k")).rejects.toThrow(/Timeout 50millis/);
      await expect(redisGet(redis, "k")).resolves.toBeNull();
      expect(fake.connections).toBe(2);
      expect(fake.received).toEqual([
        `AUTH ${password}`,
        `AUTH ${password}`,
        'GET "k"',
      ]);
    } finally {
      redis.socket.disconnect();
    }
  });

  it.each(["-NOAUTH Authentication required.", "-WRONGPASS invalid password"])(
    "retries a command once on a new connection after %s",
    async (error) => {
      fake = await startFakeRedis((command, { connection }) => {
        if (command.startsWith("AUTH")) {
          return "+OK\r\n";
        }
        return connection === 1 ? `${error}\r\n` : "+OK\r\n";
      });
      const redis = createRedisConnection({
        host: "127.0.0.1",
        port: fake.port,
        password,
      });
      try {
        await expect(redisSet(redis, "k", "v")).resolves.toBe(true);
        expect(fake.connections).toBe(2);
        expect(fake.received).toEqual([
          `AUTH ${password}`,
          "SET k v",
          `AUTH ${password}`,
          "SET k v",
        ]);
      } finally {
        redis.socket.disconnect();
      }
    },
  );

  it("gives up after one retry when the new connection still answers NOAUTH", async () => {
    fake = await startFakeRedis((command) =>
      command.startsWith("AUTH")
        ? "+OK\r\n"
        : "-NOAUTH Authentication required.\r\n",
    );
    const redis = createRedisConnection({
      host: "127.0.0.1",
      port: fake.port,
      password,
    });
    try {
      await expect(redisGet(redis, "k")).rejects.toThrow(/NOAUTH/);
      expect(fake.connections).toBe(2);
    } finally {
      redis.socket.disconnect();
    }
  });

  it("surfaces NOAUTH without retrying when no password is configured", async () => {
    fake = await startFakeRedis(() => "-NOAUTH Authentication required.\r\n");
    const redis = createRedisConnection({ host: "127.0.0.1", port: fake.port });
    try {
      await expect(redisGet(redis, "k")).rejects.toThrow(/NOAUTH/);
      expect(fake.connections).toBe(1);
      expect(fake.received).toEqual(['GET "k"']);
      // The poisoned socket is still dropped, so a later call reconnects.
      await expect(redisGet(redis, "k")).rejects.toThrow(/NOAUTH/);
      expect(fake.connections).toBe(2);
    } finally {
      redis.socket.disconnect();
    }
  });

  it("authenticates before the first command after the server drops a warm socket", async () => {
    // A Redis restart: the process already authenticated once, the server
    // side goes away, and the next command must open a new socket that sends
    // AUTH first — the reconnect path, not the cold-start path above.
    const authenticatedConnections = new Set<number>();
    fake = await startFakeRedis((command, { connection }) => {
      if (command.startsWith("AUTH")) {
        authenticatedConnections.add(connection);
        return "+OK\r\n";
      }
      return authenticatedConnections.has(connection)
        ? "$-1\r\n"
        : "-NOAUTH Authentication required.\r\n";
    });
    const redis = createRedisConnection({
      host: "127.0.0.1",
      port: fake.port,
      password,
    });
    try {
      await expect(redisGet(redis, "k")).resolves.toBeNull();
      await fake.dropClients();
      await expect(redisGet(redis, "k")).resolves.toBeNull();
      expect(fake.connections).toBe(2);
      expect(fake.received).toEqual([
        `AUTH ${password}`,
        'GET "k"',
        `AUTH ${password}`,
        'GET "k"',
      ]);
    } finally {
      redis.socket.disconnect();
    }
  });

  it("keeps a healthy authenticated connection as it is", async () => {
    fake = await startFakeRedis((command) =>
      command.startsWith("AUTH") ? "+OK\r\n" : "$-1\r\n",
    );
    const redis = createRedisConnection({
      host: "127.0.0.1",
      port: fake.port,
      password,
    });
    try {
      await expect(redisGet(redis, "a")).resolves.toBeNull();
      await expect(redisGet(redis, "b")).resolves.toBeNull();
      expect(fake.connections).toBe(1);
      expect(fake.received).toEqual([`AUTH ${password}`, 'GET "a"', 'GET "b"']);
    } finally {
      redis.socket.disconnect();
    }
  });
});

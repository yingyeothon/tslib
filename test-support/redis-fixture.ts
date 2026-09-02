// `ProvidedContext` is augmented by `./redis-global-setup.ts`, which every
// consumer already loads through its `test/global-setup.ts`; importing it
// here would pull testcontainers into each test worker.
import { inject } from "vitest";

/**
 * The slice of `@yingyeothon/naive-redis`'s `RedisConnection` this helper
 * touches. Typed structurally because `test-support/` is not a workspace
 * package and cannot import one.
 */
export interface FlushableConnection {
  socket: {
    send(request: {
      message: string;
      fulfill: number;
      timeoutMillis: number;
    }): Promise<unknown>;
    disconnect(): void;
  };
}

/** Connection options for the container started by `redis-global-setup`. */
export function redisConnectionOptionsFromEnv(): {
  host: string;
  port: number;
} {
  return { host: inject("redisHost"), port: inject("redisPort") };
}

/**
 * Runs `work` against `connection`, then flushes the whole database and
 * drops the socket so the next test starts from an empty Redis.
 */
export async function withFlushedRedis<C extends FlushableConnection, T>(
  connection: C,
  work: (connection: C) => Promise<T>,
): Promise<T> {
  try {
    return await work(connection);
  } finally {
    // Clear all entries after the test.
    await connection.socket.send({
      message: "FLUSHALL\r\n",
      fulfill: "+OK\r\n".length,
      timeoutMillis: 1000,
    });
    connection.socket.disconnect();
  }
}

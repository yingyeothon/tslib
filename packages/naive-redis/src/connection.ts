import { ConnectionState, NaiveSocket } from "@yingyeothon/naive-socket";
import { redisAuth } from "./auth.js";

export interface RedisConfig {
  host: string;
  port?: number;
  password?: string;
  timeoutMillis?: number;
}

export interface RedisConnection {
  socket: NaiveSocket;
  timeoutMillis: number;
  authenticated?: Promise<boolean>;
}

export function redisConnect({
  host,
  port = 6379,
  password,
  timeoutMillis = 1000,
}: RedisConfig): RedisConnection {
  const socket = new NaiveSocket({
    host,
    port,
    onConnectionStateChanged: ({ state }) => {
      if (password && state === ConnectionState.Connected) {
        const authenticated = redisAuth(connection, password);
        // Keep a failed authentication from surfacing as an unhandled
        // rejection; callers still observe it through `redisSend`.
        authenticated.catch(() => undefined);
        connection.authenticated = authenticated;
      }
    },
  });
  const connection: RedisConnection = {
    socket,
    timeoutMillis,
  };
  return connection;
}

import {
  ConnectionState,
  createNaiveSocket,
  type NaiveSocket,
} from "@yingyeothon/naive-socket";
import { redisAuth } from "./auth.js";

export interface RedisConnectionOptions {
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

export function createRedisConnection({
  host,
  port = 6379,
  password,
  timeoutMillis = 1000,
}: RedisConnectionOptions): RedisConnection {
  const socket = createNaiveSocket({
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

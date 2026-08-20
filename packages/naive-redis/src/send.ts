import {
  createTextMatch,
  withMatch,
  type TextMatchChain,
} from "@yingyeothon/naive-socket";
import type { RedisConnection } from "./connection.js";

const newline = "\r\n";

export interface RedisSendOptions<T> {
  connection: RedisConnection;
  commands: string[];
  match: TextMatchChain;
  transform: (result: string[]) => T;
  urgent?: boolean;
}

export function redisSend<T>({
  connection,
  commands,
  match,
  transform,
  urgent,
}: RedisSendOptions<T>): Promise<T> {
  async function doSend(): Promise<T> {
    const response = await connection.socket.send({
      message: commands.join(newline) + newline,
      fulfill: withMatch(match),
      timeoutMillis: connection.timeoutMillis,
      urgent,
    });
    return transform(match(createTextMatch(response)).values());
  }
  return connection.authenticated
    ? connection.authenticated.then((success) => {
        if (!success) {
          throw new Error("Invalid password");
        }
        return doSend();
      })
    : doSend();
}

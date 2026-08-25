import type { RedisConnection } from "../connection.js";
import { redisSend } from "../send.js";
import { captureReply, replyKind } from "./reply.js";

/**
 * Reads an integer reply, negatives included, from a command whose reply
 * shape is not guaranteed.
 *
 * `singleCount` accepts only non-negative digits and consumes one line;
 * this frames the whole reply first, so an unexpected answer is a rejected
 * promise rather than a connection that hands the next command someone
 * else's data.
 */
export function singleInteger(
  connection: RedisConnection,
  commands: string[],
  urgent?: boolean,
): Promise<number> {
  return redisSend({
    connection,
    commands,
    ...(urgent !== undefined ? { urgent } : {}),
    match: captureReply,
    transform: (result) => {
      const header = result[0];
      const kind = replyKind(header);
      if (kind === "error") {
        throw new Error(`Error: ${header ?? ""}`);
      }
      if (kind !== "integer") {
        throw new Error(`Not an integer reply: ${kind}`);
      }
      return Number.parseInt((header ?? "").slice(1), 10);
    },
  });
}

import { nullLogger, type Logger } from "@yingyeothon/logger";
import { redisPublish, type RedisConnection } from "@yingyeothon/naive-redis";
import type { Transport } from "./transport.js";

/**
 * What a WebSocket gateway must do on behalf of the game loop. This is the
 * only wire format this package defines, and it never reaches a game
 * client: the gateway unwraps it and forwards `message` verbatim.
 */
export type GatewayCommand =
  // `op` alone does not separate the two send shapes, so each one denies
  // the other's field: that is what lets a consumer narrow with a plain
  // property check instead of an `in` guard.
  | {
      op: "send";
      connectionId: string;
      connectionIds?: never;
      message: unknown;
    }
  | {
      op: "send";
      connectionIds: string[];
      connectionId?: never;
      message: unknown;
    }
  | { op: "drop"; connectionId: string; connectionIds?: never };

export interface RedisPubSubTransportOptions {
  /** Connection used to `PUBLISH`; not the gateway's subscriber one. */
  connection: RedisConnection;
  /** Channel prefix the gateway subscribes with, e.g. `"game:out:"`. */
  channelPrefix: string;
  /** Identifies the game whose gateway channel receives the commands. */
  gameId: string;
  logger?: Logger;
}

/**
 * Publishes {@link GatewayCommand}s on `{channelPrefix}{gameId}` instead of
 * touching a client socket directly, for deployments that terminate
 * WebSockets in their own gateway process rather than in API Gateway.
 *
 * Subscribe to the same channel with `createRedisSubscriber` from
 * `@yingyeothon/naive-redis`.
 *
 * `sendMany` is what makes a per-tick broadcast affordable: one `PUBLISH`
 * carries the whole party instead of one per recipient, and the gateway —
 * which already holds the sockets — does the fan-out. It only pays off when
 * every recipient gets the *same* payload; per-player snapshots defeat it.
 *
 * Its boolean answers a different question than the API Gateway
 * transport's: it reports whether a **gateway** was subscribed when the
 * command was published, not whether the client received it or the
 * connection closed. Nothing downstream can tell the difference, so do not
 * pair it with `dropUndeliveredConnections` — a gateway restart would then
 * evict the whole party at once.
 */
export function createRedisPubSubTransport({
  connection,
  channelPrefix,
  gameId,
  logger = nullLogger,
}: RedisPubSubTransportOptions): Transport {
  const channel = channelPrefix + gameId;

  async function publish(command: GatewayCommand): Promise<boolean> {
    const targets = command.connectionIds?.length ?? 1;
    try {
      const receivers = await redisPublish(
        connection,
        channel,
        JSON.stringify(command),
      );
      if (receivers === 0) {
        logger.warn("no gateway is listening", {
          channel,
          op: command.op,
          targets,
        });
      }
      return receivers > 0;
    } catch (error) {
      logger.error("cannot publish a gateway command", {
        channel,
        op: command.op,
        targets,
        error,
      });
      return false;
    }
  }

  return {
    send: (connectionId, message) =>
      publish({ op: "send", connectionId, message }),
    sendMany: (connectionIds, message) =>
      publish({ op: "send", connectionIds, message }),
    drop: (connectionId) => publish({ op: "drop", connectionId }),
  };
}

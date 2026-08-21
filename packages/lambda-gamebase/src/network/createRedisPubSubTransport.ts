import { nullLogger, type Logger } from "@yingyeothon/logger";
import { redisPublish, type RedisConnection } from "@yingyeothon/naive-redis";
import type { Transport } from "./transport.js";

/**
 * What a WebSocket gateway must do on behalf of the game loop. This is the
 * only wire format this package defines, and it never reaches a game
 * client: the gateway unwraps it and forwards `message` verbatim.
 */
export type GatewayCommand =
  | { op: "send"; connectionId: string; message: unknown }
  | { op: "drop"; connectionId: string };

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
          connectionId: command.connectionId,
        });
      }
      return receivers > 0;
    } catch (error) {
      logger.error("cannot publish a gateway command", {
        channel,
        op: command.op,
        connectionId: command.connectionId,
        error,
      });
      return false;
    }
  }

  return {
    send: (connectionId, message) =>
      publish({ op: "send", connectionId, message }),
    drop: (connectionId) => publish({ op: "drop", connectionId }),
  };
}

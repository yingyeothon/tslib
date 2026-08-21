import { enqueue } from "@yingyeothon/actor-system";
import { createRedisQueue } from "@yingyeothon/actor-system-redis";
import { nullLogger, type Logger } from "@yingyeothon/logger";
import {
  redisGet,
  redisSet,
  type RedisConnection,
} from "@yingyeothon/naive-redis";
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { loadActorStartEvent } from "../actor/loadActorStartEvent.js";
import { requireRedisOptions, type GamebaseContext } from "../context.js";
import { useRedis } from "../infra/useRedis.js";
import { BadRequest, OK } from "./responses.js";

const expirationMillis = 900 * 1000;
const subprotocolHeader = "sec-websocket-protocol";

export interface HandleConnectOptions {
  event: APIGatewayProxyEvent;
  connectionIdAndGameIdKeyPrefix: string;
  actorEventKeyPrefix: string;
  actorQueueKeyPrefix: string;
  logger?: Logger;
  /**
   * Resolves the member id this connection speaks for.
   *
   * The default reads the client's `x-member-id` header or query string,
   * which is **not** authentication: anyone who learns another member's id
   * can connect as that member. In production, put a REQUEST authorizer on
   * `$connect` and read the verified identity from its context instead:
   *
   * ```ts
   * resolveMemberId: (event) => {
   *   const memberId: unknown = event.requestContext.authorizer?.["memberId"];
   *   return typeof memberId === "string" ? memberId : undefined;
   * }
   * ```
   *
   * Returning `undefined` rejects the connection, so an unauthenticated
   * request fails closed. This decides *who* a connection speaks for, not
   * *how many* connections that member may hold: nothing here caps
   * concurrent connections per member.
   */
  resolveMemberId?: (event: APIGatewayProxyEvent) => string | undefined;
  /**
   * Picks which of the subprotocols the client offered to echo back in the
   * `Sec-WebSocket-Protocol` response header.
   *
   * A browser cannot set headers on a WebSocket handshake, so a token
   * usually travels as `new WebSocket(url, ["bearer", token])`. The
   * browser then aborts the handshake unless the server names the
   * subprotocol it selected, and the value must be one the client offered:
   *
   * ```ts
   * selectSubprotocol: (offered) =>
   *   offered.includes("bearer") ? "bearer" : undefined
   * ```
   *
   * Defaults to selecting nothing, which is correct when the client offers
   * no subprotocol at all. A value the client did not offer is refused and
   * no header is sent, because a browser aborts a handshake that names an
   * unoffered subprotocol.
   *
   * **`offered` carries the credential.** In the arrangement above the list
   * is `["bearer", "<the raw JWT>"]`, so never log it.
   */
  selectSubprotocol?: (offered: readonly string[]) => string | undefined;
  /** Supplies Redis options for a short-lived, per-invocation connection. */
  context?: GamebaseContext;
  /** Overrides the per-invocation Redis connection, e.g. in tests. */
  redisConnection?: RedisConnection;
}

/** Reads a header case-insensitively; clients control header casing. */
function readHeader(
  event: APIGatewayProxyEvent,
  name: string,
): string | undefined {
  for (const [key, value] of Object.entries(event.headers ?? {})) {
    if (key.toLowerCase() === name && value !== undefined && value !== "") {
      return value;
    }
  }
  return undefined;
}

function readParameter(
  event: APIGatewayProxyEvent,
  name: string,
): string | undefined {
  return readHeader(event, name) ?? (event.queryStringParameters ?? {})[name];
}

function offeredSubprotocols(event: APIGatewayProxyEvent): string[] {
  return (readHeader(event, subprotocolHeader) ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
}

/**
 * Builds the success response, echoing a selected subprotocol when there is
 * one. RFC 6455 lets a server name only a subprotocol the client offered,
 * so an unoffered selection is dropped and reported rather than sent: it
 * would make the browser abort the handshake with nothing to point at.
 *
 * The result is always a fresh object — `OK` is a shared constant, and a
 * warm Lambda container would carry a mutation of it into later requests.
 */
function accept(
  event: APIGatewayProxyEvent,
  selectSubprotocol: HandleConnectOptions["selectSubprotocol"],
  logger: Logger,
): APIGatewayProxyResult {
  if (!selectSubprotocol) {
    return { ...OK };
  }
  const offered = offeredSubprotocols(event);
  const selected = selectSubprotocol(offered);
  if (selected === undefined) {
    return { ...OK };
  }
  if (!offered.includes(selected)) {
    // Never log `selected` or `offered`: the offered list carries the token.
    logger.error("selected subprotocol was not offered", {
      connectionId: event.requestContext.connectionId,
      offeredCount: offered.length,
    });
    return { ...OK };
  }
  return { ...OK, headers: { "Sec-WebSocket-Protocol": selected } };
}

/**
 * `$connect` handler: resolves the member id, validates it against the
 * game's start event, maps the connection id to the game, and enqueues an
 * "enter" message to the actor.
 */
export async function handleConnect({
  event,
  connectionIdAndGameIdKeyPrefix,
  actorEventKeyPrefix,
  actorQueueKeyPrefix,
  logger = nullLogger,
  resolveMemberId = (e) => readParameter(e, "x-member-id"),
  selectSubprotocol,
  context,
  redisConnection,
}: HandleConnectOptions): Promise<APIGatewayProxyResult> {
  const { connectionId } = event.requestContext;
  // A client should send a "X-GAME-ID" via HTTP header.
  const gameId = readParameter(event, "x-game-id");
  const memberId = resolveMemberId(event);

  // Validate starting information.
  if (!memberId) {
    // Also the path a `resolveMemberId` that found no verified identity
    // takes, which is why it is reported apart from a missing game id.
    logger.error("no member id for connection", { connectionId });
    return BadRequest;
  }
  if (!gameId) {
    logger.error("no game id for connection", { connectionId, memberId });
    return BadRequest;
  }
  const checkedGameId: string = gameId;

  const accepted = accept(event, selectSubprotocol, logger);

  async function withConnection(
    connection: RedisConnection,
  ): Promise<APIGatewayProxyResult> {
    const startEvent = await loadActorStartEvent({
      gameId: checkedGameId,
      get: (key) => redisGet(connection, key),
      eventKeyPrefix: actorEventKeyPrefix,
    });
    if (startEvent === null) {
      logger.error("invalid game context from gameId", { gameId });
      return BadRequest;
    }
    if (startEvent.members.every((m) => m.memberId !== memberId)) {
      // The start event carries a name and an email per member, so only
      // its size is logged.
      logger.error("not registered member", {
        gameId,
        memberId,
        connectionId,
        memberCount: startEvent.members.length,
      });
      return BadRequest;
    }

    // Register the connection and start a game.
    await redisSet(
      connection,
      connectionIdAndGameIdKeyPrefix + connectionId,
      checkedGameId,
      { expirationMillis },
    );
    await enqueue(
      {
        id: checkedGameId,
        queue: createRedisQueue({
          connection,
          keyPrefix: actorQueueKeyPrefix,
          logger,
        }),
        logger,
      },
      { item: { type: "enter", connectionId, memberId } },
    );
    logger.info("game logged", { gameId, connectionId });
    return accepted;
  }

  if (redisConnection) {
    return withConnection(redisConnection);
  }
  if (!context) {
    throw new Error("handleConnect requires either redisConnection or context");
  }
  return useRedis(withConnection, requireRedisOptions(context.options));
}

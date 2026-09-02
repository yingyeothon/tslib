import { nullLogger } from "@yingyeothon/logger";
import type { EventHandler, Unsubscribe } from "./events.js";
import { createEmitter } from "./events.js";
import type {
  DisconnectedEvent,
  GatewayClientState,
  ProtocolErrorEvent,
  ReconnectingEvent,
  StoppedEvent,
} from "./gateway-socket.js";
import { createGatewaySocket, pickSocketOptions } from "./gateway-socket.js";
import type { GatewayClientBaseOptions } from "./lobby-client.js";
import type { ErrorFrame, GameClientFrame, GameServerFrame } from "./types.js";
import { reservedGameFrameTypes } from "./types.js";

export interface GatewayGameClientOptions extends GatewayClientBaseOptions {
  /** The run to join; the caller must be in its start event's members. */
  gameId: string;
}

export interface GameEndedEvent {
  code: number;
  reason: string;
}

export interface GatewayGameClientEvents {
  /**
   * The socket is open and the gateway has pushed `enter` to the actor.
   * Fires again after a reconnect; the game answers with its own snapshot.
   */
  connected: undefined;
  /** Every game-defined frame, verbatim. */
  frame: GameServerFrame;
  /** A gateway refusal (`{ type: "error", code, message }`). */
  error: ErrorFrame;
  disconnected: DisconnectedEvent;
  reconnecting: ReconnectingEvent;
  /** Close 4001: the actor died. Retry only with a new `gameId`. */
  aborted: GameEndedEvent;
  /** Close 1000: the game dropped this connection after ending normally. */
  finished: GameEndedEvent;
  /** Any other terminal close (replaced, policy, channel gone, retries exhausted). */
  stopped: StoppedEvent;
  protocolError: ProtocolErrorEvent;
  [key: string]: unknown;
}

export interface GatewayGameClient {
  readonly state: GatewayClientState;
  /** Resolves once the socket is open with the bearer subprotocol echoed. */
  connect(): Promise<void>;
  close(): void;
  /** Sends a game frame; `enter` and `leave` are refused locally. */
  send(frame: GameClientFrame): void;
  on<K extends keyof GatewayGameClientEvents>(
    type: K,
    handler: EventHandler<GatewayGameClientEvents[K]>,
  ): Unsubscribe;
}

function isErrorFrame(
  frame: GameServerFrame,
): frame is GameServerFrame & ErrorFrame {
  return (
    frame.type === "error" &&
    typeof frame.code === "string" &&
    typeof frame.message === "string"
  );
}

/**
 * Dungeon (`q`) client. The gateway defines no outbound vocabulary here —
 * every frame belongs to the game — so this client is a typed passthrough
 * whose only protocol knowledge is the connect sequence, the reserved inbound
 * types, and the distinction between an aborted run (4001) and a finished one
 * (1000). Neither of those reconnects; a retry needs a fresh `gameId`.
 */
export function createGatewayGameClient(
  options: GatewayGameClientOptions,
): GatewayGameClient {
  const { logger = nullLogger, gameId } = options;
  const emitter = createEmitter<GatewayGameClientEvents>();
  const socket = createGatewaySocket({
    url: options.url,
    channelId: options.channelId,
    gameId,
    token: options.token,
    kind: "q",
    ...pickSocketOptions(options),
    logger,
  });

  socket.on("open", () => {
    logger.info("game connected", { channelId: options.channelId, gameId });
    emitter.emit("connected", undefined);
  });
  socket.on("frame", (frame) => {
    if (isErrorFrame(frame)) {
      logger.warn("gateway refused a game message", {
        gameId,
        code: frame.code,
      });
      emitter.emit("error", frame);
      return;
    }
    emitter.emit("frame", frame);
  });
  socket.on("disconnected", (event) => emitter.emit("disconnected", event));
  socket.on("reconnecting", (event) => emitter.emit("reconnecting", event));
  socket.on("stopped", (event) => {
    if (event.kind === "aborted") {
      emitter.emit("aborted", { code: event.code, reason: event.reason });
      return;
    }
    if (event.kind === "finished") {
      emitter.emit("finished", { code: event.code, reason: event.reason });
      return;
    }
    emitter.emit("stopped", event);
  });
  socket.on("protocolError", (event) => emitter.emit("protocolError", event));

  return {
    get state() {
      return socket.state;
    },
    connect() {
      return socket.connect();
    },
    close() {
      socket.close();
    },
    send(frame) {
      if (reservedGameFrameTypes.includes(frame.type)) {
        throw new Error(`reserved_type: ${frame.type} is set by the gateway`);
      }
      socket.send(frame);
    },
    on(type, handler) {
      return emitter.on(type, handler);
    },
  };
}

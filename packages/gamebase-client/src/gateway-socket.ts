import { jsonCodec } from "@yingyeothon/codec";
import type { Logger } from "@yingyeothon/logger";
import { nullLogger } from "@yingyeothon/logger";
import type { Backoff, BackoffOptions } from "./backoff.js";
import { createBackoff } from "./backoff.js";
import type { CloseDisposition, GatewayChannelKind } from "./close-codes.js";
import { classifyClose } from "./close-codes.js";
import type { Emitter, EventHandler, Unsubscribe } from "./events.js";
import { createEmitter } from "./events.js";
import type { WebSocketConstructor, WebSocketLike } from "./transport.js";
import { resolveWebSocket } from "./transport.js";
import type { Hello } from "./types.js";

export type GatewayClientState =
  "idle" | "connecting" | "connected" | "reconnecting" | "closed";

export interface DisconnectedEvent {
  code: number;
  reason: string;
  willReconnect: boolean;
}

export interface ReconnectingEvent {
  attempt: number;
  delayMs: number;
}

export interface StoppedEvent extends CloseDisposition {
  code: number;
}

export interface ProtocolErrorEvent {
  message: string;
}

export interface GatewaySocketEvents {
  /** The socket is open and the gateway echoed the `bearer` subprotocol. */
  open: undefined;
  hello: Hello;
  /** Every parsed frame after `hello`. */
  frame: Record<string, unknown>;
  disconnected: DisconnectedEvent;
  reconnecting: ReconnectingEvent;
  /** The connection ended for good; no reconnect will follow. */
  stopped: StoppedEvent;
  protocolError: ProtocolErrorEvent;
  [key: string]: unknown;
}

export interface GatewaySocketOptions {
  url: string;
  channelId: string;
  gameId?: string;
  token: string;
  kind: GatewayChannelKind;
  WebSocket?: WebSocketConstructor;
  backoff?: BackoffOptions;
  /** Lobby only: how long to wait for `hello` after open. Default 10000 ms. */
  helloTimeoutMs?: number;
  /**
   * Stop after this many consecutive sockets that closed before opening.
   * A refused handshake (401/403/404/410) is invisible to a browser except as
   * such a close, so this is what keeps a dead token from retrying forever.
   * Default 5.
   */
  maxHandshakeFailures?: number;
  logger?: Logger;
}

export interface GatewaySocket {
  readonly state: GatewayClientState;
  /** Resolves once the connection is usable; rejects if it stops before that. */
  connect(): Promise<void>;
  close(): void;
  send(frame: object): void;
  on<K extends keyof GatewaySocketEvents>(
    type: K,
    handler: EventHandler<GatewaySocketEvents[K]>,
  ): Unsubscribe;
}

const bearerSubprotocol = "bearer";
/** A client may only send 1000 or 3000-4999; this one marks an SDK-initiated close. */
const localCloseCode = 4900;

export function buildGatewayUrl(
  url: string,
  channelId: string,
  gameId?: string,
): string {
  const target = new URL(url);
  target.searchParams.set("channel", channelId);
  if (gameId !== undefined) {
    target.searchParams.set("gameId", gameId);
  }
  return target.toString();
}

export function createGatewaySocket(
  options: GatewaySocketOptions,
): GatewaySocket {
  const {
    kind,
    token,
    helloTimeoutMs = 10000,
    maxHandshakeFailures = 5,
    logger = nullLogger,
    channelId,
    gameId,
  } = options;
  const WebSocketImpl = resolveWebSocket(options.WebSocket);
  const url = buildGatewayUrl(options.url, channelId, gameId);
  const backoff: Backoff = createBackoff(options.backoff);
  const emitter: Emitter<GatewaySocketEvents> = createEmitter();
  const logContext = {
    kind,
    channelId,
    ...(gameId === undefined ? {} : { gameId }),
  };

  let state: GatewayClientState = "idle";
  let socket: WebSocketLike | undefined;
  let closedByUser = false;
  let ready = false;
  let helloTimer: ReturnType<typeof setTimeout> | undefined;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let closeOverride: CloseDisposition | undefined;
  let opened = false;
  let handshakeFailures = 0;
  let pending:
    { resolve: () => void; reject: (error: Error) => void } | undefined;

  function settle(error?: Error): void {
    const current = pending;
    pending = undefined;
    if (current === undefined) {
      return;
    }
    if (error === undefined) {
      current.resolve();
    } else {
      current.reject(error);
    }
  }

  function clearHelloTimer(): void {
    if (helloTimer !== undefined) {
      clearTimeout(helloTimer);
      helloTimer = undefined;
    }
  }

  function markReady(): void {
    ready = true;
    state = "connected";
    backoff.reset();
    settle();
  }

  function stop(code: number, disposition: CloseDisposition): void {
    state = "closed";
    logger.info("gateway connection stopped", {
      ...logContext,
      code,
      kind: disposition.kind,
      reason: disposition.reason,
    });
    emitter.emit("disconnected", {
      code,
      reason: disposition.reason,
      willReconnect: false,
    });
    emitter.emit("stopped", { ...disposition, code });
    settle(new Error(`gateway connection stopped: ${disposition.reason}`));
  }

  function scheduleReconnect(
    code: number,
    disposition: CloseDisposition,
  ): void {
    const delayMs = backoff.next();
    if (delayMs === undefined) {
      stop(code, { kind: "stop", reason: "reconnect attempts exhausted" });
      return;
    }
    state = "reconnecting";
    emitter.emit("disconnected", {
      code,
      reason: disposition.reason,
      willReconnect: true,
    });
    logger.info("gateway reconnecting", {
      ...logContext,
      code,
      attempt: backoff.attempts,
      delayMs,
    });
    emitter.emit("reconnecting", { attempt: backoff.attempts, delayMs });
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      open();
    }, delayMs);
  }

  function handleClose(
    closed: WebSocketLike,
    code: number,
    reason: string,
  ): void {
    if (closed !== socket) {
      return;
    }
    socket = undefined;
    ready = false;
    clearHelloTimer();
    if (closedByUser) {
      return;
    }
    let disposition = closeOverride ?? classifyClose(code, kind);
    closeOverride = undefined;
    if (!opened) {
      handshakeFailures += 1;
      if (
        disposition.kind === "reconnect" &&
        handshakeFailures >= maxHandshakeFailures
      ) {
        disposition = {
          kind: "stop",
          reason: `handshake failed ${handshakeFailures} times in a row`,
        };
      }
    }
    logger.debug("gateway socket closed", {
      ...logContext,
      code,
      reasonLength: reason.length,
    });
    if (disposition.kind === "reconnect") {
      scheduleReconnect(code, disposition);
    } else {
      stop(code, disposition);
    }
  }

  function localClose(disposition: CloseDisposition, reason: string): void {
    closeOverride = disposition;
    socket?.close(localCloseCode, reason);
  }

  function handleMessage(current: WebSocketLike, data: unknown): void {
    if (current !== socket) {
      return;
    }
    if (typeof data !== "string") {
      emitter.emit("protocolError", { message: "non-text frame" });
      return;
    }
    let parsed: unknown;
    try {
      parsed = jsonCodec.decode<unknown>(data);
    } catch {
      emitter.emit("protocolError", { message: "frame is not JSON" });
      return;
    }
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed) ||
      typeof (parsed as { type?: unknown }).type !== "string"
    ) {
      emitter.emit("protocolError", { message: "frame has no string type" });
      return;
    }
    const frame = parsed as Record<string, unknown> & { type: string };
    if (kind === "lobby" && !ready) {
      if (frame.type !== "hello") {
        emitter.emit("protocolError", {
          message: `expected hello, got ${frame.type}`,
        });
        return;
      }
      clearHelloTimer();
      markReady();
      emitter.emit("hello", frame as unknown as Hello);
      return;
    }
    emitter.emit("frame", frame);
  }

  function open(): void {
    if (closedByUser) {
      return;
    }
    if (state !== "reconnecting") {
      state = "connecting";
    }
    let created: WebSocketLike;
    try {
      created = new WebSocketImpl(url, [bearerSubprotocol, token]);
    } catch (error) {
      stop(0, {
        kind: "stop",
        reason: `cannot open WebSocket: ${(error as Error).message}`,
      });
      return;
    }
    const current = created;
    socket = current;
    opened = false;
    current.addEventListener("open", () => {
      if (current !== socket) {
        return;
      }
      opened = true;
      handshakeFailures = 0;
      if (current.protocol !== bearerSubprotocol) {
        localClose(
          {
            kind: "stop",
            reason: "gateway did not select the bearer subprotocol",
          },
          "unexpected subprotocol",
        );
        return;
      }
      emitter.emit("open", undefined);
      if (kind === "q") {
        markReady();
        return;
      }
      helloTimer = setTimeout(() => {
        helloTimer = undefined;
        localClose(
          { kind: "reconnect", reason: "hello timeout" },
          "hello timeout",
        );
      }, helloTimeoutMs);
    });
    current.addEventListener("message", (event) => {
      handleMessage(current, event.data);
    });
    current.addEventListener("close", (event) => {
      handleClose(current, event.code, event.reason);
    });
    current.addEventListener("error", () => {
      // The close event that follows carries the disposition.
    });
  }

  return {
    get state() {
      return state;
    },
    connect() {
      if (state !== "idle") {
        return Promise.reject(new Error(`connect() called in state ${state}`));
      }
      return new Promise<void>((resolve, reject) => {
        pending = { resolve, reject };
        open();
      });
    },
    close() {
      if (closedByUser) {
        return;
      }
      closedByUser = true;
      clearHelloTimer();
      if (reconnectTimer !== undefined) {
        clearTimeout(reconnectTimer);
        reconnectTimer = undefined;
      }
      const current = socket;
      socket = undefined;
      const wasReady = ready;
      ready = false;
      state = "closed";
      current?.close(1000, "client closed");
      if (wasReady || current !== undefined) {
        emitter.emit("disconnected", {
          code: 1000,
          reason: "client closed",
          willReconnect: false,
        });
      }
      settle(new Error("closed before the connection became ready"));
    },
    send(frame) {
      if (!ready || socket === undefined) {
        throw new Error(`cannot send in state ${state}`);
      }
      socket.send(jsonCodec.encode(frame));
    },
    on(type, handler) {
      return emitter.on(type, handler);
    },
  };
}

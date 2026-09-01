import type {
  WebSocketCloseEventLike,
  WebSocketConstructor,
  WebSocketLike,
  WebSocketMessageEventLike,
} from "@yingyeothon/gamebase-client";

type Listener =
  | (() => void)
  | ((event: WebSocketMessageEventLike) => void)
  | ((event: WebSocketCloseEventLike) => void);

export interface FakeWebSocket extends WebSocketLike {
  readonly url: string;
  readonly protocols: string[];
  /** Frames the client sent, parsed. */
  readonly sent: unknown[];
  /** The close the client itself requested, if any. */
  readonly clientClose: { code?: number; reason?: string } | undefined;
  serverOpen(protocol?: string): void;
  serverSend(frame: unknown): void;
  serverSendRaw(data: unknown): void;
  serverClose(code: number, reason?: string): void;
  serverError(): void;
}

export interface FakeWebSocketFactory {
  WebSocket: WebSocketConstructor;
  sockets: FakeWebSocket[];
  /** The most recently constructed socket. */
  latest(): FakeWebSocket;
}

/**
 * A WHATWG-shaped WebSocket driven from this program as if it were the server.
 *
 * The SDK reads `globalThis.WebSocket` only as the default behind an injectable
 * option, which is what makes this possible: no network, no gateway, and close
 * codes that a real socket cannot be asked to produce on cue. The same class
 * backs `gamebase-client`'s own tests, copied rather than imported because a
 * package's `test/` directory is not published.
 */
export function createFakeWebSocketFactory(): FakeWebSocketFactory {
  const sockets: FakeWebSocket[] = [];

  class Fake implements FakeWebSocket {
    readonly url: string;
    readonly protocols: string[];
    readonly sent: unknown[] = [];
    clientClose: { code?: number; reason?: string } | undefined;
    readyState = 0;
    protocol = "";
    private readonly listeners = new Map<string, Listener[]>();

    constructor(url: string, protocols: string[]) {
      this.url = url;
      this.protocols = protocols;
      sockets.push(this);
    }

    addEventListener(type: string, listener: Listener): void {
      const list = this.listeners.get(type) ?? [];
      list.push(listener);
      this.listeners.set(type, list);
    }

    private dispatch(type: string, event?: unknown): void {
      for (const listener of this.listeners.get(type) ?? []) {
        (listener as (event?: unknown) => void)(event);
      }
    }

    send(data: string): void {
      if (this.readyState !== 1) {
        throw new Error("fake socket is not open");
      }
      this.sent.push(JSON.parse(data));
    }

    close(code?: number, reason?: string): void {
      if (code !== undefined && code !== 1000 && (code < 3000 || code > 4999)) {
        throw new Error(`InvalidAccessError: close code ${code}`);
      }
      if (this.readyState >= 2) {
        return;
      }
      this.clientClose = { code, reason };
      this.readyState = 2;
      // A real socket completes the closing handshake asynchronously.
      queueMicrotask(() => {
        if (this.readyState === 3) {
          return;
        }
        this.readyState = 3;
        this.dispatch("close", { code: code ?? 1005, reason: reason ?? "" });
      });
    }

    serverOpen(protocol = "bearer"): void {
      this.readyState = 1;
      this.protocol = protocol;
      this.dispatch("open");
    }

    serverSend(frame: unknown): void {
      this.dispatch("message", { data: JSON.stringify(frame) });
    }

    serverSendRaw(data: unknown): void {
      this.dispatch("message", { data });
    }

    serverClose(code: number, reason = ""): void {
      if (this.readyState === 3) {
        return;
      }
      this.readyState = 3;
      this.dispatch("close", { code, reason });
    }

    serverError(): void {
      this.dispatch("error");
      this.serverClose(1006, "abnormal");
    }
  }

  return {
    WebSocket: Fake,
    sockets,
    latest() {
      const last = sockets[sockets.length - 1];
      if (last === undefined) {
        throw new Error("no socket constructed yet");
      }
      return last;
    },
  };
}

/** Lets pending microtasks (a fake close handshake) run. */
export function flush(): Promise<void> {
  return new Promise((resolve) => {
    queueMicrotask(() => queueMicrotask(resolve));
  });
}

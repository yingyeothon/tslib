/**
 * Structural views of the WHATWG globals the SDK needs. They are declared here
 * rather than taken from the DOM lib or `undici-types` so the public `.d.ts`
 * stays dependency-free and the same code runs in browsers and Node >= 22.
 * Node 20 callers inject an implementation through the `WebSocket` option.
 */

export interface WebSocketMessageEventLike {
  data: unknown;
}

export interface WebSocketCloseEventLike {
  code: number;
  reason: string;
}

export interface WebSocketLike {
  readonly readyState: number;
  readonly protocol: string;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "open", listener: () => void): void;
  addEventListener(
    type: "message",
    listener: (event: WebSocketMessageEventLike) => void,
  ): void;
  addEventListener(
    type: "close",
    listener: (event: WebSocketCloseEventLike) => void,
  ): void;
  addEventListener(type: "error", listener: () => void): void;
}

export type WebSocketConstructor = new (
  url: string,
  protocols: string[],
) => WebSocketLike;

export interface FetchResponseLike {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

export type FetchLike = (url: string) => Promise<FetchResponseLike>;

/** `WebSocket.OPEN` per the WHATWG constants. */
export const webSocketOpenState = 1;

export function resolveWebSocket(
  injected?: WebSocketConstructor,
): WebSocketConstructor {
  if (injected !== undefined) {
    return injected;
  }
  const global = (globalThis as { WebSocket?: WebSocketConstructor }).WebSocket;
  if (global === undefined) {
    throw new Error(
      "No global WebSocket; pass the WebSocket option (Node < 22 or a non-browser runtime)",
    );
  }
  return global;
}

export function resolveFetch(injected?: FetchLike): FetchLike {
  if (injected !== undefined) {
    return injected;
  }
  const global = (globalThis as { fetch?: FetchLike }).fetch;
  if (global === undefined) {
    throw new Error("No global fetch; pass the fetch option");
  }
  return global;
}

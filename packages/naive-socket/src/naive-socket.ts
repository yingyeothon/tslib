import { Socket } from "node:net";

import { nullLogger, type Logger } from "@yingyeothon/logger";

import { decomposePromise, type DecomposedPromise } from "./promise.js";

export enum ConnectionState {
  Connecting = "Connecting",
  Connected = "Connected",
  Disconnected = "Disconnected",
}

export type ConnectionStateListener = (params: {
  socket: NaiveSocket;
  state: ConnectionState;
}) => void;

export interface NaiveSocketOptions {
  host: string;
  port: number;

  /**
   * Milliseconds to wait before reconnecting after an unexpected close.
   * A negative value disables auto-reconnect. Default: 5000.
   */
  connectionRetryInterval?: number;
  logger?: Logger;
  onConnectionStateChanged?: ConnectionStateListener;
}

/**
 * Decides whether the accumulated response buffer fulfills a request:
 * - a function returning the length to consume (`<= 0` means "wait for more"),
 * - a RegExp whose first capture group is the response to consume, or
 * - a fixed number of characters to consume.
 */
export type Fulfill = ((buffer: string) => number) | RegExp | number;

export interface SendRequest {
  /** The payload to write to the socket. */
  message: string;

  /** How to detect the end of the response. Default: consume everything received. */
  fulfill?: Fulfill;

  /** Milliseconds until this request is rejected with a timeout error. `0` disables. */
  timeoutMillis?: number;

  /** Put this request at the front of the queue instead of the back. */
  urgent?: boolean;
}

/**
 * A minimal TCP client over `node:net` with a serialized request queue,
 * per-request timeouts, pluggable response matching, and auto-reconnect.
 */
export interface NaiveSocket {
  /** Queue a request and resolve with its fulfilled response. */
  send: (request: SendRequest) => Promise<string>;

  /** Close the connection and reject all pending requests with `DeadSocket`. */
  disconnect: () => void;
}

interface SendWork {
  message: string;
  fulfill: Fulfill;
  timeoutMillis: number;
  dPromise: DecomposedPromise<string>;
  timer: NodeJS.Timeout | null;
}

const noListener = (): void => undefined;

class NaiveSocketImpl implements NaiveSocket {
  private readonly host: string;
  private readonly port: number;
  private readonly logger: Logger;
  private readonly onConnectionStateChanged: ConnectionStateListener;
  private readonly connectionRetryInterval: number;

  private readonly sendWorks: SendWork[] = [];
  private currentBuffer = "";
  private connectionState: ConnectionState = ConnectionState.Disconnected;
  private socket: Socket | null = null;
  private alive = true;

  constructor({
    host,
    port,
    connectionRetryInterval = 5000,
    logger = nullLogger,
    onConnectionStateChanged = noListener,
  }: NaiveSocketOptions) {
    this.host = host;
    this.port = port;
    this.connectionRetryInterval = connectionRetryInterval;
    this.logger = logger;
    this.onConnectionStateChanged = onConnectionStateChanged;
  }

  public send = (request: SendRequest): Promise<string> => {
    this.alive = true;
    const newWork = this.buildSendWork(request);
    if (request.urgent) {
      this.sendWorks.unshift(newWork);
    } else {
      this.sendWorks.push(newWork);
    }
    if (this.sendWorks.length === 1) {
      this.doNextSendWork();
    }
    return newWork.dPromise.promise;
  };

  public disconnect = (): void => {
    this.alive = false;
    this.logger.info(`[NaiveSocket]`, `Socket is dead`);
    this.doDisconnect();

    // Reject all pending send works.
    for (const work of this.sendWorks.splice(0)) {
      if (work.timer !== null) {
        clearTimeout(work.timer);
      }
      work.dPromise.reject(new Error(`DeadSocket`));
    }
  };

  private buildSendWork = ({
    message,
    fulfill = (buffer) => buffer.length,
    timeoutMillis = 0,
  }: SendRequest): SendWork => {
    const newWork: SendWork = {
      message,
      fulfill,
      timeoutMillis,
      dPromise: decomposePromise<string>(),
      timer: null,
    };
    if (timeoutMillis > 0) {
      newWork.timer = setTimeout(() => {
        newWork.dPromise.reject(new Error(`Timeout ${timeoutMillis}millis`));
      }, timeoutMillis);
    }
    return newWork;
  };

  private changeConnectionState = (newConnectionState: ConnectionState) => {
    this.connectionState = newConnectionState;
    this.onConnectionStateChanged({ socket: this, state: newConnectionState });
  };

  private connect = () => {
    this.logger.info(`[NaiveSocket]`, `Start to connect`);
    this.changeConnectionState(ConnectionState.Connecting);
    this.socket = new Socket();
    this.socket.addListener("connect", this.onConnect);
    this.socket.addListener("error", this.onError);
    this.socket.addListener("data", this.onData);
    this.socket.addListener("close", this.onClose);
    this.socket.connect(this.port, this.host);
  };

  private doDisconnect = () => {
    if (this.socket !== null) {
      this.logger.info(`[NaiveSocket]`, `Disconnect`);
      try {
        this.socket.destroy();
      } catch (error) {
        this.logger.warn(
          `[NaiveSocket]`,
          `Error occurred while disconnecting`,
          error,
        );
      }
    }
    this.changeConnectionState(ConnectionState.Disconnected);
    this.socket = null;
  };

  private onConnect = () => {
    this.changeConnectionState(ConnectionState.Connected);
    this.doNextSendWork();
  };

  private onClose = () => {
    if (this.alive) {
      this.logger.info(`[NaiveSocket]`, `Try to reconnect`);
      this.retryToConnect();
    }
  };

  private retryToConnect = () => {
    this.doDisconnect();
    if (this.sendWorks.length === 0) {
      return;
    }
    if (this.connectionRetryInterval < 0) {
      return;
    }
    setTimeout(() => {
      if (this.connectionState === ConnectionState.Disconnected) {
        this.connect();
      }
    }, this.connectionRetryInterval);
  };

  private onError = (error: Error) => {
    switch (this.connectionState) {
      case ConnectionState.Connecting:
        this.logger.warn(
          `[NaiveSocket]`,
          `Cannot connect to the opposite`,
          error,
        );
        // Try to reconnect at the `onClose` handler if alive.
        break;
      case ConnectionState.Connected:
        // This error would be caught at the `socket.write` callback.
        break;
      case ConnectionState.Disconnected:
        // No error is expected in this state.
        this.logger.error(
          `[NaiveSocket]`,
          `Invalid error in disconnected state`,
          error,
        );
        break;
    }
  };

  private onData = (data: Buffer) => {
    this.currentBuffer += data.toString("utf-8");
    const work = this.sendWorks[0];
    if (!work) {
      this.logger.error(
        `[NaiveSocket]`,
        `No work but more response`,
        this.currentBuffer,
      );
      this.currentBuffer = "";
      return;
    }

    const { fulfill } = work;
    const length =
      fulfill instanceof RegExp
        ? fulfillByRegex(fulfill, this.currentBuffer)
        : typeof fulfill === "number"
          ? fulfillByLength(fulfill, this.currentBuffer)
          : fulfill(this.currentBuffer);
    if (length <= 0) {
      return;
    }
    work.dPromise.resolve(this.currentBuffer.substring(0, length));
    if (work.timer !== null) {
      clearTimeout(work.timer);
    }

    this.currentBuffer = this.currentBuffer.substring(length);
    this.sendWorks.shift();
    this.doNextSendWork();
  };

  private doNextSendWork = () => {
    if (
      this.socket === null ||
      this.connectionState !== ConnectionState.Connected
    ) {
      this.connect();
      return;
    }

    // Drop works already settled by their timeout.
    while (this.sendWorks[0]?.dPromise.isSettled === true) {
      this.sendWorks.shift();
    }

    const firstWork = this.sendWorks[0];
    if (!firstWork) {
      return;
    }
    this.socket.write(firstWork.message, (error?: Error | null) => {
      if (!error) {
        return;
      }
      this.sendWorks.shift();
      firstWork.dPromise.reject(error);
      if (firstWork.timer !== null) {
        clearTimeout(firstWork.timer);
      }

      this.retryToConnect();
    });
  };
}

/**
 * Create a {@link NaiveSocket} connected lazily to `host:port`.
 * Logging defaults to `nullLogger`; pass a `logger` to observe activity.
 */
export function createNaiveSocket(options: NaiveSocketOptions): NaiveSocket {
  return new NaiveSocketImpl(options);
}

function fulfillByRegex(regex: RegExp, buffer: string): number {
  const matched = buffer.match(regex);
  const captured = matched?.[1];
  return captured !== undefined ? captured.length : -1;
}

function fulfillByLength(length: number, buffer: string): number {
  return buffer.length >= length ? length : -1;
}

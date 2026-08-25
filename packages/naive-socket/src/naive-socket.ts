import { isIP, Socket } from "node:net";
import { StringDecoder } from "node:string_decoder";
import { connect as tlsConnect, type ConnectionOptions } from "node:tls";

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

  /**
   * Consumes data that no pending request claims, which is how a
   * server-push protocol (Redis pub/sub, for example) delivers messages.
   * It receives the whole unclaimed buffer and returns the number of
   * characters it consumed; `<= 0` leaves the buffer for the next chunk.
   *
   * Setting it also keeps the socket reconnecting while the request queue
   * is empty, because a subscriber has nothing pending by design.
   * Without it, unclaimed data is logged and discarded.
   */
  onUnsolicitedData?: UnsolicitedDataConsumer;

  /**
   * Wraps the connection in TLS. `true` uses Node's defaults with `host`
   * as the SNI server name; an object is passed to `tls.connect` as is,
   * so a private CA arrives as `{ ca }`. Unset means **cleartext** — the
   * password and every command travel in the clear, which is only
   * acceptable inside a trusted network.
   */
  tls?: boolean | TlsOptions;
}

/**
 * `tls.connect` options, minus the ones this socket supplies itself
 * (`host`, `port`).
 */
export type TlsOptions = Omit<ConnectionOptions, "host" | "port">;

/**
 * Consumes the unclaimed receive buffer and returns how many characters
 * it took; `<= 0` means "wait for more data".
 */
export type UnsolicitedDataConsumer = (buffer: string) => number;

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

  /**
   * Whether a response belongs to this request. Default: `true`.
   *
   * Set it to `false` for commands whose reply is not addressed to the
   * caller — a Redis `SUBSCRIBE`, for example, is answered on the push
   * stream. Such a request resolves with an empty string as soon as it is
   * written, and every byte it triggers goes to `onUnsolicitedData`.
   */
  expectResponse?: boolean;
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
  expectResponse: boolean;
  dPromise: DecomposedPromise<string>;
  timer: NodeJS.Timeout | null;
  /** Already handed to the current socket; cleared when that socket dies. */
  written: boolean;
}

const noListener = (): void => undefined;

class NaiveSocketImpl implements NaiveSocket {
  private readonly host: string;
  private readonly port: number;
  private readonly logger: Logger;
  private readonly onConnectionStateChanged: ConnectionStateListener;
  private readonly connectionRetryInterval: number;
  private readonly onUnsolicitedData: UnsolicitedDataConsumer | undefined;
  private readonly tls: boolean | TlsOptions | undefined;

  private readonly sendWorks: SendWork[] = [];
  // Decodes UTF-8 across chunk boundaries: a multi-byte character split
  // between two TCP chunks would be corrupted by a per-chunk toString().
  private decoder = new StringDecoder("utf-8");
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
    onUnsolicitedData,
    tls,
  }: NaiveSocketOptions) {
    this.host = host;
    this.port = port;
    this.connectionRetryInterval = connectionRetryInterval;
    this.logger = logger;
    this.onConnectionStateChanged = onConnectionStateChanged;
    this.onUnsolicitedData = onUnsolicitedData;
    this.tls = tls;
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
    this.failAllPendingWork(new Error(`DeadSocket`));
  };

  private buildSendWork = ({
    message,
    fulfill = (buffer) => buffer.length,
    timeoutMillis = 0,
    expectResponse = true,
  }: SendRequest): SendWork => {
    const newWork: SendWork = {
      message,
      fulfill,
      timeoutMillis,
      expectResponse,
      dPromise: decomposePromise<string>(),
      timer: null,
      written: false,
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
    try {
      this.openSocket();
    } catch (error) {
      // `tls.connect` validates its options synchronously and throws, while
      // `new Socket()` cannot. Without this the throw escapes `send` (which
      // drives the queue synchronously) leaving the request unsettled, and
      // escapes the reconnect timer as an uncaught exception.
      this.logger.error(`[NaiveSocket]`, `Cannot open the socket`, error);
      this.failAllPendingWork(
        error instanceof Error ? error : new Error(String(error)),
      );
      this.changeConnectionState(ConnectionState.Disconnected);
      this.socket = null;
    }
  };

  private failAllPendingWork = (error: Error) => {
    for (const work of this.sendWorks.splice(0)) {
      if (work.timer !== null) {
        clearTimeout(work.timer);
      }
      work.dPromise.reject(error);
    }
  };

  private openSocket = () => {
    // `tls.connect` starts connecting on its own and reports readiness as
    // `secureConnect`, so the plaintext `connect` call and event name are
    // the only difference between the two paths.
    this.socket = this.tls
      ? tlsConnect({
          // RFC 6066 forbids an IP address as the SNI server name, and Node
          // warns about it, so only a hostname is offered.
          ...(isIP(this.host) === 0 ? { servername: this.host } : {}),
          ...(this.tls === true ? {} : this.tls),
          host: this.host,
          port: this.port,
        })
      : new Socket();
    this.socket.addListener(
      this.tls ? "secureConnect" : "connect",
      this.onConnect,
    );
    this.socket.addListener("error", this.onError);
    this.socket.addListener("data", this.onData);
    this.socket.addListener("close", this.onClose);
    if (!this.tls) {
      this.socket.connect(this.port, this.host);
    }
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
    // A half-received frame cannot be completed by the next connection,
    // and the decoder may hold a partial multi-byte character.
    this.decoder = new StringDecoder("utf-8");
    this.currentBuffer = "";
    // Whatever reached the dead socket has to be written again.
    for (const work of this.sendWorks) {
      work.written = false;
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
    // A push consumer has no pending work by design, so an empty queue
    // must not stop it from reconnecting.
    if (this.sendWorks.length === 0 && this.onUnsolicitedData === undefined) {
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
    this.currentBuffer += this.decoder.write(data);
    const head = this.sendWorks[0];
    // A request that expects no response never claims incoming bytes, so
    // they belong to the push stream just like an empty queue's do.
    const work = head?.expectResponse === true ? head : undefined;
    if (!work) {
      this.consumeUnsolicitedData();
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

    // Whatever is left over belongs to the push stream unless the next
    // request claims it.
    if (
      this.currentBuffer.length > 0 &&
      this.sendWorks[0]?.expectResponse !== true
    ) {
      this.consumeUnsolicitedData();
    }
  };

  private consumeUnsolicitedData = () => {
    const consume = this.onUnsolicitedData;
    if (consume === undefined) {
      // The buffer is whatever the peer just sent — a stored value, a
      // credential echo, a game payload. Report its size, never its bytes.
      this.logger.error(`[NaiveSocket]`, `No work but more response`, {
        length: this.currentBuffer.length,
      });
      this.currentBuffer = "";
      return;
    }

    // One chunk can carry several frames, so keep feeding the consumer
    // until it stops taking bytes.
    while (this.currentBuffer.length > 0) {
      let length: number;
      try {
        length = consume(this.currentBuffer);
      } catch (error) {
        this.logger.error(
          `[NaiveSocket]`,
          `Unsolicited data consumer failed`,
          error,
        );
        this.currentBuffer = "";
        return;
      }
      if (length <= 0) {
        return;
      }
      this.currentBuffer = this.currentBuffer.substring(length);
    }
  };

  private doNextSendWork = () => {
    if (this.connectionState === ConnectionState.Connecting) {
      // `onConnect` resumes the queue; starting a second socket here would
      // orphan this one and let both feed the shared receive buffer.
      return;
    }
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
    if (!firstWork || firstWork.written) {
      // `onConnect` both notifies its listener — which may enqueue and
      // write from inside that callback — and resumes the queue itself, so
      // the head can be reached twice for one connection.
      return;
    }
    firstWork.written = true;
    this.socket.write(firstWork.message, (error?: Error | null) => {
      if (error) {
        if (this.sendWorks[0] === firstWork) {
          this.sendWorks.shift();
        }
        firstWork.dPromise.reject(error);
        if (firstWork.timer !== null) {
          clearTimeout(firstWork.timer);
        }

        this.retryToConnect();
        return;
      }

      if (firstWork.expectResponse) {
        return;
      }

      // Nothing will claim a response for this work, so retiring it here
      // is what keeps the queue moving.
      firstWork.dPromise.resolve("");
      if (firstWork.timer !== null) {
        clearTimeout(firstWork.timer);
      }
      if (this.sendWorks[0] === firstWork) {
        this.sendWorks.shift();
        this.doNextSendWork();
      }
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

import type { Logger } from "@yingyeothon/logger";
import { nullLogger } from "@yingyeothon/logger";
import type { BackoffOptions } from "./backoff.js";
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
import type { MapFetcher } from "./map-fetch.js";
import { createMapFetcher } from "./map-fetch.js";
import type { PeerMap, PeerMapFrame } from "./peer-map.js";
import { createPeerMap } from "./peer-map.js";
import type { FetchLike, WebSocketConstructor } from "./transport.js";
import type {
  Capabilities,
  Direction,
  ErrorFrame,
  EventBroadcastFrame,
  Hello,
  LobbyClientFrame,
  LobbyServerFrame,
  PartyDeclinedFrame,
  PartyFrame,
  PartyInviteFrame,
  Peer,
  SayBroadcastFrame,
  SayScope,
  SnapshotFrame,
} from "./types.js";

export interface GatewayClientBaseOptions {
  /** Gateway origin, e.g. `wss://gw.yyt.life`. The query string is added by the SDK. */
  url: string;
  channelId: string;
  /** Channel JWT. It rides in the subprotocol list and is never logged. */
  token: string;
  /** Defaults to the global `WebSocket`; required on Node 20. */
  WebSocket?: WebSocketConstructor;
  backoff?: BackoffOptions;
  /** Consecutive closes-before-open that end the session. Default 5. */
  maxHandshakeFailures?: number;
  logger?: Logger;
}

export interface GatewayLobbyClientOptions extends GatewayClientBaseOptions {
  /** Used for `map()`; defaults to the global `fetch`. */
  fetch?: FetchLike;
  /** How long to wait for `hello` after the socket opens. Default 10000 ms. */
  helloTimeoutMs?: number;
}

export interface GatewayLobbyClientEvents {
  /** `hello` arrived; also fires again after every successful reconnect. */
  connected: Hello;
  disconnected: DisconnectedEvent;
  reconnecting: ReconnectingEvent;
  stopped: StoppedEvent;
  snapshot: SnapshotFrame;
  peerEnter: Peer;
  peerLeave: string;
  peerMove: Peer[];
  say: SayBroadcastFrame;
  event: EventBroadcastFrame;
  party: PartyFrame;
  partyInvite: PartyInviteFrame;
  partyDeclined: PartyDeclinedFrame;
  pong: undefined;
  error: ErrorFrame;
  protocolError: ProtocolErrorEvent;
  /**
   * Every frame after `hello`, before any SDK handling; a `party` frame is
   * already filled in (see `PartyFrame`).
   */
  frame: LobbyServerFrame;
  [key: string]: unknown;
}

export interface PartyCommands {
  create(): void;
  invite(userId: string): void;
  accept(partyId: string): void;
  decline(partyId: string): void;
  leave(): void;
  list(): void;
}

export interface GatewayLobbyClient {
  readonly state: GatewayClientState;
  /** The latest `hello`, once connected. */
  readonly hello: Hello | undefined;
  readonly capabilities: Capabilities | undefined;
  /** Current party id, from `hello.partyId` or the latest `party` frame. */
  readonly partyId: string | undefined;
  /** The latest `party` roster frame, if any. */
  readonly roster: PartyFrame | undefined;
  readonly peers: PeerMap;
  /** Resolves with `hello`. Rejects if the connection stops before that. */
  connect(): Promise<Hello>;
  close(): void;
  /** Fetches `hello.mapUrl` (cached per URL). */
  map(): Promise<unknown>;
  pos(input: { zone: string; x: number; y: number; dir?: Direction }): void;
  say(input: { scope: SayScope; to?: string; text: string }): void;
  event(input: {
    scope: SayScope;
    to?: string;
    name: string;
    payload: unknown;
  }): void;
  readonly party: PartyCommands;
  ping(): void;
  /** Escape hatch for a typed frame the helpers do not cover. */
  send(frame: LobbyClientFrame): void;
  on<K extends keyof GatewayLobbyClientEvents>(
    type: K,
    handler: EventHandler<GatewayLobbyClientEvents[K]>,
  ): Unsubscribe;
}

function normalizePartyId(partyId: string | undefined): string | undefined {
  return partyId === undefined || partyId === "" ? undefined : partyId;
}

/** The gateway refuses a `dir` longer than this many bytes as `bad_message`. */
const maxDirBytes = 16;

/**
 * The gateway marshals the roster with Go `omitempty`: `leaderId`, `invited`,
 * and `max` are missing when empty (always after leave/dissolve, and
 * `invited` whenever nobody is pending); `members` is guarded the same way in
 * case a future gateway marks it too. Fill them so the public type stays
 * strict and a handler can read `roster.invited.length` without a guard.
 */
function normalizePartyFrame(frame: PartyFrame): PartyFrame {
  const partial = frame as Partial<PartyFrame>;
  return {
    ...frame,
    leaderId: partial.leaderId ?? "",
    members: partial.members ?? [],
    invited: partial.invited ?? [],
    max: partial.max ?? 0,
  };
}

/**
 * Lobby client: connects with the bearer subprotocol, waits for `hello`
 * before reporting a connection, maintains the peer map from the gateway's
 * `snapshot` / `enter` / `leave` / `pos` frames, and exposes typed senders.
 * After a reconnect the peer map is empty until the game re-sends `pos` and
 * the gateway answers with a fresh `snapshot`.
 */
export function createGatewayLobbyClient(
  options: GatewayLobbyClientOptions,
): GatewayLobbyClient {
  const { logger = nullLogger } = options;
  const emitter = createEmitter<GatewayLobbyClientEvents>();
  const socket = createGatewaySocket({
    url: options.url,
    channelId: options.channelId,
    token: options.token,
    kind: "lobby",
    ...pickSocketOptions(options),
    ...(options.helloTimeoutMs === undefined
      ? {}
      : { helloTimeoutMs: options.helloTimeoutMs }),
    logger,
  });
  let mapFetcher: MapFetcher | undefined;
  let hello: Hello | undefined;
  let partyId: string | undefined;
  let roster: PartyFrame | undefined;
  let peers: PeerMap = createPeerMap({ selfUserId: "" });

  function requireCapability(name: "pos" | "party" | "event"): void {
    if (hello?.capabilities[name] === false) {
      throw new Error(`capability_off: ${name} is disabled on this channel`);
    }
  }

  function requireSayScope(scope: SayScope): void {
    const allowed = hello?.capabilities.say;
    if (allowed !== undefined && !allowed.includes(scope)) {
      throw new Error(`capability_off: say scope ${scope} is disabled`);
    }
  }

  function send(frame: LobbyClientFrame): void {
    socket.send(frame);
  }

  function applyPeerFrame(frame: PeerMapFrame): void {
    const change = peers.apply(frame);
    if (change === undefined) {
      return;
    }
    switch (change.kind) {
      case "snapshot":
        emitter.emit("snapshot", frame as SnapshotFrame);
        return;
      case "enter":
        emitter.emit("peerEnter", change.peer);
        return;
      case "leave":
        emitter.emit("peerLeave", change.userId);
        return;
      case "move":
        emitter.emit("peerMove", change.peers);
        return;
    }
  }

  socket.on("hello", (frame) => {
    hello = frame;
    partyId = normalizePartyId(frame.partyId);
    // A roster from before the outage may be stale; the gateway re-sends
    // `party` after `hello` whenever it still knows the party.
    roster = undefined;
    peers = createPeerMap({ selfUserId: frame.userId });
    logger.info("lobby connected", {
      channelId: options.channelId,
      userId: frame.userId,
      tick: frame.tick,
      zone: frame.zone,
    });
    emitter.emit("connected", frame);
  });
  socket.on("frame", (raw) => {
    const received = raw as unknown as LobbyServerFrame;
    const frame =
      received.type === "party" ? normalizePartyFrame(received) : received;
    emitter.emit("frame", frame);
    switch (frame.type) {
      case "snapshot":
      case "enter":
      case "leave":
      case "pos":
        applyPeerFrame(frame);
        return;
      case "say":
        emitter.emit("say", frame);
        return;
      case "event":
        emitter.emit("event", frame);
        return;
      case "party":
        roster = frame;
        partyId = normalizePartyId(frame.partyId);
        emitter.emit("party", frame);
        return;
      case "party.invite":
        emitter.emit("partyInvite", frame);
        return;
      case "party.declined":
        emitter.emit("partyDeclined", frame);
        return;
      case "pong":
        emitter.emit("pong", undefined);
        return;
      case "error":
        logger.warn("gateway refused a lobby message", {
          channelId: options.channelId,
          code: frame.code,
        });
        emitter.emit("error", frame);
        return;
      default:
        emitter.emit("protocolError", {
          message: `unknown frame type ${(frame as { type: string }).type}`,
        });
    }
  });
  socket.on("disconnected", (event) => {
    peers.reset();
    emitter.emit("disconnected", event);
  });
  socket.on("reconnecting", (event) => emitter.emit("reconnecting", event));
  socket.on("stopped", (event) => emitter.emit("stopped", event));
  socket.on("protocolError", (event) => emitter.emit("protocolError", event));

  const partyCommands: PartyCommands = {
    create() {
      requireCapability("party");
      send({ type: "party.create" });
    },
    invite(userId) {
      requireCapability("party");
      send({ type: "party.invite", userId });
    },
    accept(id) {
      requireCapability("party");
      send({ type: "party.accept", partyId: id });
    },
    decline(id) {
      requireCapability("party");
      send({ type: "party.decline", partyId: id });
    },
    leave() {
      requireCapability("party");
      send({ type: "party.leave" });
    },
    list() {
      requireCapability("party");
      send({ type: "party.list" });
    },
  };

  return {
    get state() {
      return socket.state;
    },
    get hello() {
      return hello;
    },
    get capabilities() {
      return hello?.capabilities;
    },
    get partyId() {
      return partyId;
    },
    get roster() {
      return roster;
    },
    get peers() {
      return peers;
    },
    async connect() {
      await socket.connect();
      return hello as Hello;
    },
    close() {
      socket.close();
    },
    map() {
      if (hello === undefined) {
        return Promise.reject(new Error("map() needs hello first"));
      }
      mapFetcher ??= createMapFetcher({
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
        logger,
      });
      return mapFetcher.fetch(hello.mapUrl);
    },
    pos(input) {
      requireCapability("pos");
      if (
        input.dir !== undefined &&
        new TextEncoder().encode(input.dir).length > maxDirBytes
      ) {
        throw new Error(`dir must be at most ${maxDirBytes} bytes`);
      }
      send({ type: "pos", ...input });
    },
    say(input) {
      requireSayScope(input.scope);
      send({ type: "say", ...input });
    },
    event(input) {
      requireCapability("event");
      requireSayScope(input.scope);
      send({ type: "event", ...input });
    },
    party: partyCommands,
    ping() {
      send({ type: "ping" });
    },
    send,
    on(type, handler) {
      return emitter.on(type, handler);
    },
  };
}

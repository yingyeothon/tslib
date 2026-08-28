/**
 * Wire types for the yyt WebSocket gateway. The normative spec is the
 * gateway's own README (service repo, `gateway/README.md`); these types mirror
 * it so a game imports rather than redeclares them.
 */

export type SayScope = "zone" | "party" | "user";

/** The channel's capability object, forwarded verbatim in `hello`. */
export interface Capabilities {
  pos?: boolean;
  say?: SayScope[];
  party?: boolean;
  event?: boolean;
  debug?: boolean;
}

/** First frame on a lobby channel; nothing is "connected" before it. */
export interface Hello {
  type: "hello";
  userId: string;
  connectionId: string;
  /** Position flush interval in milliseconds (the channel's `flushIntervalMs`). */
  tick: number;
  /** Immutable, public map asset. A new map version is a new URL. */
  mapUrl: string;
  /** The zone the game should start in; the player has no zone until the first `pos`. */
  zone: string;
  /** Present when the gateway already knows this player's party. */
  partyId?: string;
  capabilities: Capabilities;
}

/**
 * Facing token. It is the game's own opaque string (e.g. `"n"`, `"left"`),
 * at most 16 bytes on the wire; the gateway refuses the whole frame as
 * `bad_message` when it is not a string.
 */
export type Direction = string;

export interface Peer {
  userId: string;
  x: number;
  y: number;
  dir?: Direction;
}

/** Documented gateway refusal codes; the union stays open for future ones. */
export type GatewayErrorCode =
  | "capability_off"
  | "bad_zone"
  | "move_too_far"
  | "bad_scope"
  | "no_party"
  | "unknown_user"
  | "too_long"
  | "already_in_party"
  | "not_leader"
  | "party_full"
  | "unknown_party"
  | "not_invited"
  | "rate_limited"
  | "reserved_type"
  | "unavailable"
  | (string & {});

export interface ErrorFrame {
  type: "error";
  code: GatewayErrorCode;
  message: string;
}

// ---- lobby: client -> gateway ----

export interface PosFrame {
  type: "pos";
  zone: string;
  x: number;
  y: number;
  dir?: Direction;
}

export interface SayFrame {
  type: "say";
  scope: SayScope;
  to?: string;
  text: string;
}

export interface EventFrame {
  type: "event";
  scope: SayScope;
  to?: string;
  name: string;
  payload: unknown;
}

export interface PartyCreateFrame {
  type: "party.create";
}

export interface PartyInviteRequestFrame {
  type: "party.invite";
  userId: string;
}

export interface PartyAcceptFrame {
  type: "party.accept";
  partyId: string;
}

export interface PartyDeclineFrame {
  type: "party.decline";
  partyId: string;
}

export interface PartyLeaveFrame {
  type: "party.leave";
}

export interface PartyListFrame {
  type: "party.list";
}

export interface PingFrame {
  type: "ping";
}

export type LobbyClientFrame =
  | PosFrame
  | SayFrame
  | EventFrame
  | PartyCreateFrame
  | PartyInviteRequestFrame
  | PartyAcceptFrame
  | PartyDeclineFrame
  | PartyLeaveFrame
  | PartyListFrame
  | PingFrame;

// ---- lobby: gateway -> client ----

export interface SnapshotFrame {
  type: "snapshot";
  zone: string;
  peers: Peer[];
}

export interface EnterFrame {
  type: "enter";
  zone: string;
  userId: string;
  x: number;
  y: number;
  dir?: Direction;
}

export interface LeaveFrame {
  type: "leave";
  zone: string;
  userId: string;
}

/** Coalesced positions once per `tick`; includes the receiver's own entry. */
export interface PosBroadcastFrame {
  type: "pos";
  zone: string;
  peers: Peer[];
}

export interface SayBroadcastFrame {
  type: "say";
  from: string;
  scope: SayScope;
  to?: string;
  text: string;
}

export interface EventBroadcastFrame {
  type: "event";
  from: string;
  scope: SayScope;
  to?: string;
  name: string;
  payload: unknown;
}

export interface PartyMember {
  userId: string;
  online: boolean;
}

/**
 * Roster snapshot on every change and on reconnect; `partyId: ""` means no
 * party. On the wire `leaderId`, `invited`, and `max` are omitted when empty
 * (Go `omitempty`); the lobby client fills them in as `""`, `[]`, and `0`
 * (and a missing `members` as `[]`) before the frame reaches `roster`, a
 * `party` handler, or the `frame` event.
 */
export interface PartyFrame {
  type: "party";
  partyId: string;
  leaderId: string;
  members: PartyMember[];
  invited: string[];
  max: number;
}

export interface PartyInviteFrame {
  type: "party.invite";
  partyId: string;
  from: string;
}

export interface PartyDeclinedFrame {
  type: "party.declined";
  partyId: string;
  userId: string;
}

export interface PongFrame {
  type: "pong";
}

export type LobbyServerFrame =
  | Hello
  | SnapshotFrame
  | EnterFrame
  | LeaveFrame
  | PosBroadcastFrame
  | SayBroadcastFrame
  | EventBroadcastFrame
  | PartyFrame
  | PartyInviteFrame
  | PartyDeclinedFrame
  | PongFrame
  | ErrorFrame;

// ---- q (dungeon) ----

/** Inbound game frames are opaque to the gateway except for `type`. */
export interface GameClientFrame {
  type: string;
  [key: string]: unknown;
}

/** Outbound game frames are the game's own; the gateway forwards them verbatim. */
export type GameServerFrame = Record<string, unknown>;

/** Types the gateway synthesises itself and refuses from a client. */
export const reservedGameFrameTypes: readonly string[] = ["enter", "leave"];

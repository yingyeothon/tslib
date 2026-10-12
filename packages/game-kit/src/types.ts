import type { Logger } from "@yingyeothon/logger";
import type { PlatformFetchLike } from "@yingyeothon/platform-client";
import type { WebSocketConstructor } from "@yingyeothon/gamebase-client";

export interface GameKitConfig {
  /** Preserve future kit-config sections without enabling unimplemented modules. */
  [section: string]: unknown;
  auth?: { url: string; channelId: string; provider?: string };
  state?: { url: string };
  gateway?: { url: string; lobbyChannelId: string };
  collections?: Record<string, string>;
}
export type KitErrorCode =
  | "not_configured"
  | "signed_out"
  | "offline"
  | "conflict"
  | "out_of_range"
  | "payload_too_large"
  | "not_your_turn"
  | "mismatch"
  | "unavailable"
  | "rate_limited"
  | "channel_inactive"
  | "forbidden"
  | "invalid_state"
  | "cancelled";
export interface KitError extends Error {
  readonly name: "KitError";
  readonly module: string;
  readonly code: KitErrorCode;
  readonly retryable: boolean;
  readonly cause?: { status?: number; code?: string };
}
export interface KitScheduler {
  now(): number;
  schedule(callback: () => void, delayMs: number): () => void;
}
export interface SessionIdentity {
  token: string;
  userId: string;
  expiresAt: number;
}
export interface TokenStorage {
  load(): Promise<string | undefined>;
  store(token: string): Promise<void>;
  clear(): Promise<void>;
}
export interface LoginFlow {
  returnedUrl: Promise<string>;
  cancel(): void;
}
export interface LoginAdapter {
  open(startUrl: string, redirectUrl: string): LoginFlow;
}
export interface Session {
  readonly token: string | undefined;
  readonly userId: string | undefined;
  readonly expiresAt: number | undefined;
  signIn(): Promise<SessionIdentity>;
  fromToken(jwt: string): Promise<SessionIdentity>;
  restore(): Promise<SessionIdentity | undefined>;
  signOut(): Promise<void>;
  now(): number;
  on(event: "expiring" | "signedOut", handler: () => void): () => void;
}
export type MergePolicy = (local: unknown, remote: unknown) => unknown;
export interface SaveStoreOptions {
  merge?: MergePolicy;
  ttl?: number;
}
export interface QueuedWrite {
  id: string;
  name: string;
  kind: "store" | "remove";
  value?: unknown;
  expectedVersion?: number;
  ttl?: number;
}
export interface OfflineQueueStorage {
  load(namespace: string): Promise<QueuedWrite[]>;
  store(namespace: string, writes: QueuedWrite[]): Promise<void>;
}
export interface Save {
  load<T = unknown>(name: string): Promise<T | undefined>;
  store(
    name: string,
    value: unknown,
    options?: SaveStoreOptions,
  ): Promise<void>;
  update<T>(
    name: string,
    update: (value: T | undefined) => T,
    options?: SaveStoreOptions,
  ): Promise<void>;
  remove(name: string): Promise<void>;
  counter(name: string): {
    add(
      delta: number,
      options?: { min?: number; max?: number },
    ): Promise<number>;
  };
  claimOnce(name: string, ttl: number): Promise<boolean>;
  readonly pendingCount: number;
  flush(): Promise<void>;
}
export interface ContentEntry<T> {
  key: string;
  value: T;
}
export interface Content {
  get<T = unknown>(key: string): Promise<T | undefined>;
  list<T = unknown>(options?: { prefix?: string }): Promise<ContentEntry<T>[]>;
  subscribe<T = unknown>(
    key: string,
    handler: (value: T | undefined) => void,
  ): () => void;
}
export interface RoomMember {
  userId: string;
  online: boolean;
}
export interface RoomInvitation {
  roomId: string;
  from: string;
  accept(): Promise<void>;
  decline(): Promise<void>;
}
export interface RoomEvents {
  invited: RoomInvitation;
  memberJoined: RoomMember;
  memberLeft: RoomMember;
  memberOnline: RoomMember;
  hostChanged: string;
  state: unknown;
  error: KitError;
}
export interface Room {
  readonly id: string | undefined;
  readonly members: RoomMember[];
  readonly host: string | undefined;
  readonly isHost: boolean;
  create(): Promise<void>;
  invite(userId: string): Promise<void>;
  leave(): Promise<void>;
  send(name: string, payload: unknown): Promise<void>;
  whisper(userId: string, name: string, payload: unknown): Promise<void>;
  on<K extends keyof RoomEvents>(
    name: K,
    handler: (event: RoomEvents[K]) => void,
  ): () => void;
  on(
    name: string,
    handler: (event: { from: string; payload: unknown }) => void,
  ): () => void;
  becomeHost(handler: (event: { lastKnown: unknown }) => void): () => void;
  readonly state: { publish(snapshot: unknown): Promise<void> };
}
export interface TurnRecord<Move = unknown> {
  index: number;
  move: Move;
  by: string;
  hash: string;
}
export interface TurnsStartOptions<Move, State> {
  room: Room;
  players?: string[];
  initial: State;
  apply: (state: State, move: Move, by: string) => State;
  persist?: boolean;
  saveResultAs?: string;
  maxLogBytes?: number;
  logTtlSeconds?: number;
}
export interface TurnGame<Move, State> {
  readonly state: State;
  readonly index: number;
  readonly log: TurnRecord<Move>[];
  readonly frozen: boolean;
  /** Informational monotonic milliseconds observed by this instance; not persisted. */
  readonly elapsed: Readonly<Record<string, number>>;
  submit(move: Move): Promise<void>;
  finish(result: unknown): Promise<void>;
  dispose(): void;
  on(
    name: "turn",
    handler: (event: {
      state: State;
      move: Move;
      by: string;
      index: number;
    }) => void,
  ): () => void;
  on(
    name: "mismatch",
    handler: (event: { index: number; by: string }) => void,
  ): () => void;
  on(name: "error", handler: (event: KitError) => void): () => void;
}
export interface GameKitOptions {
  config: GameKitConfig;
  fetch?: PlatformFetchLike;
  WebSocket?: WebSocketConstructor;
  logger?: Logger;
  scheduler?: KitScheduler;
  login?: { redirectUrl: string; adapter?: LoginAdapter; timeoutMs?: number };
  tokenStorage?: TokenStorage;
  content?: { pollIntervalMs?: number };
  save?: {
    offlineQueue?: OfflineQueueStorage;
    mergePolicies?: Record<string, MergePolicy>;
    maxMergeRetries?: number;
  };
  room?: { timeoutMs?: number };
}
export interface GameKit {
  readonly session: Session;
  readonly content: Content;
  readonly save: Save;
  readonly room: Room;
  readonly turns: {
    start<Move, State>(
      options: TurnsStartOptions<Move, State>,
    ): TurnGame<Move, State>;
  };
  setForeground(foreground: boolean): void;
  dispose(): void;
}

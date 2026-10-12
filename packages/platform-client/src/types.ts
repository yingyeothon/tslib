import type { Logger } from "@yingyeothon/logger";
import type { WebSocketConstructor } from "@yingyeothon/gamebase-client";
export interface PlatformFetchRequest {
  method: string;
  headers: Record<string, string>;
  body?: string;
  redirect?: "error";
  signal?: AbortSignal;
}
export interface PlatformFetchResponse {
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}
export type PlatformFetchLike = (
  url: string,
  request: PlatformFetchRequest,
) => Promise<PlatformFetchResponse>;
export interface PlatformClientOptions {
  baseUrl: string;
  token?: string;
  fetch?: PlatformFetchLike;
  logger?: Logger;
}
export interface PlatformTime {
  now: string;
  epochMs: number;
}
export interface PlatformClientError extends Error {
  readonly name: "PlatformClientError";
  readonly status: number;
  readonly code: string;
  readonly reason?: string;
  readonly retryAfterMs?: number;
}
export type BoardPeriod = "alltime" | "daily" | "weekly";
export interface PlatformBoardPeriod {
  period: BoardPeriod;
  periodKey: string;
  periodEndsAt: number | null;
}
export interface PlatformBoardInfo {
  id: string;
  name: string;
  submit: "owner" | "server";
  rule: "best" | "latest" | "sum";
  order: "asc" | "desc";
  maxEntries: number;
  periods: PlatformBoardPeriod[];
}
export interface PlatformBoardScore {
  owner: string;
  score: number;
  meta: string | null;
  rank: number;
  updatedAt: number;
}
export interface PlatformBoardPage extends PlatformBoardPeriod {
  total: number;
  entries: PlatformBoardScore[];
}
export interface PlatformBoardOwnScore extends PlatformBoardPeriod {
  owner: string;
  score: number;
  meta: string | null;
  rank: number;
  total: number;
  updatedAt: number;
}
export interface PlatformBoardSubmitOptions {
  score: number;
  meta?: string;
}
export interface PlatformBoardTopOptions {
  period: BoardPeriod;
  limit?: number;
  offset?: number;
}
export interface PlatformBoardSubmission extends PlatformBoardPeriod {
  score: number;
  updatedAt: number;
}
export interface PlatformBoardSubmitResult {
  submitted: number;
  periods: PlatformBoardSubmission[];
}
export interface PlatformBoard {
  info(): Promise<PlatformBoardInfo>;
  submit(
    options: PlatformBoardSubmitOptions,
  ): Promise<PlatformBoardSubmitResult>;
  top(options: PlatformBoardTopOptions): Promise<PlatformBoardPage>;
  me(period: BoardPeriod): Promise<PlatformBoardOwnScore | undefined>;
}
export interface PlatformProfile {
  owner: string;
  displayName: string;
  avatar: string | null;
  updatedAt: number;
}
export interface PlatformProfileOptions {
  displayName: string;
  avatar?: string | null;
}
export interface PlatformRelation {
  owner: string;
  displayName: string | null;
  avatar: string | null;
  since: number;
}
export interface PlatformRequests {
  incoming: PlatformRelation[];
  outgoing: PlatformRelation[];
}
export interface PlatformSocial {
  profile(): Promise<PlatformProfile | undefined>;
  setProfile(options: PlatformProfileOptions): Promise<PlatformProfile>;
  profiles(ids: string[]): Promise<PlatformProfile[]>;
  friends(): Promise<PlatformRelation[]>;
  requests(): Promise<PlatformRequests>;
  request(userId: string): Promise<{ state: string }>;
  accept(userId: string): Promise<void>;
  decline(userId: string): Promise<void>;
  remove(userId: string): Promise<void>;
  block(userId: string): Promise<void>;
  unblock(userId: string): Promise<void>;
}
export interface PlatformClient {
  time(): Promise<PlatformTime>;
  board(nameOrId: string): PlatformBoard;
  readonly social: PlatformSocial;
}
export interface PlatformPresenceClientOptions extends PlatformClientOptions {
  channelId: string;
  token: string;
}
export interface PlatformPresence {
  userId: string;
  online: boolean;
}
export interface PlatformPresenceClient {
  users(ids: string[]): Promise<PlatformPresence[]>;
}
export interface MatchMember {
  userId: string;
  [field: string]: unknown;
}
export interface MatchResult {
  matchId: string;
  partial: boolean;
  result: unknown;
  members: MatchMember[];
  [field: string]: unknown;
}
export type MatchTicket = (
  | { state: "waiting"; position: number; waited: number }
  | {
      state: "proposed";
      matchId: string;
      acceptBy: number;
      accepted: boolean;
      partial: boolean;
    }
  | ({ state: "confirmed" } & MatchResult)
  | { state: "expired"; reason: "wait" | "accept"; matchId?: string }
  | { state: "declined"; matchId: string }
  | { state: "failed"; reason: "callback" | "closed"; matchId?: string }
) & { [field: string]: unknown };
export interface DeferredMatchClientOptions extends PlatformClientOptions {
  channelId: string;
  token: string;
}
export interface DeferredMatchClient {
  submit(): Promise<MatchTicket>;
  status(): Promise<MatchTicket | undefined>;
  cancel(): Promise<void>;
  accept(): Promise<MatchTicket>;
  decline(): Promise<MatchTicket>;
}
export interface LiveMatchClientOptions {
  url: string;
  channelId: string;
  token: string;
  WebSocket?: WebSocketConstructor;
  logger?: Logger;
}
export interface LiveMatchClient {
  find(): Promise<MatchResult>;
  cancel(): void;
}

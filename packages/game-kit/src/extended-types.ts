import type {
  BoardPeriod,
  PlatformBoardScore,
  PlatformProfile,
  PlatformProfileOptions,
  PlatformRelation,
  MatchResult,
  MatchTicket,
} from "@yingyeothon/platform-client";
export interface BoardPeriodInfo {
  period: BoardPeriod;
  periodKey: string;
  endsAt: number | null;
}
export interface BoardSubmission {
  period: BoardPeriod;
  rank: number;
  score: number;
  endsAt: number | null;
}
export interface BoardPage extends BoardPeriodInfo {
  total: number;
  entries: PlatformBoardScore[];
}
export interface BoardSubmitOptions {
  score: number;
  meta?: string;
}
export interface BoardTopOptions {
  period: BoardPeriod;
  limit?: number;
  offset?: number;
}
export interface BoardAroundOptions {
  period: BoardPeriod;
  span: number;
}
export interface Board {
  readonly periods: BoardPeriodInfo[];
  readonly rule: "best" | "latest" | "sum";
  readonly order: "asc" | "desc";
  submit(options: BoardSubmitOptions): Promise<BoardSubmission[]>;
  top(options: BoardTopOptions): Promise<BoardPage>;
  me(
    period: BoardPeriod,
  ): Promise<{ score: number; rank: number; total: number } | undefined>;
  around(options: BoardAroundOptions): Promise<BoardPage>;
}
export interface MailLetter<T = unknown> {
  id: string;
  from: string;
  at: number;
  value: T;
  expiresAt?: number;
}
export interface MailSendOptions {
  to: string;
  value: unknown;
  ttl?: number;
}
export interface Mail {
  list<T = unknown>(): Promise<MailLetter<T>[]>;
  read<T = unknown>(id: string): Promise<MailLetter<T> | undefined>;
  claim<T = unknown>(id: string): Promise<MailLetter<T>>;
  remove(id: string): Promise<void>;
  send(options: MailSendOptions): Promise<void>;
  on(event: "arrived", handler: (letter: MailLetter) => void): () => void;
}
export interface Friend {
  userId: string;
  profile: { displayName: string | null; avatar: string | null };
  online: boolean;
}
export interface FriendRequests {
  incoming: PlatformRelation[];
  outgoing: PlatformRelation[];
}
export interface Friends {
  list(): Promise<Friend[]>;
  requests(): Promise<FriendRequests>;
  request(userId: string): Promise<void>;
  accept(userId: string): Promise<void>;
  decline(userId: string): Promise<void>;
  remove(userId: string): Promise<void>;
  block(userId: string): Promise<void>;
  unblock(userId: string): Promise<void>;
  profiles(ids: string[]): Promise<PlatformProfile[]>;
  readonly profile: {
    me(): Promise<PlatformProfile | undefined>;
    set(options: PlatformProfileOptions): Promise<PlatformProfile>;
  };
  invite(userId: string): Promise<void>;
  on(event: "requested", handler: (from: string) => void): () => void;
}
export interface MatchFindOptions {
  timeoutMs?: number;
}
export interface Matchmaking {
  find(options?: MatchFindOptions): Promise<MatchResult>;
  submit(): Promise<MatchTicket>;
  status(): Promise<MatchTicket | undefined>;
  cancel(): Promise<void>;
  accept(): Promise<MatchTicket>;
  decline(): Promise<MatchTicket>;
  on(event: "stateChanged", handler: (ticket: MatchTicket) => void): () => void;
}
export interface PushTopicAdapter {
  subscribe(topic: string): Promise<void>;
  unsubscribe(topic: string): Promise<void>;
}
export interface KitPushMessage {
  data?: Record<string, string>;
  notification?: { title?: string; body?: string };
  [field: string]: unknown;
}
export type PushClassification =
  | { kind: "match"; channelId: string; matchId: string; state: string }
  | { kind: "message"; message: KitPushMessage };
export interface KitPushRegisterOptions {
  token: string;
  project?: string;
}
export interface KitPush {
  register(options: KitPushRegisterOptions): Promise<void>;
  unregister(): Promise<void>;
  classify(message: KitPushMessage): PushClassification;
}

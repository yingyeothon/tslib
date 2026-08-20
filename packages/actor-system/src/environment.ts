import type { Logger } from "@yingyeothon/logger";

/** The identity of an actor. */
export interface ActorProperty {
  id: string;
}

/** An optional logger for actor internals. Defaults to `nullLogger`. */
export interface ActorLogger {
  logger?: Logger;
}

/** An optional error hook invoked when a message handler throws. */
export interface ActorErrorHandler {
  onError?: (error: Error) => unknown;
}

/** Handles messages one at a time, with optional prepare/commit hooks. */
export interface ActorSingleMessageHandler<T> {
  _consume: "single";
  onMessage: (message: T) => unknown;
  onPrepare?: (id: string) => unknown;
  onCommit?: (id: string) => unknown;
}

/** Handles all currently queued messages in one call. */
export interface ActorMessageBulkConsumer<T> {
  _consume: "bulk";
  onMessages: (messages: T[]) => unknown;
}

/** Spread into an options object to select single-message consumption. */
export const singleConsumer: { _consume: "single" } = { _consume: "single" };

/** Spread into an options object to select bulk-message consumption. */
export const bulkConsumer: { _consume: "bulk" } = { _consume: "bulk" };

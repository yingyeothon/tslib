/**
 * Appends an item to the tail of an actor's queue and resolves with the
 * queue's depth after the push.
 *
 * The depth is free on a Redis list — `RPUSH` replies with it — and it is
 * the cheapest way for a producer to notice that nobody is consuming.
 */
export interface QueueProducer {
  push: <T>(actorId: string, item: T) => Promise<number>;
}

/** Consumes an actor's queue one item at a time, preserving order. */
export interface QueueSingleConsumer {
  pop: <T>(actorId: string) => Promise<T | null>;
  peek: <T>(actorId: string) => Promise<T | null>;
}

/** Drains all currently queued items of an actor at once. */
export interface QueueBulkConsumer {
  flush: <T>(actorId: string) => Promise<T[]>;
}

/** Reports the number of items currently queued for an actor. */
export interface QueueLength {
  size: (actorId: string) => Promise<number>;
}

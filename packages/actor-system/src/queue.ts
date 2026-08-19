/** Appends an item to the tail of an actor's queue. */
export interface QueueProducer {
  push: <T>(actorId: string, item: T) => Promise<void>;
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

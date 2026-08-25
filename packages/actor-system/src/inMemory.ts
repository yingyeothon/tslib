import type { AwaiterResolve, AwaiterWait } from "./awaiter.js";
import type { LockAcquire, LockRelease } from "./lock.js";
import type {
  QueueBulkConsumer,
  QueueLength,
  QueueProducer,
  QueueSingleConsumer,
} from "./queue.js";

type BooleanResolver = (result: boolean) => void;

/** An in-process awaiter for single-process actor systems and tests. */
export interface InMemoryAwaiter extends AwaiterWait, AwaiterResolve {}

/** Create an in-process awaiter for single-process actor systems and tests. */
export function createInMemoryAwaiter(): InMemoryAwaiter {
  const resolvers = new Map<string, BooleanResolver>();

  function finish(id: string, result: boolean): void {
    const resolver = resolvers.get(id);
    if (!resolver) {
      return;
    }
    resolver(result);
    resolvers.delete(id);
  }

  return {
    wait(
      actorId: string,
      messageId: string,
      timeoutMillis: number,
    ): Promise<boolean> {
      const id = actorId + messageId;
      return new Promise<boolean>((resolve) => {
        resolvers.set(id, resolve);
        if (timeoutMillis > 0) {
          setTimeout(() => finish(id, false), timeoutMillis);
        }
      });
    },
    resolve(actorId: string, messageId: string): Promise<void> {
      finish(actorId + messageId, true);
      return Promise.resolve();
    },
  };
}

/** An in-process, non-reentrant lock for single-process actor systems. */
export interface InMemoryLock extends LockAcquire, LockRelease {}

/** Create an in-process, non-reentrant lock for single-process actor systems. */
export function createInMemoryLock(): InMemoryLock {
  const lockHolders = new Set<string>();

  return {
    tryAcquire(actorId: string): Promise<boolean> {
      if (lockHolders.has(actorId)) {
        return Promise.resolve(false);
      }
      lockHolders.add(actorId);
      return Promise.resolve(true);
    },
    release(actorId: string): Promise<boolean> {
      return Promise.resolve(lockHolders.delete(actorId));
    },
  };
}

/** An in-process FIFO queue per actor for single-process actor systems. */
export interface InMemoryQueue
  extends QueueLength, QueueProducer, QueueSingleConsumer, QueueBulkConsumer {}

/** Create an in-process FIFO queue per actor for single-process actor systems. */
export function createInMemoryQueue(): InMemoryQueue {
  const queues = new Map<string, unknown[]>();

  return {
    size(actorId: string): Promise<number> {
      return Promise.resolve(queues.get(actorId)?.length ?? 0);
    },
    push<T>(actorId: string, item: T): Promise<number> {
      const queue = queues.get(actorId);
      if (queue) {
        queue.push(item);
        return Promise.resolve(queue.length);
      }
      queues.set(actorId, [item]);
      return Promise.resolve(1);
    },
    pop<T>(actorId: string): Promise<T | null> {
      const queue = queues.get(actorId);
      if (!queue || queue.length === 0) {
        return Promise.resolve(null);
      }
      return Promise.resolve(queue.shift() as T);
    },
    peek<T>(actorId: string): Promise<T | null> {
      const queue = queues.get(actorId);
      if (!queue || queue.length === 0) {
        return Promise.resolve(null);
      }
      return Promise.resolve(queue[0] as T);
    },
    flush<T>(actorId: string): Promise<T[]> {
      const queue = queues.get(actorId);
      if (!queue || queue.length === 0) {
        return Promise.resolve([]);
      }
      queues.delete(actorId);
      return Promise.resolve(queue as T[]);
    },
  };
}

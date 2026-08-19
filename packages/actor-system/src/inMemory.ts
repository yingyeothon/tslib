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
export class InMemoryAwaiter implements AwaiterWait, AwaiterResolve {
  private readonly resolvers = new Map<string, BooleanResolver>();

  public wait(
    actorId: string,
    messageId: string,
    timeoutMillis: number,
  ): Promise<boolean> {
    const id = actorId + messageId;
    return new Promise<boolean>((resolve) => {
      this.resolvers.set(id, resolve);
      if (timeoutMillis > 0) {
        setTimeout(() => this.finish(id, false), timeoutMillis);
      }
    });
  }

  public resolve(actorId: string, messageId: string): Promise<void> {
    this.finish(actorId + messageId, true);
    return Promise.resolve();
  }

  private finish(id: string, result: boolean): void {
    const resolver = this.resolvers.get(id);
    if (!resolver) {
      return;
    }
    resolver(result);
    this.resolvers.delete(id);
  }
}

/** An in-process, non-reentrant lock for single-process actor systems. */
export class InMemoryLock implements LockAcquire, LockRelease {
  private readonly lockHolders = new Set<string>();

  public tryAcquire(actorId: string): Promise<boolean> {
    if (this.lockHolders.has(actorId)) {
      return Promise.resolve(false);
    }
    this.lockHolders.add(actorId);
    return Promise.resolve(true);
  }

  public release(actorId: string): Promise<boolean> {
    return Promise.resolve(this.lockHolders.delete(actorId));
  }
}

/** An in-process FIFO queue per actor for single-process actor systems. */
export class InMemoryQueue
  implements QueueLength, QueueProducer, QueueSingleConsumer, QueueBulkConsumer
{
  private readonly queues = new Map<string, unknown[]>();

  public size = (actorId: string): Promise<number> => {
    return Promise.resolve(this.queues.get(actorId)?.length ?? 0);
  };

  public push = <T>(actorId: string, item: T): Promise<void> => {
    const queue = this.queues.get(actorId);
    if (queue) {
      queue.push(item);
    } else {
      this.queues.set(actorId, [item]);
    }
    return Promise.resolve();
  };

  public pop = <T>(actorId: string): Promise<T | null> => {
    const queue = this.queues.get(actorId);
    if (!queue || queue.length === 0) {
      return Promise.resolve(null);
    }
    return Promise.resolve(queue.shift() as T);
  };

  public peek = <T>(actorId: string): Promise<T | null> => {
    const queue = this.queues.get(actorId);
    if (!queue || queue.length === 0) {
      return Promise.resolve(null);
    }
    return Promise.resolve(queue[0] as T);
  };

  public flush = <T>(actorId: string): Promise<T[]> => {
    const queue = this.queues.get(actorId);
    if (!queue || queue.length === 0) {
      return Promise.resolve([]);
    }
    this.queues.delete(actorId);
    return Promise.resolve(queue as T[]);
  };
}

import { nullLogger } from "@yingyeothon/logger";
import type { ActorLogger, ActorProperty } from "./environment.js";
import type { LockAcquire, LockRelease } from "./lock.js";
import type { UserMessage } from "./message.js";
import type { QueueBulkConsumer } from "./queue.js";

export type ActorEventLoopOptions<T> = ActorProperty &
  ActorLogger & {
    lock: LockAcquire & LockRelease;
    queue: QueueBulkConsumer;
    loop: (poll: () => Promise<T[]>) => Promise<void>;
  };

/**
 * Acquire this actor's lock and run a user-provided loop with a `poll`
 * function that drains the queued message items. Returns false when the
 * lock is already held by someone else.
 */
export async function eventLoop<T>(
  env: ActorEventLoopOptions<T>,
): Promise<boolean> {
  const { id, queue, lock, loop, logger = nullLogger } = env;

  // Do nothing if cannot get the lock.
  logger.debug("try to lock", { actorId: id });
  if (!(await lock.tryAcquire(id))) {
    logger.debug("cannot lock", { actorId: id });
    return false;
  }

  const poll = async () => {
    const messages: UserMessage<T>[] = await queue.flush(id);
    logger.debug("poll messages", { actorId: id, count: messages.length });
    return messages.map((message) => message.item);
  };

  logger.debug("start loop", { actorId: id });
  await loop(poll);

  // Whatever its reason, release the lock.
  logger.debug("release lock", { actorId: id });
  await lock.release(id);

  return true;
}

import type { ActorLogger, ActorProperty } from "./environment.js";
import type { LockAcquire, LockRelease } from "./lock.js";
import { noopLogger } from "./logger.js";
import type { UserMessage } from "./message.js";
import type { QueueBulkConsumer } from "./queue.js";

export type ActorEventLoopEnvironment<T> = ActorProperty &
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
  env: ActorEventLoopEnvironment<T>,
): Promise<boolean> {
  const { id, queue, lock, loop, logger = noopLogger } = env;

  // Do nothing if cannot get the lock.
  logger.debug("actor", "try-to-lock", id);
  if (!(await lock.tryAcquire(id))) {
    logger.debug("actor", "cannot-lock", id);
    return false;
  }

  const poll = async () => {
    const messages: UserMessage<T>[] = await queue.flush(id);
    logger.debug("actor", "poll-messages", id, messages.length);
    return messages.map((message) => message.item);
  };

  logger.debug("actor", "start-loop", id);
  await loop(poll);

  // Whatever its reason, release the lock.
  logger.debug("actor", "release-lock", id);
  await lock.release(id);

  return true;
}

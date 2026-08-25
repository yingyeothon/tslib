import { nullLogger } from "@yingyeothon/logger";
import type { ActorLogger, ActorProperty } from "./environment.js";
import type { LockAcquire, LockRelease, LockRenew } from "./lock.js";
import {
  startLockHeartbeat,
  warnAboutMissingHeartbeat,
} from "./lockHeartbeat.js";
import type { UserMessage } from "./message.js";
import type { QueueBulkConsumer } from "./queue.js";

export type ActorEventLoopOptions<T> = ActorProperty &
  ActorLogger & {
    lock: LockAcquire & LockRelease & Partial<LockRenew>;
    queue: QueueBulkConsumer;
    loop: (poll: () => Promise<T[]>) => Promise<void>;
    /**
     * Called once, after the lock is acquired and before `loop` runs.
     *
     * This is the only point that means "this invocation owns the actor",
     * so a readiness handshake belongs here rather than at the call site,
     * where a duplicate invocation would also announce itself.
     */
    onAcquired?: () => Promise<unknown>;
    /**
     * Extends the lock every this many milliseconds while `loop` runs, so a
     * short lease can outlive a long game without leaving a crashed actor's
     * lock held for the game's full lifetime. Ignored when `lock` has no
     * `renew`; unset means no heartbeat.
     */
    lockRenewIntervalMillis?: number;
    /**
     * Called once when the lease is lost — another process owns this actor
     * now. `poll` already refuses from that moment on, which is what stops
     * this loop from consuming the new owner's messages; use this to tear
     * down anything else the game is still doing.
     */
    onLockLost?: () => void;
  };

/**
 * Acquire this actor's lock and run a user-provided loop with a `poll`
 * function that drains the queued message items. Returns false when the
 * lock is already held by someone else.
 *
 * `poll` is **at-most-once**: it flushes the queue, which removes the batch
 * from the backing store before `loop` has acted on it, so a crash between
 * the two loses that batch with no error anywhere. `tryToProcess` is the
 * at-least-once alternative (peek, handle, then pop). Pick deliberately: a
 * game that cannot lose input needs an ack above the queue.
 *
 * If the lease is lost mid-loop — `lock.renew` answering false while
 * `lockRenewIntervalMillis` is set — `poll` rejects from that point on, so
 * this loop stops consuming messages that now belong to another owner. The
 * rejection surfaces wherever the game awaits `poll`; handle it as the end
 * of the game, because it is.
 */
export async function eventLoop<T>(
  env: ActorEventLoopOptions<T>,
): Promise<boolean> {
  const {
    id,
    queue,
    lock,
    loop,
    onAcquired,
    lockRenewIntervalMillis,
    onLockLost,
    logger = nullLogger,
  } = env;

  // Do nothing if cannot get the lock.
  logger.debug("try to lock", { actorId: id });
  if (!(await lock.tryAcquire(id))) {
    logger.debug("cannot lock", { actorId: id });
    return false;
  }

  let lockLost = false;
  const poll = async () => {
    if (lockLost) {
      // Flushing here would take the messages the new owner is waiting for
      // and hand them to a simulation nobody is listening to any more.
      throw new Error(`Actor lock lost [${id}]`);
    }
    const messages: UserMessage<T>[] = await queue.flush(id);
    logger.debug("poll messages", { actorId: id, count: messages.length });
    return messages.map((message) => message.item);
  };

  warnAboutMissingHeartbeat(id, lock, lockRenewIntervalMillis, logger);
  const stopHeartbeat = startLockHeartbeat({
    actorId: id,
    lock,
    intervalMillis: lockRenewIntervalMillis,
    logger,
    onLost: () => {
      lockLost = true;
      onLockLost?.();
    },
  });
  try {
    if (onAcquired) {
      await onAcquired();
    }
    logger.debug("start loop", { actorId: id });
    await loop(poll);
  } finally {
    // Whatever its reason — including a throw out of `loop` — release the
    // lock, or this actor stays unstartable until the lease expires.
    stopHeartbeat();
    logger.debug("release lock", { actorId: id });
    await lock.release(id);
  }

  return true;
}

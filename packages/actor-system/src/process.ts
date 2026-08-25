import { nullLogger } from "@yingyeothon/logger";
import type { AwaiterResolve } from "./awaiter.js";
import { notifyCompletion, notifyCompletions } from "./awaiting.js";
import type {
  ActorErrorHandler,
  ActorLogger,
  ActorMessageBulkConsumer,
  ActorProperty,
  ActorSingleMessageHandler,
} from "./environment.js";
import type { LockAcquire, LockRelease, LockRenew } from "./lock.js";
import {
  startLockHeartbeat,
  warnAboutMissingHeartbeat,
} from "./lockHeartbeat.js";
import type { AwaiterMeta, UserMessage } from "./message.js";
import { AwaitPolicy } from "./message.js";
import type {
  QueueBulkConsumer,
  QueueLength,
  QueueSingleConsumer,
} from "./queue.js";
import type { ActorShift } from "./shift.js";

const defaultIdleIntervalMillis = 50;

export interface TryToProcessOptions {
  /**
   * A flag that decides whether to process the actor's message queue only once or continue.
   * Combining `aliveMillis` can lead to complex situations, so please refer to `aliveMillis` comment.
   */
  oneShot?: boolean;

  /**
   * Continue processing messages in the actor's queue for the specified time.
   * However, if the actor is already owned by another thread, you can still try meaningless idling.
   * If `oneShot` is true, this operation will terminate as soon as it is finished, even if this time remains.
   *
   * The default value depends on the following situations:
   * 1. If both this value and `oneShot` are not set, `oneShot` is regarded as true and executed only once.
   * 2. If this value is set and `oneShot` is not set, `oneShot` is regarded as false and the actor will continue to be tried during that time.
   *
   * If this value is not set and `oneShot` is false, the processing function will not terminate.
   */
  aliveMillis?: number;

  /**
   * If an actor runs on a container that has a limitation of lifetime
   * such as AWS Lambda, it should shift to a new actor to process all messages
   * properly from the situation that kills a container by its hypervisor.
   *
   * An actor can have a limited lifetime via env parameter, and when it has
   * been reached it occurs `shift` event to its observers to give a shift chance.
   */
  shiftable?: boolean;

  /**
   * Extends the lock every this many milliseconds while this call runs.
   *
   * The lock is now held for the whole call, so a lease shorter than
   * `aliveMillis` no longer re-stamps itself between drain cycles: without
   * a heartbeat it simply expires mid-run and a second invocation starts
   * draining the same queue. Ignored when the lock has no `renew`.
   */
  lockRenewIntervalMillis?: number;

  /**
   * How long to wait before re-checking a queue that drained empty, and
   * before retrying a lock another invocation holds. Default 50.
   *
   * Without it both loops spin as fast as the event loop allows, which at
   * `aliveMillis` scale is millions of pointless round trips.
   */
  idleIntervalMillis?: number;
}

export type ActorSingleOptions<T> = ActorProperty &
  ActorLogger & { queue: QueueSingleConsumer & QueueLength } & {
    awaiter: AwaiterResolve;
  } & ActorSingleMessageHandler<T> &
  ActorErrorHandler;

export type ActorBulkOptions<T> = ActorProperty &
  ActorLogger & { queue: QueueBulkConsumer & QueueLength } & {
    awaiter: AwaiterResolve;
  } & ActorMessageBulkConsumer<T> &
  ActorErrorHandler;

export type ActorLoopOptions<T> = (
  ActorSingleOptions<T> | ActorBulkOptions<T>
) & {
  lock: LockAcquire & LockRelease & Partial<LockRenew>;
};

export type ActorProcessOptions<T> = ActorLoopOptions<T> & {
  shift?: ActorShift;
};

/**
 * Try to acquire this actor's lock and process its queued messages.
 * Returns the metadata of every message processed by this call, and an
 * empty array when the lock is already held by someone else.
 *
 * The lock is held for the whole call, drain cycles included, so a
 * competing invocation waits until this one returns rather than taking
 * ownership between cycles. A call with `aliveMillis` and no `oneShot`
 * therefore keeps retrying the lock until it gets it or runs out of time;
 * a one-shot call gives up on the first miss. Message consumption here is
 * **at-least-once** (peek, handle, then pop); `eventLoop` is the
 * at-most-once alternative.
 *
 * Pass `lockRenewIntervalMillis` whenever the lease is shorter than
 * `aliveMillis`, or it expires mid-run and a second invocation starts
 * draining the same queue.
 */
export async function tryToProcess<T>(
  env: ActorProcessOptions<T>,
  {
    oneShot,
    aliveMillis,
    shiftable,
    lockRenewIntervalMillis,
    idleIntervalMillis = defaultIdleIntervalMillis,
  }: TryToProcessOptions = {},
): Promise<AwaiterMeta[]> {
  const { logger = nullLogger, id, shift } = env;
  const maybeOneShot = oneShot === undefined && aliveMillis === undefined;
  const once = oneShot === true || maybeOneShot;

  const startMillis = Date.now();
  const isAlive = () =>
    aliveMillis && aliveMillis > 0
      ? Date.now() - startMillis < aliveMillis
      : true;

  // The lock is taken once and held for every drain cycle below. Releasing
  // it between cycles let another invocation take ownership mid-run, and
  // actor state lives in the winner's heap while the shift payload carries
  // only an actorId — so ownership could migrate to a process holding
  // different state.
  if (!(await acquire())) {
    return [];
  }

  let lockLost = false;
  warnAboutMissingHeartbeat(id, env.lock, lockRenewIntervalMillis, logger);
  const stopHeartbeat = startLockHeartbeat({
    actorId: id,
    lock: env.lock,
    intervalMillis: lockRenewIntervalMillis,
    logger,
    onLost: () => {
      lockLost = true;
    },
  });

  const metas: AwaiterMeta[] = [];
  let shiftOnTimeout = false;
  try {
    const stillOurs = () => isAlive() && !lockLost;
    while (stillOurs()) {
      const localMetas = await processLoop(env, stillOurs);
      metas.push(...localMetas);

      if (once || lockLost || !isAlive()) {
        break;
      }

      // The queue drained; without a pause this loop would spin for the
      // whole of `aliveMillis` while holding the lock.
      await sleep(Math.min(idleIntervalMillis, remainingMillis()));
    }
    // Shift to a new actor when the container ran out of time, whether or
    // not a drain cycle got to run inside it.
    shiftOnTimeout = shiftable === true && !isAlive();
  } finally {
    stopHeartbeat();
    // Whatever its reason, release the lock.
    logger.debug("release lock", { actorId: id });
    await env.lock.release(id);
  }

  // The successor has to be able to acquire, so this cannot happen while
  // the lock is still held.
  if (shiftOnTimeout) {
    logger.debug("shift on timeout", { actorId: id });
    if (shift) {
      await maybeAwait(shift(id));
    }
  }
  return metas;

  /**
   * A caller that asked to stay alive asked to take the actor over when its
   * current owner finishes; only a one-shot call gives up on the first miss.
   */
  async function acquire(): Promise<boolean> {
    for (;;) {
      logger.debug("try to lock", { actorId: id });
      if (await env.lock.tryAcquire(id)) {
        return true;
      }
      logger.debug("cannot lock", { actorId: id });
      if (once || !isAlive()) {
        return false;
      }
      await sleep(Math.min(idleIntervalMillis, remainingMillis()));
    }
  }

  function remainingMillis(): number {
    return aliveMillis && aliveMillis > 0
      ? Math.max(0, startMillis + aliveMillis - Date.now())
      : Number.POSITIVE_INFINITY;
  }
}

function sleep(millis: number): Promise<void> {
  return millis > 0 && Number.isFinite(millis)
    ? new Promise((resolve) => setTimeout(resolve, millis))
    : Promise.resolve();
}

/** Drains the queue under a lock the caller already holds. */
async function processLoop<T>(
  env: ActorLoopOptions<T>,
  isAlive: () => boolean,
): Promise<AwaiterMeta[]> {
  const { id, queue, logger = nullLogger } = env;

  const messageMetas: AwaiterMeta[] = [];
  logger.debug("process loop", { actorId: id });
  while (isAlive()) {
    let localMetas: AwaiterMeta[] = [];
    switch (env._consume) {
      case "single":
        localMetas = await processInSingleMode(env, isAlive);
        break;
      case "bulk":
        localMetas = await processInBulkMode(env, isAlive);
        break;
    }
    messageMetas.push(...localMetas);

    // Notify the end of process to awaiters.
    await notifyCompletions(
      env,
      messageMetas.filter((meta) => meta.awaitPolicy === AwaitPolicy.Commit),
    );

    // There is no messages in the queue,
    // We can get off from it.
    if ((await queue.size(id)) === 0) {
      logger.debug("empty queue", { actorId: id });
      break;
    }

    // Otherwise, we must keep go on
    // because there is another message and it is alive.
  }
  return messageMetas;
}

async function processInSingleMode<T>(
  env: ActorSingleOptions<T>,
  isAlive: () => boolean,
): Promise<AwaiterMeta[]> {
  if (!isAlive()) {
    return [];
  }

  const { id, onPrepare, onCommit } = env;

  // Consume messages in the queue if locked.
  if (onPrepare) {
    await maybeAwait(onPrepare(id));
  }

  // Collect all resolved message ids in env loop.
  const localMetas = await processQueueInLock(env, isAlive);

  if (onCommit) {
    await maybeAwait(onCommit(id));
  }
  return localMetas;
}

async function processQueueInLock<T>(
  env: ActorSingleOptions<T>,
  isAlive: () => boolean,
): Promise<AwaiterMeta[]> {
  const { queue, id, logger = nullLogger } = env;

  logger.debug("process queue in single mode", { actorId: id });

  // Process messages as possible as it can while alive.
  const messageMetas: AwaiterMeta[] = [];
  const notifyPromises: Promise<void>[] = [];
  while (isAlive() && (await queue.size(id)) > 0) {
    // Step 1. Peek a message from the queue to process it.
    const message = await queue.peek<UserMessage<T>>(id);
    logger.debug("get message", { actorId: id, messageId: message?.messageId });

    // Step 1-1. We should stop to process when the queue is broken.
    if (!message) {
      logger.debug("invalid message", { actorId: id });
      break;
    }

    // Step 2. Process a message by its type.
    await processMessage(env, message);
    // Copy only meta to reduce memory consumption.
    messageMetas.push(copyAwaiterMeta(message));

    // Step 3. Notify completions to awaiters.
    if (message.awaitPolicy === AwaitPolicy.Act) {
      notifyPromises.push(notifyCompletion(env, message));
    }

    // Step 4. Delete a message from the queue.
    // It will help to preserve the order of messages from broken handlers.
    await queue.pop(id);
    logger.debug("delete message", { actorId: id });
  }

  await Promise.all(notifyPromises);
  return messageMetas;
}

async function processMessage<T>(
  env: ActorSingleOptions<T>,
  message: UserMessage<T>,
): Promise<void> {
  const { id, logger = nullLogger, onMessage, onError } = env;
  try {
    logger.debug("process user message", {
      actorId: id,
      messageId: message.messageId,
    });
    await maybeAwait(onMessage(message.item));
  } catch (error) {
    logger.error("process user message error", {
      actorId: id,
      messageId: message.messageId,
      error,
    });
    if (onError) {
      await maybeAwait(onError(error as Error));
    }
  }
}

async function processInBulkMode<T>(
  env: ActorBulkOptions<T>,
  isAlive: () => boolean,
): Promise<AwaiterMeta[]> {
  const { queue, id, logger = nullLogger, onMessages, onError } = env;
  logger.debug("process queue in bulk mode", { actorId: id });

  // Process messages as possible as it can while alive.
  const messageMetas: AwaiterMeta[] = [];
  while (isAlive()) {
    const messages: UserMessage<T>[] = await queue.flush(id);
    logger.debug("get messages", { actorId: id, count: messages.length });
    if (messages.length === 0) {
      break;
    }

    // Step 2. Process messages.
    try {
      logger.debug("process messages", { actorId: id, count: messages.length });
      await maybeAwait(onMessages(messages.map((message) => message.item)));
    } catch (error) {
      logger.error("process messages error", {
        actorId: id,
        count: messages.length,
        error,
      });
      if (onError) {
        await maybeAwait(onError(error as Error));
      }
    }

    // Copy only meta to reduce memory consumption.
    for (const message of messages) {
      messageMetas.push(copyAwaiterMeta(message));
    }

    // Step 3. Notify completions to awaiters without blocking the loop.
    // `notifyCompletions` swallows its own errors, so this cannot reject.
    void notifyCompletions(
      env,
      messageMetas.filter((meta) => meta.awaitPolicy === AwaitPolicy.Act),
    );
  }
  return messageMetas;
}

async function maybeAwait(result: unknown): Promise<void> {
  await result;
}

function copyAwaiterMeta(input: AwaiterMeta): AwaiterMeta {
  return {
    messageId: input.messageId,
    awaitPolicy: input.awaitPolicy,
    awaitTimeoutMillis: input.awaitTimeoutMillis,
  };
}

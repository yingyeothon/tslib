import type { AwaiterResolve } from "./awaiter.js";
import { notifyCompletion, notifyCompletions } from "./awaiting.js";
import type {
  ActorErrorHandler,
  ActorLogger,
  ActorMessageBulkConsumer,
  ActorProperty,
  ActorSingleMessageHandler,
} from "./environment.js";
import type { LockAcquire, LockRelease } from "./lock.js";
import { noopLogger } from "./logger.js";
import type { AwaiterMeta, UserMessage } from "./message.js";
import { AwaitPolicy } from "./message.js";
import type {
  QueueBulkConsumer,
  QueueLength,
  QueueSingleConsumer,
} from "./queue.js";
import type { ActorShift } from "./shift.js";

export interface ActorProcessOptions {
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
}

export type ActorSingleEnv<T> = ActorProperty &
  ActorLogger & { queue: QueueSingleConsumer & QueueLength } & {
    awaiter: AwaiterResolve;
  } & ActorSingleMessageHandler<T> &
  ActorErrorHandler;

export type ActorBulkEnv<T> = ActorProperty &
  ActorLogger & { queue: QueueBulkConsumer & QueueLength } & {
    awaiter: AwaiterResolve;
  } & ActorMessageBulkConsumer<T> &
  ActorErrorHandler;

export type ActorLoopEnvironment<T> = (ActorSingleEnv<T> | ActorBulkEnv<T>) & {
  lock: LockAcquire & LockRelease;
};

export type ActorProcessEnvironment<T> = ActorLoopEnvironment<T> & {
  shift?: ActorShift;
};

/**
 * Try to acquire this actor's lock and process its queued messages.
 * Returns the metadata of every message processed by this call.
 */
export async function tryToProcess<T>(
  env: ActorProcessEnvironment<T>,
  { oneShot, aliveMillis, shiftable }: ActorProcessOptions = {},
): Promise<AwaiterMeta[]> {
  const { logger = noopLogger, id, shift } = env;
  const maybeOneShot = oneShot === undefined && aliveMillis === undefined;

  const startMillis = Date.now();
  const isAlive = () =>
    aliveMillis && aliveMillis > 0
      ? Date.now() - startMillis < aliveMillis
      : true;

  const metas: AwaiterMeta[] = [];
  while (isAlive()) {
    const localMetas = await processLoop(env, isAlive);
    metas.push(...localMetas);

    // Shift to new actor when a container has been timeout.
    if (!isAlive() && shiftable) {
      logger.debug("actor", "shift-timeout", id);
      if (shift) {
        await maybeAwait(shift(id));
      }
      break;
    }

    if (oneShot || maybeOneShot) {
      break;
    }
  }
  return metas;
}

async function processLoop<T>(
  env: ActorLoopEnvironment<T>,
  isAlive: () => boolean,
): Promise<AwaiterMeta[]> {
  const { id, queue, lock, logger = noopLogger } = env;

  const messageMetas: AwaiterMeta[] = [];
  logger.debug("actor", "process-loop", id);
  while (isAlive()) {
    // Do nothing if cannot get the lock.
    logger.debug("actor", "try-to-lock", id);
    if (!(await lock.tryAcquire(id))) {
      logger.debug("actor", "cannot-lock", id);
      break;
    }

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

    // Whatever its reason, release the lock.
    logger.debug("actor", "release-lock", id);
    await lock.release(id);

    // Notify the end of process to awaiters.
    await notifyCompletions(
      env,
      messageMetas.filter((meta) => meta.awaitPolicy === AwaitPolicy.Commit),
    );

    // There is no messages in the queue after unlocked,
    // We can get off from it.
    if ((await queue.size(id)) === 0) {
      logger.debug("actor", "empty-queue", id);
      break;
    }

    // Otherwise, we must keep go on
    // because there is another message and it is alive.
  }
  return messageMetas;
}

async function processInSingleMode<T>(
  env: ActorSingleEnv<T>,
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
  env: ActorSingleEnv<T>,
  isAlive: () => boolean,
): Promise<AwaiterMeta[]> {
  const { queue, id, logger = noopLogger } = env;

  logger.debug("actor", "process-queue-in-single", id);

  // Process messages as possible as it can while alive.
  const messageMetas: AwaiterMeta[] = [];
  const notifyPromises: Promise<void>[] = [];
  while (isAlive() && (await queue.size(id)) > 0) {
    // Step 1. Peek a message from the queue to process it.
    const message = await queue.peek<UserMessage<T>>(id);
    logger.debug("actor", "get-message", id, message);

    // Step 1-1. We should stop to process when the queue is broken.
    if (!message) {
      logger.debug("actor", "invalid-message", id, message);
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
    logger.debug("actor", "delete-message", id);
  }

  await Promise.all(notifyPromises);
  return messageMetas;
}

async function processMessage<T>(
  env: ActorSingleEnv<T>,
  message: UserMessage<T>,
): Promise<void> {
  const { id, logger = noopLogger, onMessage, onError } = env;
  try {
    logger.debug("actor", "process-user-message", id, message);
    await maybeAwait(onMessage(message.item));
  } catch (error) {
    logger.error("actor", "process-user-message-error", id, message, error);
    if (onError) {
      await maybeAwait(onError(error as Error));
    }
  }
}

async function processInBulkMode<T>(
  env: ActorBulkEnv<T>,
  isAlive: () => boolean,
): Promise<AwaiterMeta[]> {
  const { queue, id, logger = noopLogger, onMessages, onError } = env;
  logger.debug("actor", "process-queue-in-bulk", id);

  // Process messages as possible as it can while alive.
  const messageMetas: AwaiterMeta[] = [];
  while (isAlive()) {
    const messages: UserMessage<T>[] = await queue.flush(id);
    logger.debug("actor", "get-messages", id, messages.length);
    if (messages.length === 0) {
      break;
    }

    // Step 2. Process messages.
    try {
      logger.debug("actor", "process-messages", id, messages);
      await maybeAwait(onMessages(messages.map((message) => message.item)));
    } catch (error) {
      logger.error("actor", "process-messages-error", id, messages, error);
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

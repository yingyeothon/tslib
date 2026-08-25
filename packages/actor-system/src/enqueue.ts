import { randomUUID } from "node:crypto";
import { nullLogger } from "@yingyeothon/logger";
import type { ActorLogger, ActorProperty } from "./environment.js";
import type {
  UserMessage,
  UserMessageItem,
  UserMessageMeta,
} from "./message.js";
import { AwaitPolicy } from "./message.js";
import type { QueueProducer } from "./queue.js";

export type ActorEnqueueOptions = ActorProperty &
  ActorLogger & { queue: QueueProducer };

/** The message that was queued, plus the queue's depth after the push. */
export interface EnqueuedMessage<T> extends UserMessage<T> {
  queueDepth: number;
}

/**
 * Append a message to this actor's queue without processing it.
 * Missing metadata is filled in: a random `messageId`, `AwaitPolicy.Forget`,
 * and an `awaitTimeoutMillis` of 0.
 */
export async function enqueue<T>(
  env: ActorEnqueueOptions,
  input: UserMessageItem<T> & Partial<UserMessageMeta>,
): Promise<EnqueuedMessage<T>> {
  const { id, queue, logger = nullLogger } = env;
  const message: UserMessage<T> = {
    messageId: input.messageId || randomUUID(),
    awaitPolicy: input.awaitPolicy || AwaitPolicy.Forget,
    item: input.item,
    awaitTimeoutMillis: input.awaitTimeoutMillis || 0,
  };

  const queueDepth = await queue.push(id, message);
  // The item is the game's own payload; log what routed it, not what it says.
  logger.debug("enqueue message", {
    actorId: id,
    messageId: message.messageId,
    awaitPolicy: message.awaitPolicy,
    queueDepth,
  });
  return { ...message, queueDepth };
}

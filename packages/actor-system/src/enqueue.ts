import { randomUUID } from "node:crypto";
import type { ActorLogger, ActorProperty } from "./environment.js";
import { noopLogger } from "./logger.js";
import type {
  UserMessage,
  UserMessageItem,
  UserMessageMeta,
} from "./message.js";
import { AwaitPolicy } from "./message.js";
import type { QueueProducer } from "./queue.js";

export type ActorEnqueueEnvironment = ActorProperty &
  ActorLogger & { queue: QueueProducer };

/**
 * Append a message to this actor's queue without processing it.
 * Missing metadata is filled in: a random `messageId`, `AwaitPolicy.Forget`,
 * and an `awaitTimeoutMillis` of 0.
 */
export async function enqueue<T>(
  env: ActorEnqueueEnvironment,
  input: UserMessageItem<T> & Partial<UserMessageMeta>,
): Promise<UserMessage<T>> {
  const { id, queue, logger = noopLogger } = env;
  const message: UserMessage<T> = {
    messageId: input.messageId || randomUUID(),
    awaitPolicy: input.awaitPolicy || AwaitPolicy.Forget,
    item: input.item,
    awaitTimeoutMillis: input.awaitTimeoutMillis || 0,
  };

  await queue.push(id, message);
  logger.debug("actor", "enqueue", id, message);
  return message;
}

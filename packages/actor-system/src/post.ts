import type { AwaiterWait } from "./awaiter.js";
import { awaitMessage } from "./awaiting.js";
import type { ActorEnqueueOptions } from "./enqueue.js";
import { enqueue } from "./enqueue.js";
import type { UserMessageItem, UserMessageMeta } from "./message.js";
import { AwaitPolicy } from "./message.js";

export type ActorPostOptions = ActorEnqueueOptions & {
  awaiter: AwaiterWait;
};

/**
 * Send a message to this `Actor`, just like the `send` function, but it does not process the message.
 * This can be used for average response time if there is already a dedicated thread handling messages in this actor.
 *
 * If there is no thread for this actor, any messages will not be processed, so there must be a thread that performs `tryToProcess`
 * with `aliveMillis` and no `oneShot`.
 */
export async function post<T>(
  env: ActorPostOptions,
  input: UserMessageItem<T> & Partial<UserMessageMeta>,
): Promise<boolean> {
  const message = await enqueue(env, input);
  if (message.awaitPolicy === AwaitPolicy.Forget) {
    return true;
  }

  return awaitMessage(env, message.messageId, message.awaitTimeoutMillis);
}

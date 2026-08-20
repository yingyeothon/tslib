import type { AwaiterWait } from "./awaiter.js";
import { awaitMessageAfterTryToProcess } from "./awaiting.js";
import type { ActorEnqueueOptions } from "./enqueue.js";
import { enqueue } from "./enqueue.js";
import type { UserMessageItem, UserMessageMeta } from "./message.js";
import type { ActorProcessOptions, TryToProcessOptions } from "./process.js";
import { tryToProcess } from "./process.js";

export type ActorSendOptions<T> = ActorEnqueueOptions &
  ActorProcessOptions<T> & { awaiter: AwaiterWait };

/**
 * Send a message to this `Actor` and try to process that message with `TryToProcessOptions`.
 * If there is another thread dedicated to this actor, `AwaitPolicy` determines when the function completes.
 *
 * Of course, it will handle messages from other threads if this thread takes an `Actor`.
 * In this case the function elapsed may be longer than we expect, so we need to set `TryToProcessOptions` properly.
 */
export async function send<T>(
  env: ActorSendOptions<T>,
  input: UserMessageItem<T> & Partial<UserMessageMeta>,
  options: TryToProcessOptions = {},
): Promise<boolean> {
  const message = await enqueue(env, input);
  return awaitMessageAfterTryToProcess(env, message, () =>
    tryToProcess(env, options),
  );
}

import type { AwaiterWait } from "./awaiter.js";
import { awaitMessageAfterTryToProcess } from "./awaiting.js";
import type { ActorEnqueueEnvironment } from "./enqueue.js";
import { enqueue } from "./enqueue.js";
import type { UserMessageItem, UserMessageMeta } from "./message.js";
import type {
  ActorProcessEnvironment,
  ActorProcessOptions,
} from "./process.js";
import { tryToProcess } from "./process.js";

export type ActorSendEnvironment<T> = ActorEnqueueEnvironment &
  ActorProcessEnvironment<T> & { awaiter: AwaiterWait };

/**
 * Send a message to this `Actor` and try to process that message with `ActorProcessOptions`.
 * If there is another thread dedicated to this actor, `AwaitPolicy` determines when the function completes.
 *
 * Of course, it will handle messages from other threads if this thread takes an `Actor`.
 * In this case the function elapsed may be longer than we expect, so we need to set `ActorProcessOptions` properly.
 */
export async function send<T>(
  env: ActorSendEnvironment<T>,
  input: UserMessageItem<T> & Partial<UserMessageMeta>,
  options: ActorProcessOptions = {},
): Promise<boolean> {
  const message = await enqueue(env, input);
  return awaitMessageAfterTryToProcess(env, message, () =>
    tryToProcess(env, options),
  );
}

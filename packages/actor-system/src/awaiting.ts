import type { AwaiterResolve, AwaiterWait } from "./awaiter.js";
import type { ActorLogger, ActorProperty } from "./environment.js";
import { noopLogger } from "./logger.js";
import type { AwaiterMeta } from "./message.js";
import { AwaitPolicy } from "./message.js";

type AwaitEnvironment = ActorProperty & ActorLogger & { awaiter: AwaiterWait };
type ResolveEnvironment = ActorProperty &
  ActorLogger & { awaiter: AwaiterResolve };

export async function awaitMessage(
  env: AwaitEnvironment,
  messageId: string,
  awaitTimeoutMillis: number,
): Promise<boolean> {
  const { id, awaiter, logger = noopLogger } = env;
  logger.debug("actor", "await-message", id, messageId, awaitTimeoutMillis);
  return awaiter.wait(id, messageId, awaitTimeoutMillis);
}

export async function awaitMessageAfterTryToProcess(
  env: AwaitEnvironment,
  currentMeta: AwaiterMeta,
  tryToProcess: () => Promise<AwaiterMeta[]>,
): Promise<boolean> {
  // Try to process and collect resolved message ids.
  const resolvedMetas = await tryToProcess();

  // If we don't want to await this request, just return true.
  if (currentMeta.awaitPolicy === AwaitPolicy.Forget) {
    return true;
  }

  // Or, it processed in this thread luckily. Then return true.
  if (resolvedMetas.some((meta) => meta.messageId === currentMeta.messageId)) {
    return true;
  }

  // Or, other thread would process it as soon as possible.
  // We will wait until then.
  return awaitMessage(
    env,
    currentMeta.messageId,
    currentMeta.awaitTimeoutMillis,
  );
}

export async function notifyCompletion(
  env: ResolveEnvironment,
  meta: AwaiterMeta,
): Promise<void> {
  const { id, logger = noopLogger, awaiter } = env;
  try {
    logger.debug("actor", "awaiter-resolve", id, meta.messageId);
    await awaiter.resolve(id, meta.messageId);
  } catch (error) {
    logger.error("actor", "awaiter-resolve-error", id, error);
  }
}

export async function notifyCompletions(
  env: ResolveEnvironment,
  metas: AwaiterMeta[],
): Promise<void> {
  const { id, logger = noopLogger, awaiter } = env;
  try {
    const targetIds = metas.map(({ messageId }) => messageId);
    logger.debug("actor", "awaiter-resolve", id, targetIds);
    if (targetIds.length === 0) {
      return;
    }

    await Promise.all(
      targetIds.map((messageId) => awaiter.resolve(id, messageId)),
    );
  } catch (error) {
    logger.error("actor", "awaiter-resolve-error", id, error);
  }
}

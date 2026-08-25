import type { Logger } from "@yingyeothon/logger";
import type { LockRenew } from "./lock.js";

export interface LockHeartbeatOptions {
  actorId: string;
  lock: Partial<LockRenew>;
  /** Unset or non-positive disables the heartbeat. */
  intervalMillis: number | undefined;
  logger: Logger;
  /** Called once, when the lease is confirmed gone. */
  onLost: () => void;
}

/**
 * Extends a lock's lease on an interval while work runs, and reports the
 * one outcome that matters: the lease is gone and someone else owns the
 * actor now.
 *
 * Returns a stop function that must be called on every exit path.
 */
export function startLockHeartbeat({
  actorId,
  lock,
  intervalMillis,
  logger,
  onLost,
}: LockHeartbeatOptions): () => void {
  const renew = lock.renew;
  if (renew === undefined || intervalMillis === undefined) {
    return () => undefined;
  }
  if (intervalMillis <= 0) {
    logger.warn("actor lock will not be renewed", { actorId });
    return () => undefined;
  }

  let inFlight = false;
  let lost = false;
  const timer = setInterval(() => {
    // The socket underneath is a serialized queue, so a slow renew would
    // otherwise stack more renews ahead of the work being protected.
    if (inFlight || lost) {
      return;
    }
    inFlight = true;
    renew(actorId)
      .then((extended) => {
        if (extended) {
          return;
        }
        lost = true;
        logger.error("lost the actor lock", { actorId });
        onLost();
      })
      .catch((error: unknown) => {
        // A failed round trip is not proof of loss; the next beat retries
        // while the lease still has time on it.
        logger.error("cannot renew the actor lock", { actorId, error });
      })
      .finally(() => {
        inFlight = false;
      });
  }, intervalMillis);
  // A pending interval must not be what keeps a Lambda alive.
  timer.unref?.();

  return () => {
    clearInterval(timer);
  };
}

/** Warns about a lease that can be renewed but never will be. */
export function warnAboutMissingHeartbeat(
  actorId: string,
  lock: Partial<LockRenew>,
  intervalMillis: number | undefined,
  logger: Logger,
): void {
  if (lock.renew !== undefined && intervalMillis === undefined) {
    logger.warn("actor lock is held without a heartbeat", { actorId });
  }
}

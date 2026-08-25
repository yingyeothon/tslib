import type { Logger } from "@yingyeothon/logger";
import type { LockAcquire, LockRenew } from "./lock.js";

export interface LockHeartbeatOptions {
  actorId: string;
  lock: LockAcquire & Partial<LockRenew>;
  /** Unset or non-positive disables the heartbeat. */
  intervalMillis: number | undefined;
  logger: Logger;
  /** Called once, when the actor is confirmed to belong to someone else. */
  onLost: () => void;
}

/**
 * Extends a lock's lease on an interval while work runs, and reports the
 * one outcome that matters: this actor now belongs to someone else.
 *
 * An expired lease is not that outcome. The lease is a deadline for a
 * *successor*, not for the holder: it exists so that a crashed actor frees
 * its id quickly. A holder that is still working and merely lost contact
 * with the lock store — a failover, a node replacement, a network blip
 * longer than the lease — has taken nothing from anyone, so it re-acquires
 * and carries on. Only a re-acquisition that *fails* means another actor
 * has the game, and only then does the work stop.
 *
 * That is what lets the lease be short (seconds, so recovery is fast)
 * without making every outage longer than it fatal to a live session.
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
  const maybeRenew = lock.renew;
  if (maybeRenew === undefined || intervalMillis === undefined) {
    return () => undefined;
  }
  const renew = maybeRenew;
  if (intervalMillis <= 0) {
    logger.warn("actor lock will not be renewed", { actorId });
    return () => undefined;
  }

  let inFlight = false;
  let lost = false;
  const timer = setInterval(() => {
    // The store underneath is a serialized request queue, so a slow beat
    // would otherwise stack more beats ahead of the work being protected.
    if (inFlight || lost) {
      return;
    }
    inFlight = true;
    void beat().finally(() => {
      inFlight = false;
    });
  }, intervalMillis);
  // A pending interval must not be what keeps a Lambda alive.
  timer.unref?.();

  return () => {
    clearInterval(timer);
  };

  async function beat(): Promise<void> {
    try {
      if (await renew(actorId)) {
        return;
      }
      // The lease is gone. Whether that matters depends entirely on
      // whether anyone else claimed the actor in the meantime.
      if (await lock.tryAcquire(actorId)) {
        logger.warn("re-acquired the actor lock after its lease expired", {
          actorId,
        });
        return;
      }
      lost = true;
      logger.error("lost the actor lock", { actorId });
      onLost();
    } catch (error) {
      // A failed round trip is not proof of anything; the next beat tries
      // again, and the lease still has time on it more often than not.
      logger.error("cannot renew the actor lock", { actorId, error });
    }
  }
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

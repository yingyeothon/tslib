/** Tries to acquire an exclusive per-actor lock without blocking. */
export interface LockAcquire {
  tryAcquire: (actorId: string) => Promise<boolean>;
}

/** Releases a previously acquired per-actor lock. */
export interface LockRelease {
  release: (actorId: string) => Promise<boolean>;
}

/**
 * Extends the lease of a lock this caller still owns. Returns false when it
 * does not — the lease expired and someone else took it — which means the
 * work being protected is no longer exclusive.
 */
export interface LockRenew {
  renew: (actorId: string) => Promise<boolean>;
}

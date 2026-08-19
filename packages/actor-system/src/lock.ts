/** Tries to acquire an exclusive per-actor lock without blocking. */
export interface LockAcquire {
  tryAcquire: (actorId: string) => Promise<boolean>;
}

/** Releases a previously acquired per-actor lock. */
export interface LockRelease {
  release: (actorId: string) => Promise<boolean>;
}

/** Waits until a message is resolved, or until the timeout elapses. */
export interface AwaiterWait {
  wait: (
    actorId: string,
    messageId: string,
    timeoutMillis: number,
  ) => Promise<boolean>;
}

/** Resolves a message so that its waiting counterpart completes. */
export interface AwaiterResolve {
  resolve: (actorId: string, messageId: string) => Promise<void>;
}

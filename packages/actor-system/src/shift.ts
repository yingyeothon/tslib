/**
 * Called when a processing container reaches the end of its lifetime while
 * messages may remain, giving the observer a chance to shift the work to a
 * fresh actor (for example, by re-invoking an AWS Lambda function).
 */
export type ActorShift = (actorId: string) => unknown;

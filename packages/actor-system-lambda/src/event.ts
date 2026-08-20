/**
 * The payload delivered to an actor-processing AWS Lambda invocation.
 * It carries only the actor id; the handler rebuilds the actor environment
 * from it via `newActorEnv`.
 */
export interface ActorLambdaEvent {
  actorId: string;
}

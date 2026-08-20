import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import type {
  ActorProcessOptions,
  ActorShift,
  TryToProcessOptions,
} from "@yingyeothon/actor-system";
import { tryToProcess } from "@yingyeothon/actor-system";
import type { Logger } from "@yingyeothon/logger";
import { nullLogger } from "@yingyeothon/logger";
import type { Handler } from "aws-lambda";
import type { ActorLambdaEvent } from "./event.js";
import type { Timeline } from "./time.js";
import { createTimeline } from "./time.js";

const defaultLambdaFunctionTimeoutMillis = 870 * 1000;

export interface ActorLambdaEventHandlerOptions<
  ActorMessage,
  LambdaPayload extends ActorLambdaEvent,
> {
  /** Build the actor options from the invocation payload. */
  newActorEnv: (event: LambdaPayload) => ActorProcessOptions<ActorMessage>;
  logger?: Logger;
  processOptions?: TryToProcessOptions;
  /**
   * The timeline that tracks the remaining invocation lifetime. The handler
   * resets it at the start of each invocation; pass your own timeline to
   * observe the remaining lifetime from user code. Defaults to a fresh
   * timeline private to this handler.
   */
  timeline?: Timeline;
}

/**
 * Create an AWS Lambda handler that processes an actor's queued messages.
 * It resets its timeline at the start of each invocation and, by default,
 * processes for the remaining lifetime as a shiftable one-shot.
 */
export function createActorLambdaEventHandler<
  ActorMessage,
  LambdaPayload extends ActorLambdaEvent = ActorLambdaEvent,
>({
  newActorEnv,
  logger: maybeLogger,
  processOptions,
  timeline = createTimeline(),
}: ActorLambdaEventHandlerOptions<ActorMessage, LambdaPayload>): Handler<
  LambdaPayload,
  void
> {
  return async function handleLambda(event: LambdaPayload): Promise<void> {
    timeline.reset(
      processOptions?.aliveMillis ?? defaultLambdaFunctionTimeoutMillis,
    );

    const env = newActorEnv(event);
    if (!env) {
      throw new Error(`No actor env [${JSON.stringify(event)}]`);
    }
    const logger = maybeLogger ?? env.logger ?? nullLogger;
    logger.debug("actor lambda event received", { processOptions, event });

    await tryToProcess(
      env,
      processOptions ?? {
        aliveMillis: timeline.remainMillis,
        oneShot: true,
        shiftable: true,
      },
    );

    logger.debug("end of actor lambda event", { processOptions, event });
  };
}

export interface LambdaShiftOptions<P> {
  /** The Lambda function to invoke asynchronously for the shift. */
  functionName: string;
  /** The function qualifier to invoke. Defaults to `$LATEST`. */
  functionVersion?: string;
  /** Build the invocation payload. Defaults to `{ actorId }`. */
  buildPayload?: (actorId: string) => P;
  /** The Lambda client to use. Defaults to a new `LambdaClient`. */
  client?: LambdaClient;
}

/**
 * Create an `ActorShift` that hands remaining work to a fresh invocation of
 * `functionName` via an asynchronous (`Event`) Lambda invocation.
 */
export function createLambdaShift<P = ActorLambdaEvent>({
  functionName,
  functionVersion,
  buildPayload = (actorId) => ({ actorId }) as unknown as P,
  client = new LambdaClient({}),
}: LambdaShiftOptions<P>): ActorShift {
  return (actorId) =>
    client.send(
      new InvokeCommand({
        FunctionName: functionName,
        InvocationType: "Event",
        Qualifier: functionVersion ?? "$LATEST",
        Payload: Buffer.from(JSON.stringify(buildPayload(actorId)), "utf-8"),
      }),
    );
}

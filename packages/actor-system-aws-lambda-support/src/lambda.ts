import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import type {
  ActorProcessEnvironment,
  ActorProcessOptions,
  ActorShift,
} from "@yingyeothon/actor-system";
import { tryToProcess } from "@yingyeothon/actor-system";
import type { LogWriter } from "@yingyeothon/logger";
import { nullLogger } from "@yingyeothon/logger";
import type { Handler } from "aws-lambda";
import type { ActorLambdaEvent } from "./event.js";
import { globalTimeline } from "./time.js";

const defaultLambdaFunctionTimeoutMillis = 870 * 1000;

export interface ActorLambdaHandlerArguments<
  ActorMessage,
  LambdaPayload extends ActorLambdaEvent,
> {
  /** Build the actor environment from the invocation payload. */
  newActorEnv: (event: LambdaPayload) => ActorProcessEnvironment<ActorMessage>;
  logger?: LogWriter;
  processOptions?: ActorProcessOptions;
}

/**
 * Create an AWS Lambda handler that processes an actor's queued messages.
 * It resets the `globalTimeline` at the start of each invocation and, by
 * default, processes for the remaining lifetime as a shiftable one-shot.
 */
export function handleActorLambdaEvent<
  ActorMessage,
  LambdaPayload extends ActorLambdaEvent = ActorLambdaEvent,
>({
  newActorEnv,
  logger: maybeLogger,
  processOptions,
}: ActorLambdaHandlerArguments<ActorMessage, LambdaPayload>): Handler<
  LambdaPayload,
  void
> {
  return async function handleLambda(event: LambdaPayload): Promise<void> {
    globalTimeline.reset(
      processOptions?.aliveMillis ?? defaultLambdaFunctionTimeoutMillis,
    );

    const env = newActorEnv(event);
    if (!env) {
      throw new Error(`No actor env [${JSON.stringify(event)}]`);
    }
    const logger = maybeLogger ?? env.logger ?? nullLogger;
    logger.debug("actor-lambda", "handle", processOptions, event);

    await tryToProcess(
      env,
      processOptions ?? {
        aliveMillis: globalTimeline.remainMillis,
        oneShot: true,
        shiftable: true,
      },
    );

    logger.debug("actor-lambda", "end-of-handle", processOptions, event);
  };
}

export interface ShiftToNextLambdaArguments<P> {
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
export function shiftToNextLambda<P = ActorLambdaEvent>({
  functionName,
  functionVersion,
  buildPayload = (actorId) => ({ actorId }) as unknown as P,
  client = new LambdaClient({}),
}: ShiftToNextLambdaArguments<P>): ActorShift {
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

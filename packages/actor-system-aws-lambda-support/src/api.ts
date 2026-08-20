import type {
  ActorProcessOptions,
  ActorSendEnvironment,
  AwaiterMeta,
} from "@yingyeothon/actor-system";
import { post, send } from "@yingyeothon/actor-system";
import type { LogWriter } from "@yingyeothon/logger";
import { nullLogger } from "@yingyeothon/logger";
import type { APIGatewayProxyEvent, APIGatewayProxyHandler } from "aws-lambda";

const defaultAPIProxyFunctionTimeoutMillis = 5 * 1000;

export interface ActorAPIEventHandlerArguments<T> {
  /** Build the actor environment for the API path being requested. */
  newActorEnv: (
    apiPath: string,
    event: APIGatewayProxyEvent,
  ) => ActorSendEnvironment<T>;
  /** Parse the request body into an actor message. Defaults to `JSON.parse`. */
  parseMessage?: (body: string) => T;
  logger?: LogWriter;
  /**
   * `send` enqueues the message and processes the queue in this invocation;
   * `post` only enqueues it, leaving processing to a dedicated worker.
   */
  policy:
    | {
        type: "send";
        messageMeta?: Partial<AwaiterMeta>;
        processOptions?: ActorProcessOptions;
      }
    | {
        type: "post";
        messageMeta?: AwaiterMeta;
      };
}

/**
 * Create an API Gateway proxy handler that forwards the request body to an
 * actor as a message, either processing it inline (`send`) or enqueueing it
 * for another processor (`post`). Responds `200 OK` on success.
 */
export function handleActorAPIEvent<T>({
  newActorEnv,
  parseMessage: maybeParseMessage,
  logger: maybeLogger,
  policy,
}: ActorAPIEventHandlerArguments<T>): APIGatewayProxyHandler {
  return async function handleAPIEvent(event) {
    const parseMessage =
      maybeParseMessage ?? ((body: string) => JSON.parse(body) as T);
    const rootLogger = maybeLogger ?? nullLogger;

    rootLogger.debug("actor-api-handler", "handle", event.path, event.body);
    const actorEnv = newActorEnv(event.path, event);
    if (!actorEnv) {
      rootLogger.error("actor-api-handler", "no-actor-env", event);
      throw new Error(`No actor env for [${event.path}]`);
    }

    const logger = maybeLogger ?? actorEnv.logger ?? nullLogger;
    if (!event.body) {
      logger.error("actor-api-handler", "no-actor-message", event);
      throw new Error(`No message body for [${event.path}]`);
    }

    const message = parseMessage(event.body);
    if (!message) {
      logger.error(
        "actor-api-handler",
        "invalid-message",
        actorEnv.id,
        event.path,
        event.body,
      );
      throw new Error(`Invalid message for actor[${actorEnv.id}]`);
    }

    logger.debug("actor-api-handler", "post-and-process", actorEnv.id, message);
    let processed: unknown;
    switch (policy.type) {
      case "send":
        processed = await send(
          actorEnv,
          { ...policy.messageMeta, item: message },
          prepareProcessOptions(policy.processOptions),
        );
        break;
      case "post":
        processed = await post(actorEnv, {
          ...policy.messageMeta,
          item: message,
        });
        break;
    }

    logger.debug("actor-api-handler", "end-of-handle", actorEnv.id, processed);
    return { statusCode: 200, body: "OK" };
  };
}

function prepareProcessOptions(
  options?: ActorProcessOptions,
): ActorProcessOptions {
  return {
    aliveMillis: options?.aliveMillis ?? defaultAPIProxyFunctionTimeoutMillis,
    oneShot: options?.oneShot ?? true,
    shiftable: options?.shiftable ?? true,
  };
}

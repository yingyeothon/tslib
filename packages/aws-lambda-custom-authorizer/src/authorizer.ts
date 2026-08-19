import { nullLogger, type Logger } from "@yingyeothon/logger";
import type {
  APIGatewayAuthorizerResult,
  APIGatewayTokenAuthorizerHandler,
} from "aws-lambda";
import { parseAuthorization } from "./parse.js";
import type { Authorized, Authorizer } from "./types.js";

const http401Error = "Unauthorized";

export interface AuthorizerArguments {
  authorize: Authorizer;
  onError?: (error: Error) => void;
  logger?: Logger;
}

function defaultErrorHandler(logger: Logger): (error: Error) => void {
  return (error) => {
    logger.error(error);
    throw new Error(http401Error);
  };
}

function asError(thrown: unknown): Error {
  return thrown instanceof Error ? thrown : new Error(String(thrown));
}

export function buildAuthorizer({
  authorize,
  onError: maybeOnError,
  logger = nullLogger,
}: AuthorizerArguments): APIGatewayTokenAuthorizerHandler {
  return async (event) => {
    let authorized: Authorized = { allow: false };

    // Step 1. Authorize.
    try {
      logger.debug(`authorizationToken`, event.authorizationToken);
      if (event.authorizationToken === undefined) {
        throw new Error(`No authorizationToken`);
      }

      const authorization = parseAuthorization(event.authorizationToken);
      logger.debug(`authorization`, authorization);

      authorized = await authorize(authorization);
      logger.debug(`authorized`, authorized);
    } catch (error) {
      const onError = maybeOnError ?? defaultErrorHandler(logger);
      onError(asError(error));
    }

    // Step 2. Build a policy to allow or deny.
    const policy: APIGatewayAuthorizerResult = {
      principalId: "user",
      policyDocument: {
        Version: "2012-10-17",
        Statement: [
          {
            Action: "execute-api:Invoke",
            Effect: authorized.allow ? "Allow" : "Deny",
            Resource: event.methodArn,
          },
        ],
      },
      context: authorized.context,
    };
    logger.debug(`policy`, policy);
    return policy;
  };
}

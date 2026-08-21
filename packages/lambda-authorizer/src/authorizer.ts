import { nullLogger, type Logger } from "@yingyeothon/logger";
import type { APIGatewayTokenAuthorizerHandler } from "aws-lambda";
import { authorizeRequest } from "./policy.js";
import type { Authorizer } from "./types.js";

export interface AuthorizerOptions {
  authorize: Authorizer;
  onError?: (error: Error) => void;
  logger?: Logger;
}

/**
 * Builds a TOKEN authorizer, which reads `event.authorizationToken`.
 *
 * API Gateway supports TOKEN authorizers on REST APIs only. A WebSocket
 * API accepts a REQUEST authorizer on `$connect` and nothing else, so use
 * {@link createRequestAuthorizer} there.
 */
export function createAuthorizer({
  authorize,
  onError,
  logger = nullLogger,
}: AuthorizerOptions): APIGatewayTokenAuthorizerHandler {
  return (event) =>
    authorizeRequest({
      rawAuthorization: event.authorizationToken,
      methodArn: event.methodArn,
      authorize,
      onError,
      logger,
    });
}

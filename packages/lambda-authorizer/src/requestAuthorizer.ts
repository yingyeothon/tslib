import { nullLogger, type Logger } from "@yingyeothon/logger";
import type { APIGatewayRequestAuthorizerHandler } from "aws-lambda";
import { authorizeRequest } from "./policy.js";
import {
  defaultAuthorizationSources,
  readAuthorization,
  type AuthorizationSource,
} from "./sources.js";
import type { Authorizer } from "./types.js";

export interface RequestAuthorizerOptions {
  authorize: Authorizer;
  /**
   * Where to look for the credential, in order. Defaults to an
   * `Authorization` header, then a `bearer`-marked WebSocket subprotocol.
   * Every entry must also be declared as an identity source on the API
   * Gateway authorizer, or API Gateway rejects the request before the
   * function runs.
   */
  sources?: readonly AuthorizationSource[];
  onError?: (error: Error) => void;
  logger?: Logger;
}

/**
 * Builds a REQUEST authorizer, which receives the whole request rather
 * than a single `authorizationToken`. This is the only Lambda authorizer
 * type a WebSocket API supports, and it can be attached to `$connect`
 * only; the context it returns stays with the connection and reaches
 * `$connect`, `$default`, and `$disconnect` as
 * `event.requestContext.authorizer`.
 *
 * Set the authorizer's result cache TTL to 0. `$connect` runs once per
 * connection, so caching buys nothing and lets an allow outlive the
 * credential's expiry.
 */
export function createRequestAuthorizer({
  authorize,
  sources = defaultAuthorizationSources,
  onError,
  logger = nullLogger,
}: RequestAuthorizerOptions): APIGatewayRequestAuthorizerHandler {
  return (event) =>
    authorizeRequest({
      rawAuthorization: readAuthorization(event, sources),
      methodArn: event.methodArn,
      authorize,
      onError,
      logger,
    });
}

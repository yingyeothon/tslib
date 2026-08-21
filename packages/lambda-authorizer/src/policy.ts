import { nullLogger, type Logger } from "@yingyeothon/logger";
import type { APIGatewayAuthorizerResult } from "aws-lambda";
import { parseAuthorization } from "./parse.js";
import type { Authorized, Authorizer } from "./types.js";

const http401Error = "Unauthorized";

function defaultErrorHandler(logger: Logger): (error: Error) => void {
  return (error) => {
    // Only the error's name: the message is produced by whatever threw —
    // a consumer's `login` callback may echo a query, and a JSON parse
    // failure names the input it choked on. `onError` receives the whole
    // error for callers that want more.
    logger.error("authorization failed", { name: error.name });
    throw new Error(http401Error);
  };
}

function asError(thrown: unknown): Error {
  return thrown instanceof Error ? thrown : new Error(String(thrown));
}

export interface AuthorizeRequestOptions {
  /** The raw `<scheme> <credential>` string, or `undefined` when absent. */
  rawAuthorization: string | undefined;
  /** The resource the generated policy allows or denies. */
  methodArn: string;
  authorize: Authorizer;
  onError?: (error: Error) => void;
  logger?: Logger;
}

/**
 * Parses the authorization, runs the caller's `authorize`, and builds the
 * IAM policy API Gateway expects. Shared by the TOKEN and REQUEST
 * authorizers so both fail, log, and deny identically.
 *
 * Nothing here logs the credential, the issued context, or the policy's
 * context: consumers plug in writers that persist logs indefinitely.
 */
export async function authorizeRequest({
  rawAuthorization,
  methodArn,
  authorize,
  onError: maybeOnError,
  logger = nullLogger,
}: AuthorizeRequestOptions): Promise<APIGatewayAuthorizerResult> {
  let authorized: Authorized = { allow: false };

  // Step 1. Authorize.
  try {
    // Never log the raw credential: presence is the only safe fact.
    logger.debug("authorization", {
      present: rawAuthorization !== undefined,
    });
    if (rawAuthorization === undefined) {
      throw new Error("No authorization");
    }

    const authorization = parseAuthorization(rawAuthorization);
    logger.debug("authorization parsed", { type: authorization.type });

    authorized = await authorize(authorization);
    logger.debug("authorized", { allow: authorized.allow });
  } catch (error) {
    const onError = maybeOnError ?? defaultErrorHandler(logger);
    onError(asError(error));
  }

  // Step 2. Build a policy to allow or deny.
  const effect = authorized.allow ? "Allow" : "Deny";
  logger.debug("policy", { effect, methodArn });
  return {
    principalId: authorized.principalId ?? "user",
    policyDocument: {
      Version: "2012-10-17",
      Statement: [
        {
          Action: "execute-api:Invoke",
          Effect: effect,
          Resource: methodArn,
        },
      ],
    },
    // A refused request gets no context: it would still reach
    // `$context.authorizer.*` and so a consumer's access logs.
    context: authorized.allow ? authorized.context : undefined,
  };
}

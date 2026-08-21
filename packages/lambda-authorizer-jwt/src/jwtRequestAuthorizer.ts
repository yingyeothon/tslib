import {
  createRequestAuthorizer,
  type AuthorizationSource,
} from "@yingyeothon/lambda-authorizer";
import { nullLogger, type Logger } from "@yingyeothon/logger";
import type { APIGatewayRequestAuthorizerHandler } from "aws-lambda";
import type { VerifyOptions } from "jsonwebtoken";
import {
  memberIdFromSubject,
  verifyBearer,
  type BuildAuthorizerContext,
} from "./verifyBearer.js";

export interface JwtRequestAuthorizerOptions {
  jwtSecret: string;
  /** Passed to `jsonwebtoken`; pin `issuer` and `audience` here. */
  verifyOptions?: Omit<VerifyOptions, "complete">;
  /**
   * Refuses a token with no `exp` claim. Defaults to `true`: a bearer
   * token that never expires cannot be timed out.
   */
  requireExpiry?: boolean;
  /**
   * Builds the policy context from a verified token's claims.
   * Defaults to {@link memberIdFromSubject}.
   */
  buildContext?: BuildAuthorizerContext;
  /**
   * Where to look for the token, in order. Defaults to an `Authorization`
   * header, then a `bearer`-marked WebSocket subprotocol.
   */
  sources?: readonly AuthorizationSource[];
  onError?: (error: Error) => void;
  logger?: Logger;
}

/**
 * A REQUEST authorizer that verifies a bearer JWT — the only Lambda
 * authorizer type a WebSocket API accepts, and only on `$connect`.
 *
 * It verifies and never issues: a WebSocket handshake has no response body
 * to hand a freshly minted token back through, so the login exchange stays
 * in `createJwtAuthorizer` behind a REST endpoint. `Basic` and unknown
 * schemes are denied.
 */
export function createJwtRequestAuthorizer({
  jwtSecret,
  verifyOptions,
  buildContext = memberIdFromSubject,
  requireExpiry = true,
  sources,
  onError,
  logger = nullLogger,
}: JwtRequestAuthorizerOptions): APIGatewayRequestAuthorizerHandler {
  return createRequestAuthorizer({
    authorize: (auth) => {
      if (auth.type !== "Bearer") {
        logger.debug("non-bearer scheme rejected", { type: auth.type });
        return Promise.resolve({ allow: false });
      }
      return Promise.resolve(
        verifyBearer({
          token: auth.token,
          jwtSecret,
          verifyOptions,
          buildContext,
          requireExpiry,
          logger,
        }),
      );
    },
    sources,
    onError,
    logger,
  });
}

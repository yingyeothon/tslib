import {
  createAuthorizer,
  type BasicCredential,
} from "@yingyeothon/lambda-authorizer";
import { nullLogger, type Logger } from "@yingyeothon/logger";
import type { APIGatewayTokenAuthorizerHandler } from "aws-lambda";
import jwt, { type SignOptions, type VerifyOptions } from "jsonwebtoken";
import {
  memberIdFromSubject,
  verifyBearer,
  type BuildAuthorizerContext,
} from "./verifyBearer.js";

export interface JwtAuthorizerOptions {
  jwtSecret: string;
  jwtExpiresIn?: SignOptions["expiresIn"];
  buildJWTPayload?: (credential: BasicCredential) => string | Buffer | object;
  /**
   * Builds the policy context from a verified token's claims.
   * Defaults to {@link memberIdFromSubject}.
   */
  buildContext?: BuildAuthorizerContext;
  /** Passed to `jsonwebtoken`; pin `issuer` and `audience` here. */
  verifyOptions?: Omit<VerifyOptions, "complete">;
  /**
   * Refuses a token with no `exp` claim. Defaults to `true`: a bearer
   * token that never expires cannot be timed out.
   */
  requireExpiry?: boolean;
  login: (credential: BasicCredential) => Promise<boolean>;
  logger?: Logger;
}

/**
 * A TOKEN authorizer for REST APIs: `Basic` exchanges a login for a freshly
 * signed JWT returned as the context value `token`, and `Bearer` verifies
 * a JWT and publishes its claims through `buildContext`.
 *
 * WebSocket APIs cannot use a TOKEN authorizer — use
 * `createJwtRequestAuthorizer` for `$connect`.
 */
export function createJwtAuthorizer({
  jwtSecret,
  jwtExpiresIn = "30m",
  buildJWTPayload = ({ id }) => ({ id }),
  buildContext = memberIdFromSubject,
  verifyOptions,
  requireExpiry = true,
  login,
  logger = nullLogger,
}: JwtAuthorizerOptions): APIGatewayTokenAuthorizerHandler {
  return createAuthorizer({
    authorize: async (auth) => {
      // Basic authentication: exchange a login for a token.
      if (auth.type === "Basic") {
        // Never log the credential, id included.
        logger.debug("basic login");
        if (!(await login(auth.credential))) {
          logger.debug("basic login rejected");
          return { allow: false };
        }
        const token = jwt.sign(buildJWTPayload(auth.credential), jwtSecret, {
          expiresIn: jwtExpiresIn,
        });
        logger.debug("basic login accepted");
        // The issued token is the point of this exchange: it is the only
        // way the caller receives it.
        return { allow: true, context: { token } };
      }

      // Token authentication.
      if (auth.type === "Bearer") {
        return verifyBearer({
          token: auth.token,
          jwtSecret,
          verifyOptions,
          buildContext,
          requireExpiry,
          logger,
        });
      }

      // Unknown protocol.
      logger.debug("unknown scheme rejected");
      return { allow: false };
    },
    logger,
  });
}

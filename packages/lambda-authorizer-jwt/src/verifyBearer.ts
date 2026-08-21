import type { Authorized } from "@yingyeothon/lambda-authorizer";
import type { Logger } from "@yingyeothon/logger";
import type { APIGatewayAuthorizerResultContext } from "aws-lambda";
import jwt, { type JwtPayload, type VerifyOptions } from "jsonwebtoken";

/**
 * Turns verified claims into the authorizer context handed to downstream
 * integrations. API Gateway only carries string, number, and boolean
 * values, so claims have to be flattened into the few fields the
 * integration actually needs.
 *
 * Returning an empty context refuses the token: an authorizer whose job is
 * to establish an identity must not allow a request when it established
 * none.
 */
export type BuildAuthorizerContext = (
  claims: JwtPayload,
) => APIGatewayAuthorizerResultContext;

/**
 * The default {@link BuildAuthorizerContext}: publishes the subject as
 * `memberId` and nothing else. `sub` is the standard claim;
 * `id` is what this package's own `buildJWTPayload` default issues.
 *
 * Deliberately narrow — a context is not a place to copy claims into,
 * because API Gateway can be configured to write `$context.authorizer.*`
 * into access logs.
 */
export const memberIdFromSubject: BuildAuthorizerContext = (claims) => {
  const candidates = [claims.sub, (claims as Record<string, unknown>)["id"]];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate !== "") {
      return { memberId: candidate };
    }
  }
  return {};
};

export interface VerifyBearerOptions {
  token: string;
  jwtSecret: string;
  /**
   * Passed to `jsonwebtoken`. Pin `issuer` and `audience` here: a valid
   * signature only proves the token was minted by a holder of the secret,
   * not that it was minted for this deployment.
   */
  verifyOptions?: Omit<VerifyOptions, "complete">;
  buildContext: BuildAuthorizerContext;
  /** Refuses a token with no `exp` claim. */
  requireExpiry: boolean;
  logger: Logger;
}

/**
 * Verifies a bearer JWT and builds the authorizer context from its claims.
 * Throws whatever `jsonwebtoken` throws for an invalid, expired, or
 * malformed token; the authorizer turns that into `Unauthorized` (401).
 */
export function verifyBearer({
  token,
  jwtSecret,
  verifyOptions,
  buildContext,
  requireExpiry,
  logger,
}: VerifyBearerOptions): Authorized {
  // Never log the raw token: it is a credential.
  logger.debug("bearer verifying");
  // `complete: true` makes `jsonwebtoken` return the
  // `{ header, payload, signature }` envelope, which would reach
  // `buildContext` in place of the claims and silently erase the identity.
  // `VerifyOptions` is typed to forbid it, but excess-property checking
  // only catches an object literal, so it is overridden here too.
  const verified: unknown = jwt.verify(token, jwtSecret, {
    ...verifyOptions,
    complete: false,
  });

  // `typeof x === "object"` alone admits `null` and arrays.
  if (
    typeof verified !== "object" ||
    verified === null ||
    Array.isArray(verified)
  ) {
    logger.debug("bearer rejected", { reason: "payload is not a claim set" });
    return { allow: false };
  }
  const claims = verified as JwtPayload;

  if (requireExpiry && claims.exp === undefined) {
    // A bearer token that never expires cannot be timed out, which makes
    // every "the allow cannot outlive the credential" guarantee vacuous.
    logger.debug("bearer rejected", { reason: "no expiry" });
    return { allow: false };
  }

  // Never log the claims: an issuer may put a name or an email in them.
  const context = buildContext(claims);
  if (Object.keys(context).length === 0) {
    logger.debug("bearer rejected", { reason: "no identity in claims" });
    return { allow: false };
  }

  logger.debug("bearer verified");
  const memberId = context["memberId"];
  return {
    allow: true,
    context,
    principalId: typeof memberId === "string" ? memberId : undefined,
  };
}

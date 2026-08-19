import {
  buildAuthorizer,
  type BasicCredential,
} from "@yingyeothon/aws-lambda-custom-authorizer";
import { nullLogger, type Logger } from "@yingyeothon/logger";
import type { APIGatewayTokenAuthorizerHandler } from "aws-lambda";
import jwt, { type SignOptions } from "jsonwebtoken";

export interface JWTAuthorizerArguments {
  jwtSecret: string;
  jwtExpiresIn?: SignOptions["expiresIn"];
  buildJWTPayload?: (credential: BasicCredential) => string | Buffer | object;
  login: (credential: BasicCredential) => Promise<boolean>;
  logger?: Logger;
}

export function buildJWTAuthorizer({
  jwtSecret,
  jwtExpiresIn = "30m",
  buildJWTPayload = ({ id }) => ({ id }),
  login,
  logger = nullLogger,
}: JWTAuthorizerArguments): APIGatewayTokenAuthorizerHandler {
  return buildAuthorizer({
    authorize: async (auth) => {
      // Basic authentication
      if (auth.type === "Basic") {
        logger.debug(`BasicAuth`, auth.credential.id);
        if (!(await login(auth.credential))) {
          logger.debug(`BasicAuth`, `Failed`, auth.credential.id);
          return { allow: false };
        }
        const token = jwt.sign(buildJWTPayload(auth.credential), jwtSecret, {
          expiresIn: jwtExpiresIn,
        });
        logger.debug(`BasicAuth`, `JWT issued`, token);
        return { allow: true, context: { token } };
      }

      // Token authentication
      if (auth.type === "Bearer") {
        logger.debug(`BearerAuth`, auth.token);
        const decoded = jwt.verify(auth.token, jwtSecret);

        if (!decoded) {
          logger.debug(`BearerAuth`, `Failed`, auth.token);
          return { allow: false };
        }
        logger.debug(`BearerAuth`, `Decoded`, decoded);
        return { allow: true, context: { token: auth.token } };
      }

      // Unknown protocol
      return { allow: false };
    },
    logger,
  });
}

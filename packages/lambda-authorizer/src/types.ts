import type { APIGatewayAuthorizerResultContext } from "aws-lambda";

export interface BasicCredential {
  id: string;
  password: string;
}

export interface BasicAuthorization {
  type: "Basic";
  credential: BasicCredential;
}

export interface BearerAuthorization {
  type: "Bearer";
  token: string;
}

export interface UnknownAuthorization {
  type: "Unknown";
  scheme: string;
  credential: string;
}

export type Authorization =
  BasicAuthorization | BearerAuthorization | UnknownAuthorization;

export interface Authorized {
  allow: boolean;
  context?: APIGatewayAuthorizerResultContext;
  /**
   * The caller's identity, surfaced as `$context.authorizer.principalId`.
   * Defaults to `"user"`, so an authorizer that can name its caller should
   * set this — otherwise every caller looks like the same one to any
   * integration that reads `principalId`.
   */
  principalId?: string;
}

export type Authorizer = (authorization: Authorization) => Promise<Authorized>;

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
}

export type Authorizer = (authorization: Authorization) => Promise<Authorized>;

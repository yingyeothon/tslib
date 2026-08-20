import { ApiGatewayManagementApiClient } from "@aws-sdk/client-apigatewaymanagementapi";
import { env } from "../env.js";

let sharedClient: ApiGatewayManagementApiClient | undefined;

/**
 * Returns the shared API Gateway management client used by `reply` and
 * `dropConnection`. It is created lazily from `WS_ENDPOINT` (or the
 * serverless-offline endpoint when `IS_OFFLINE` is set) and then reused.
 */
export function getApiGatewayManagementClient(): ApiGatewayManagementApiClient {
  sharedClient ??= new ApiGatewayManagementApiClient({
    endpoint: env.isOffline ? "http://localhost:3001" : env.webSocketEndpoint,
  });
  return sharedClient;
}

/**
 * Replaces the shared client, e.g. with a preconfigured or mocked one.
 * Passing `undefined` resets it so the next call recreates it from env.
 */
export function setApiGatewayManagementClient(
  client: ApiGatewayManagementApiClient | undefined,
): void {
  sharedClient = client;
}

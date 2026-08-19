import type {
  APIGatewayAuthorizerResult,
  APIGatewayAuthorizerResultContext,
  APIGatewayTokenAuthorizerHandler,
} from "aws-lambda";
import { describe, expect, it } from "vitest";
import { buildAuthorizer } from "../src/index.js";

function invoke(
  handler: APIGatewayTokenAuthorizerHandler,
  methodArn = "method-arn",
): Promise<APIGatewayAuthorizerResult> {
  return handler(
    { type: "TOKEN", authorizationToken: "whatever", methodArn },
    {} as never,
    () => undefined,
  ) as Promise<APIGatewayAuthorizerResult>;
}

function callAuthorizer(
  allow: boolean,
  context?: APIGatewayAuthorizerResultContext,
): Promise<APIGatewayAuthorizerResult> {
  return invoke(
    buildAuthorizer({ authorize: () => Promise.resolve({ allow, context }) }),
  );
}

describe("buildAuthorizer policy document", () => {
  it("builds an Allow policy when authorized", async () => {
    const policy = await callAuthorizer(true);
    expect(policy).toEqual({
      principalId: "user",
      policyDocument: {
        Version: "2012-10-17",
        Statement: [
          {
            Action: "execute-api:Invoke",
            Effect: "Allow",
            Resource: "method-arn",
          },
        ],
      },
      context: undefined,
    });
  });

  it("builds a Deny policy when not authorized", async () => {
    const policy = await callAuthorizer(false);
    expect(policy).toEqual({
      principalId: "user",
      policyDocument: {
        Version: "2012-10-17",
        Statement: [
          {
            Action: "execute-api:Invoke",
            Effect: "Deny",
            Resource: "method-arn",
          },
        ],
      },
      context: undefined,
    });
  });

  it("uses the event methodArn as the policy resource", async () => {
    const policy = await invoke(
      buildAuthorizer({
        authorize: () => Promise.resolve({ allow: true }),
      }),
      "arn:aws:execute-api:us-east-1:123456789012:api/dev/GET/hello",
    );
    expect(policy.policyDocument.Statement[0]).toMatchObject({
      Resource: "arn:aws:execute-api:us-east-1:123456789012:api/dev/GET/hello",
    });
  });

  it("passes the authorizer context through to the policy", async () => {
    const context = { token: "issued-token", count: 3, flag: true };
    const policy = await callAuthorizer(true, context);
    expect(policy.context).toEqual(context);
  });
});

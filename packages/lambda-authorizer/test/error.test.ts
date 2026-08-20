import type {
  APIGatewayAuthorizerResult,
  APIGatewayTokenAuthorizerEvent,
  APIGatewayTokenAuthorizerHandler,
} from "aws-lambda";
import { describe, expect, it, vi } from "vitest";
import { createAuthorizer } from "../src/index.js";
import type { Logger } from "@yingyeothon/logger";

function invoke(
  handler: APIGatewayTokenAuthorizerHandler,
  event?: Partial<APIGatewayTokenAuthorizerEvent>,
): Promise<APIGatewayAuthorizerResult> {
  return handler(
    {
      type: "TOKEN",
      authorizationToken: "whatever",
      methodArn: "method-arn",
      ...event,
    },
    {} as never,
    () => undefined,
  ) as Promise<APIGatewayAuthorizerResult>;
}

function callAuthorizer({
  allow,
  errorMessage,
}: {
  allow: "allow" | "deny" | "error";
  errorMessage?: string;
}): Promise<Error | null> {
  return new Promise((resolve) => {
    void invoke(
      createAuthorizer({
        authorize: () => {
          if (allow === "error") {
            return Promise.reject(new Error(errorMessage));
          }
          return Promise.resolve({ allow: allow === "allow" });
        },
        onError: resolve,
      }),
    ).then(() => resolve(null));
  });
}

describe("createAuthorizer error handling", () => {
  it("does not call onError when the authorizer succeeds", async () => {
    const shouldBeNull = await callAuthorizer({ allow: "allow" });
    expect(shouldBeNull).toBeNull();
  });

  it("calls onError with the error thrown by the authorizer", async () => {
    const errorMessage = "NotAllowed";
    const error = await callAuthorizer({ allow: "error", errorMessage });
    expect(error).toBeInstanceOf(Error);
    expect(error!.message).toEqual(errorMessage);
  });

  it("builds a Deny policy when a custom onError swallows the error", async () => {
    const onError = vi.fn();
    const policy = await invoke(
      createAuthorizer({
        authorize: () => Promise.reject(new Error("boom")),
        onError,
      }),
    );
    expect(onError).toHaveBeenCalledOnce();
    expect(policy.policyDocument.Statement[0]!.Effect).toEqual("Deny");
  });

  it("throws Unauthorized by default and logs the original error", async () => {
    const error = vi.fn();
    const logger: Logger = {
      severity: "error",
      debug: vi.fn(),
      info: vi.fn(),
      error,
    };
    const cause = new Error("bad credentials");
    await expect(
      invoke(
        createAuthorizer({
          authorize: () => Promise.reject(cause),
          logger,
        }),
      ),
    ).rejects.toThrow("Unauthorized");
    expect(error).toHaveBeenCalledWith(cause);
  });

  it("throws Unauthorized by default when the authorizationToken is missing", async () => {
    await expect(
      invoke(
        createAuthorizer({ authorize: () => Promise.resolve({ allow: true }) }),
        {
          authorizationToken: undefined as unknown as string,
        },
      ),
    ).rejects.toThrow("Unauthorized");
  });

  it("wraps non-Error thrown values before calling onError", async () => {
    const errors: Error[] = [];
    await invoke(
      createAuthorizer({
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
        authorize: () => Promise.reject("plain string failure"),
        onError: (error) => {
          errors.push(error);
        },
      }),
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(Error);
    expect(errors[0]!.message).toEqual("plain string failure");
  });
});

import type { Logger } from "@yingyeothon/logger";
import type {
  APIGatewayAuthorizerResult,
  APIGatewayRequestAuthorizerEvent,
  APIGatewayRequestAuthorizerHandler,
} from "aws-lambda";
import { describe, expect, it, vi } from "vitest";
import {
  createRequestAuthorizer,
  readAuthorization,
  type Authorization,
  type AuthorizationSource,
} from "../src/index.js";

function requestEvent(
  event: Partial<APIGatewayRequestAuthorizerEvent> = {},
): APIGatewayRequestAuthorizerEvent {
  return {
    type: "REQUEST",
    methodArn: "arn:aws:execute-api:us-east-1:1:api/dev/$connect",
    headers: {},
    queryStringParameters: null,
    requestContext: { routeKey: "$connect" },
    ...event,
  } as unknown as APIGatewayRequestAuthorizerEvent;
}

function invoke(
  handler: APIGatewayRequestAuthorizerHandler,
  event?: Partial<APIGatewayRequestAuthorizerEvent>,
): Promise<APIGatewayAuthorizerResult> {
  return handler(
    requestEvent(event),
    {} as never,
    () => undefined,
  ) as Promise<APIGatewayAuthorizerResult>;
}

function captureAuthorization(
  event: Partial<APIGatewayRequestAuthorizerEvent>,
  sources?: readonly AuthorizationSource[],
): Promise<Authorization> {
  return new Promise<Authorization>((resolve) => {
    void invoke(
      createRequestAuthorizer({
        authorize: (authorization) => {
          resolve(authorization);
          return Promise.resolve({ allow: true });
        },
        sources,
      }),
      event,
    );
  });
}

describe("createRequestAuthorizer identity sources", () => {
  it("reads an Authorization header case-insensitively", async () => {
    const authorization = await captureAuthorization({
      headers: { AuThOrIzAtIoN: "Bearer a.b.c" },
    });
    expect(authorization).toEqual({ type: "Bearer", token: "a.b.c" });
  });

  it("reads a bearer-marked WebSocket subprotocol", async () => {
    const authorization = await captureAuthorization({
      headers: { "Sec-WebSocket-Protocol": "bearer, a.b.c" },
    });
    expect(authorization).toEqual({ type: "Bearer", token: "a.b.c" });
  });

  it("matches the subprotocol marker case-insensitively", async () => {
    const authorization = await captureAuthorization({
      headers: { "sec-websocket-protocol": "Bearer,a.b.c" },
    });
    expect(authorization).toEqual({ type: "Bearer", token: "a.b.c" });
  });

  it("prefers the Authorization header over the subprotocol", async () => {
    const authorization = await captureAuthorization({
      headers: {
        Authorization: "Bearer from-header",
        "Sec-WebSocket-Protocol": "bearer, from-subprotocol",
      },
    });
    expect(authorization).toEqual({ type: "Bearer", token: "from-header" });
  });

  it("reads a query string parameter only when it is asked for", async () => {
    const event = { queryStringParameters: { token: "a.b.c" } };
    const authorization = await captureAuthorization(event, [
      { from: "queryString", name: "token" },
    ]);
    expect(authorization).toEqual({ type: "Bearer", token: "a.b.c" });

    const policy = await invoke(
      createRequestAuthorizer({
        authorize: () => Promise.resolve({ allow: true }),
      }),
      event,
    ).catch((error: Error) => error);
    // The default sources do not look at the query string at all.
    expect(policy).toBeInstanceOf(Error);
  });

  it("honors a custom header name", async () => {
    const authorization = await captureAuthorization(
      { headers: { "x-game-token": "Bearer a.b.c" } },
      [{ from: "header", name: "X-Game-Token" }],
    );
    expect(authorization).toEqual({ type: "Bearer", token: "a.b.c" });
  });

  it("honors a custom subprotocol marker", async () => {
    const authorization = await captureAuthorization(
      { headers: { "Sec-WebSocket-Protocol": "yyt.auth, a.b.c" } },
      [{ from: "subprotocol", name: "yyt.auth" }],
    );
    expect(authorization).toEqual({ type: "Bearer", token: "a.b.c" });
  });

  it("parses a Basic header through the same path", async () => {
    const encoded = Buffer.from("id:password", "utf-8").toString("base64");
    const authorization = await captureAuthorization({
      headers: { Authorization: `Basic ${encoded}` },
    });
    expect(authorization).toEqual({
      type: "Basic",
      credential: { id: "id", password: "password" },
    });
  });
});

describe("readAuthorization", () => {
  it("returns undefined when no source yields a value", () => {
    expect(readAuthorization(requestEvent())).toBeUndefined();
  });

  it("ignores an empty header value", () => {
    expect(
      readAuthorization(requestEvent({ headers: { Authorization: "" } })),
    ).toBeUndefined();
  });

  it("ignores a subprotocol list whose marker has no token after it", () => {
    expect(
      readAuthorization(
        requestEvent({ headers: { "Sec-WebSocket-Protocol": "bearer" } }),
      ),
    ).toBeUndefined();
  });

  it("keeps a token that contains no spaces intact after the marker", () => {
    expect(
      readAuthorization(
        requestEvent({
          headers: { "Sec-WebSocket-Protocol": "bearer , a.b.c , extra" },
        }),
      ),
    ).toEqual("Bearer a.b.c");
  });

  it("uses the first marker when it appears twice", () => {
    expect(
      readAuthorization(
        requestEvent({
          headers: {
            "Sec-WebSocket-Protocol": "bearer, first, bearer, second",
          },
        }),
      ),
    ).toEqual("Bearer first");
  });

  it("ignores a subprotocol list without the marker", () => {
    expect(
      readAuthorization(
        requestEvent({ headers: { "Sec-WebSocket-Protocol": "graphql-ws" } }),
      ),
    ).toBeUndefined();
  });

  it("ignores an empty query string value", () => {
    expect(
      readAuthorization(
        requestEvent({ queryStringParameters: { token: "" } }),
        [{ from: "queryString", name: "token" }],
      ),
    ).toBeUndefined();
  });

  it("falls through to the next source", () => {
    expect(
      readAuthorization(
        requestEvent({ queryStringParameters: { token: "a.b.c" } }),
        [{ from: "header" }, { from: "queryString", name: "token" }],
      ),
    ).toEqual("Bearer a.b.c");
  });
});

describe("createRequestAuthorizer policy", () => {
  it("builds an Allow policy on the event methodArn", async () => {
    const policy = await invoke(
      createRequestAuthorizer({
        authorize: () => Promise.resolve({ allow: true, context: { a: 1 } }),
      }),
      { headers: { Authorization: "Bearer a.b.c" } },
    );
    expect(policy.policyDocument.Statement[0]).toEqual({
      Action: "execute-api:Invoke",
      Effect: "Allow",
      Resource: "arn:aws:execute-api:us-east-1:1:api/dev/$connect",
    });
    expect(policy.context).toEqual({ a: 1 });
  });

  it("strips the context from a Deny even when authorize supplied one", async () => {
    const policy = await invoke(
      createRequestAuthorizer({
        authorize: () =>
          Promise.resolve({ allow: false, context: { why: "no-such-user" } }),
      }),
      { headers: { Authorization: "Bearer a.b.c" } },
    );
    expect(policy.policyDocument.Statement[0]!.Effect).toEqual("Deny");
    // A refused request still reaches $context.authorizer.* in access logs.
    expect(policy.context).toBeUndefined();
  });

  it('uses the principalId an authorizer names, defaulting to "user"', async () => {
    const named = await invoke(
      createRequestAuthorizer({
        authorize: () => Promise.resolve({ allow: true, principalId: "m1" }),
      }),
      { headers: { Authorization: "Bearer a.b.c" } },
    );
    expect(named.principalId).toEqual("m1");

    const unnamed = await invoke(
      createRequestAuthorizer({
        authorize: () => Promise.resolve({ allow: true }),
      }),
      { headers: { Authorization: "Bearer a.b.c" } },
    );
    expect(unnamed.principalId).toEqual("user");
  });

  it("throws Unauthorized when no credential is present", async () => {
    await expect(
      invoke(
        createRequestAuthorizer({
          authorize: () => Promise.resolve({ allow: true }),
        }),
      ),
    ).rejects.toThrow("Unauthorized");
  });

  it("hands a custom onError the failure and denies", async () => {
    const onError = vi.fn();
    const policy = await invoke(
      createRequestAuthorizer({
        authorize: () => Promise.reject(new Error("boom")),
        onError,
      }),
      { headers: { Authorization: "Bearer a.b.c" } },
    );
    expect(onError).toHaveBeenCalledOnce();
    expect(policy.policyDocument.Statement[0]!.Effect).toEqual("Deny");
  });
});

describe("createRequestAuthorizer logging", () => {
  it("never logs the credential or the issued context", async () => {
    const lines: unknown[][] = [];
    const capture = (...args: unknown[]): void => {
      lines.push(args);
    };
    const logger: Logger = {
      severity: "debug",
      debug: capture,
      info: capture,
      warn: capture,
      error: capture,
    };
    await invoke(
      createRequestAuthorizer({
        authorize: () =>
          Promise.resolve({ allow: true, context: { token: "issued-token" } }),
        logger,
      }),
      { headers: { Authorization: "Bearer super.secret.jwt" } },
    );
    const logged = JSON.stringify(lines);
    expect(logged).not.toContain("super.secret.jwt");
    expect(logged).not.toContain("issued-token");
    expect(logged).toContain("Bearer");
  });
});

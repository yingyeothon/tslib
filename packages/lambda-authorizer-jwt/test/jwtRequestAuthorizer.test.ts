import type { Logger } from "@yingyeothon/logger";
import type {
  APIGatewayAuthorizerResult,
  APIGatewayRequestAuthorizerEvent,
  APIGatewayRequestAuthorizerHandler,
} from "aws-lambda";
import jwt, { type VerifyOptions } from "jsonwebtoken";
import { describe, expect, it, vi } from "vitest";
import {
  createJwtRequestAuthorizer,
  memberIdFromSubject,
} from "../src/index.js";

const jwtSecret = "test-secret";

function invoke(
  handler: APIGatewayRequestAuthorizerHandler,
  event: Partial<APIGatewayRequestAuthorizerEvent> = {},
): Promise<APIGatewayAuthorizerResult> {
  return handler(
    {
      type: "REQUEST",
      methodArn: "arn:aws:execute-api:us-east-1:1:api/dev/$connect",
      headers: {},
      queryStringParameters: null,
      requestContext: { routeKey: "$connect" },
      ...event,
    } as unknown as APIGatewayRequestAuthorizerEvent,
    {} as never,
    () => undefined,
  ) as Promise<APIGatewayAuthorizerResult>;
}

function subprotocol(token: string): Partial<APIGatewayRequestAuthorizerEvent> {
  return { headers: { "Sec-WebSocket-Protocol": `bearer, ${token}` } };
}

describe("createJwtRequestAuthorizer", () => {
  it("allows a valid JWT sent as a WebSocket subprotocol", async () => {
    const token = jwt.sign({ sub: "m1" }, jwtSecret, { expiresIn: "60m" });
    const policy = await invoke(
      createJwtRequestAuthorizer({ jwtSecret }),
      subprotocol(token),
    );
    expect(policy.policyDocument.Statement[0]!.Effect).toEqual("Allow");
    expect(policy.context).toEqual({ memberId: "m1" });
  });

  it("never puts the raw token in the context", async () => {
    const token = jwt.sign({ sub: "m1" }, jwtSecret, { expiresIn: "60m" });
    const policy = await invoke(
      createJwtRequestAuthorizer({ jwtSecret }),
      subprotocol(token),
    );
    expect(JSON.stringify(policy.context)).not.toContain(token);
  });

  it("falls back to the legacy id claim for the member id", async () => {
    const token = jwt.sign({ id: "m2" }, jwtSecret, { expiresIn: "60m" });
    const policy = await invoke(
      createJwtRequestAuthorizer({ jwtSecret }),
      subprotocol(token),
    );
    expect(policy.context).toEqual({ memberId: "m2" });
  });

  it("publishes the member id as the principal, not the hardcoded default", async () => {
    const token = jwt.sign({ sub: "m1" }, jwtSecret, { expiresIn: "60m" });
    const policy = await invoke(
      createJwtRequestAuthorizer({ jwtSecret }),
      subprotocol(token),
    );
    expect(policy.principalId).toEqual("m1");
  });

  it("denies a correctly signed token that carries no subject claim", async () => {
    const token = jwt.sign({ role: "admin" }, jwtSecret, { expiresIn: "60m" });
    const policy = await invoke(
      createJwtRequestAuthorizer({ jwtSecret }),
      subprotocol(token),
    );
    // An allow with no identity gives the integration nothing to bind to.
    expect(policy.policyDocument.Statement[0]!.Effect).toEqual("Deny");
    expect(policy.context).toBeUndefined();
  });

  it("denies a token whose payload is a JSON array", async () => {
    // `typeof [] === "object"`, so a bare shape check would let this pass.
    const token = jwt.sign(JSON.stringify([1, 2, 3]), jwtSecret);
    const policy = await invoke(
      createJwtRequestAuthorizer({ jwtSecret, requireExpiry: false }),
      subprotocol(token),
    );
    expect(policy.policyDocument.Statement[0]!.Effect).toEqual("Deny");
  });

  it("denies a token that never expires", async () => {
    const token = jwt.sign({ sub: "m1" }, jwtSecret);
    const policy = await invoke(
      createJwtRequestAuthorizer({ jwtSecret }),
      subprotocol(token),
    );
    expect(policy.policyDocument.Statement[0]!.Effect).toEqual("Deny");
  });

  it("allows a token with no expiry only when asked to", async () => {
    const token = jwt.sign({ sub: "m1" }, jwtSecret);
    const policy = await invoke(
      createJwtRequestAuthorizer({ jwtSecret, requireExpiry: false }),
      subprotocol(token),
    );
    expect(policy.policyDocument.Statement[0]!.Effect).toEqual("Allow");
  });

  it("ignores a complete:true that slipped past excess-property checking", async () => {
    const token = jwt.sign({ sub: "m1" }, jwtSecret, { expiresIn: "60m" });
    // A variable, not a literal, so TypeScript does not reject the extra key.
    const smuggled = { complete: true } as Omit<VerifyOptions, "complete">;
    const policy = await invoke(
      createJwtRequestAuthorizer({ jwtSecret, verifyOptions: smuggled }),
      subprotocol(token),
    );
    // Without the override `buildContext` would receive the
    // { header, payload, signature } envelope and lose the subject.
    expect(policy.policyDocument.Statement[0]!.Effect).toEqual("Allow");
    expect(policy.context).toEqual({ memberId: "m1" });
  });

  it("honors a custom context builder", async () => {
    const token = jwt.sign({ sub: "m1", gameId: "game-1" }, jwtSecret, {
      expiresIn: "60m",
    });
    const policy = await invoke(
      createJwtRequestAuthorizer({
        jwtSecret,
        buildContext: (claims) => ({
          memberId: String(claims.sub),
          gameId: String(claims["gameId"]),
        }),
      }),
      subprotocol(token),
    );
    expect(policy.context).toEqual({ memberId: "m1", gameId: "game-1" });
  });

  it("rejects a token minted for another issuer", async () => {
    const token = jwt.sign({ sub: "m1" }, jwtSecret, {
      expiresIn: "60m",
      issuer: "lobby-b",
    });
    await expect(
      invoke(
        createJwtRequestAuthorizer({
          jwtSecret,
          verifyOptions: { issuer: "lobby-a" },
        }),
        subprotocol(token),
      ),
    ).rejects.toThrow("Unauthorized");
  });

  it("rejects a token minted for another audience", async () => {
    const token = jwt.sign({ sub: "m1" }, jwtSecret, {
      expiresIn: "60m",
      audience: "other-game",
    });
    await expect(
      invoke(
        createJwtRequestAuthorizer({
          jwtSecret,
          verifyOptions: { audience: "this-game" },
        }),
        subprotocol(token),
      ),
    ).rejects.toThrow("Unauthorized");
  });

  it("rejects an expired token", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
      const token = jwt.sign({ sub: "m1" }, jwtSecret, { expiresIn: "30m" });
      vi.setSystemTime(new Date("2026-01-01T01:00:00Z"));
      await expect(
        invoke(createJwtRequestAuthorizer({ jwtSecret }), subprotocol(token)),
      ).rejects.toThrow("Unauthorized");
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects a token signed with another secret", async () => {
    const token = jwt.sign({ sub: "m1" }, "wrong-secret", {
      expiresIn: "60m",
    });
    await expect(
      invoke(createJwtRequestAuthorizer({ jwtSecret }), subprotocol(token)),
    ).rejects.toThrow("Unauthorized");
  });

  it("throws Unauthorized when the handshake carries no token", async () => {
    await expect(
      invoke(createJwtRequestAuthorizer({ jwtSecret })),
    ).rejects.toThrow("Unauthorized");
  });

  it("denies a Basic credential: this authorizer verifies, never issues", async () => {
    const encoded = Buffer.from("id:password", "utf-8").toString("base64");
    const policy = await invoke(createJwtRequestAuthorizer({ jwtSecret }), {
      headers: { Authorization: `Basic ${encoded}` },
    });
    expect(policy.policyDocument.Statement[0]!.Effect).toEqual("Deny");
  });

  it("denies an unknown scheme", async () => {
    const policy = await invoke(createJwtRequestAuthorizer({ jwtSecret }), {
      headers: { Authorization: "Digest whatever" },
    });
    expect(policy.policyDocument.Statement[0]!.Effect).toEqual("Deny");
  });

  it("denies when the verified payload is not an object", async () => {
    const verify = vi
      .spyOn(jwt, "verify")
      .mockReturnValue("plain" as unknown as ReturnType<typeof jwt.verify>);
    try {
      const policy = await invoke(
        createJwtRequestAuthorizer({ jwtSecret }),
        subprotocol("whatever"),
      );
      expect(policy.policyDocument.Statement[0]!.Effect).toEqual("Deny");
      expect(policy.context).toBeUndefined();
    } finally {
      verify.mockRestore();
    }
  });

  it("reads a token from a query string when told to", async () => {
    const token = jwt.sign({ sub: "m1" }, jwtSecret, { expiresIn: "60m" });
    const policy = await invoke(
      createJwtRequestAuthorizer({
        jwtSecret,
        sources: [{ from: "queryString", name: "token" }],
      }),
      { queryStringParameters: { token } },
    );
    expect(policy.context).toEqual({ memberId: "m1" });
  });

  it("never logs the token or the claims", async () => {
    const token = jwt.sign({ sub: "m1", email: "one@yyt.life" }, jwtSecret, {
      expiresIn: "60m",
    });
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
      createJwtRequestAuthorizer({ jwtSecret, logger }),
      subprotocol(token),
    );
    const logged = JSON.stringify(lines);
    // Positive control: this would pass vacuously if nothing were logged.
    expect(logged).toContain("bearer verified");
    expect(logged).not.toContain(token);
    for (const segment of token.split(".")) {
      expect(logged).not.toContain(segment);
    }
    expect(logged).not.toContain("one@yyt.life");
  });
});

describe("memberIdFromSubject", () => {
  it("prefers sub over id", () => {
    expect(memberIdFromSubject({ sub: "a", id: "b" })).toEqual({
      memberId: "a",
    });
  });

  it("returns an empty context for a non-string subject", () => {
    expect(memberIdFromSubject({ sub: undefined, id: 42 })).toEqual({});
  });

  it("returns an empty context for an empty subject", () => {
    expect(memberIdFromSubject({ sub: "" })).toEqual({});
  });

  it("falls back to id when sub is an empty string", () => {
    expect(memberIdFromSubject({ sub: "", id: "m2" })).toEqual({
      memberId: "m2",
    });
  });

  it("returns an empty context for an object or array subject", () => {
    expect(memberIdFromSubject({ sub: { a: 1 } as unknown as string })).toEqual(
      {},
    );
    expect(memberIdFromSubject({ sub: ["a"] as unknown as string })).toEqual(
      {},
    );
  });
});

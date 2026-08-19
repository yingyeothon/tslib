import type {
  APIGatewayAuthorizerResult,
  APIGatewayTokenAuthorizerHandler,
} from "aws-lambda";
import jwt from "jsonwebtoken";
import { describe, expect, it, vi } from "vitest";
import { buildJWTAuthorizer } from "../src/index.js";

const jwtSecret = "test-secret";

function invoke(
  handler: APIGatewayTokenAuthorizerHandler,
  authorizationToken: string,
): Promise<APIGatewayAuthorizerResult> {
  return handler(
    { type: "TOKEN", authorizationToken, methodArn: "method-arn" },
    {} as never,
    () => undefined,
  ) as Promise<APIGatewayAuthorizerResult>;
}

function basicToken(id: string, password: string): string {
  return `Basic ${Buffer.from(`${id}:${password}`, "utf-8").toString("base64")}`;
}

function buildHandler(id = "test", password = "1234") {
  return buildJWTAuthorizer({
    jwtSecret,
    login: (credential) =>
      Promise.resolve(credential.id === id && credential.password === password),
  });
}

describe("Basic authentication", () => {
  it("allows a valid login and issues a JWT in the context", async () => {
    const policy = await invoke(buildHandler(), basicToken("test", "1234"));
    expect(policy.policyDocument.Statement[0]!.Effect).toEqual("Allow");
    expect(policy.context).toBeDefined();
    expect(policy.context!.token).toBeDefined();

    const decoded = jwt.verify(policy.context!.token as string, jwtSecret);
    expect(decoded).toMatchObject({ id: "test" });
    expect((decoded as jwt.JwtPayload).exp).toBeDefined();
  });

  it("denies an invalid login without a context", async () => {
    const policy = await invoke(buildHandler(), basicToken("test", "1111"));
    expect(policy.policyDocument.Statement[0]!.Effect).toEqual("Deny");
    expect(policy.context).toBeUndefined();
  });

  it("honors a custom payload builder and expiry", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
      const handler = buildJWTAuthorizer({
        jwtSecret,
        jwtExpiresIn: "1h",
        buildJWTPayload: ({ id }) => ({ id, role: "admin" }),
        login: () => Promise.resolve(true),
      });
      const policy = await invoke(handler, basicToken("test", "1234"));
      const decoded = jwt.verify(
        policy.context!.token as string,
        jwtSecret,
      ) as jwt.JwtPayload;
      expect(decoded).toMatchObject({ id: "test", role: "admin" });
      expect(decoded.exp! - decoded.iat!).toEqual(3600);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("Bearer authentication", () => {
  it("allows a valid JWT and echoes it in the context", async () => {
    const token = jwt.sign({ id: "test" }, jwtSecret, { expiresIn: "30m" });
    const policy = await invoke(buildHandler(), `Bearer ${token}`);
    expect(policy.policyDocument.Statement[0]!.Effect).toEqual("Allow");
    expect(policy.context).toEqual({ token });
  });

  it("rejects an expired JWT with Unauthorized", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
      const token = jwt.sign({ id: "test" }, jwtSecret, { expiresIn: "30m" });
      vi.setSystemTime(new Date("2026-01-01T01:00:00Z"));
      await expect(invoke(buildHandler(), `Bearer ${token}`)).rejects.toThrow(
        "Unauthorized",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects a JWT signed with a different secret with Unauthorized", async () => {
    const token = jwt.sign({ id: "test" }, "wrong-secret", {
      expiresIn: "30m",
    });
    await expect(invoke(buildHandler(), `Bearer ${token}`)).rejects.toThrow(
      "Unauthorized",
    );
  });

  it("rejects a JWT with a tampered payload with Unauthorized", async () => {
    const token = jwt.sign({ id: "test" }, jwtSecret, { expiresIn: "30m" });
    const [header, , signature] = token.split(".");
    const forgedPayload = Buffer.from(JSON.stringify({ id: "admin" }))
      .toString("base64url")
      .replace(/=+$/, "");
    const forged = `${header}.${forgedPayload}.${signature}`;
    await expect(invoke(buildHandler(), `Bearer ${forged}`)).rejects.toThrow(
      "Unauthorized",
    );
  });

  it("rejects a malformed token with Unauthorized", async () => {
    await expect(
      invoke(buildHandler(), "Bearer not-a-jwt-at-all"),
    ).rejects.toThrow("Unauthorized");
  });

  it("denies when the verified payload is falsy", async () => {
    const verify = vi
      .spyOn(jwt, "verify")
      .mockReturnValue("" as unknown as ReturnType<typeof jwt.verify>);
    try {
      const policy = await invoke(buildHandler(), "Bearer whatever");
      expect(policy.policyDocument.Statement[0]!.Effect).toEqual("Deny");
      expect(policy.context).toBeUndefined();
    } finally {
      verify.mockRestore();
    }
  });
});

describe("Unknown schemes", () => {
  it("denies an unknown authorization scheme", async () => {
    const policy = await invoke(buildHandler(), "Digest whatever");
    expect(policy.policyDocument.Statement[0]!.Effect).toEqual("Deny");
  });

  it("denies an authorization header without a scheme", async () => {
    const policy = await invoke(buildHandler(), "just-a-token");
    expect(policy.policyDocument.Statement[0]!.Effect).toEqual("Deny");
  });
});

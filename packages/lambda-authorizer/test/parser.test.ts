import type {
  APIGatewayAuthorizerResult,
  APIGatewayTokenAuthorizerEvent,
  APIGatewayTokenAuthorizerHandler,
} from "aws-lambda";
import { describe, expect, it } from "vitest";
import {
  createAuthorizer,
  parseAuthorization,
  type Authorization,
} from "../src/index.js";

function invoke(
  handler: APIGatewayTokenAuthorizerHandler,
  event: Partial<APIGatewayTokenAuthorizerEvent>,
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

function callAuthorizer(authorizationToken: string): Promise<Authorization> {
  return new Promise<Authorization>((resolve) => {
    void invoke(
      createAuthorizer({
        authorize: (authorization) => {
          resolve(authorization);
          return Promise.resolve({ allow: true });
        },
      }),
      { authorizationToken },
    );
  });
}

describe("createAuthorizer token parsing", () => {
  it("parses a Basic credential", async () => {
    const id = "test";
    const password = "1234";
    const authorization = await callAuthorizer(
      `Basic ${Buffer.from(`${id}:${password}`, "utf-8").toString("base64")}`,
    );
    expect(authorization).toEqual({
      type: "Basic",
      credential: { id, password },
    });
  });

  it("parses a Bearer token", async () => {
    const token = "something great";
    const authorization = await callAuthorizer(`Bearer ${token}`);
    expect(authorization).toEqual({ type: "Bearer", token });
  });

  it("keeps unknown schemes as-is", async () => {
    const data = "very complicated expression";
    const authorization = await callAuthorizer(`Digest ${data}`);
    expect(authorization).toEqual({
      type: "Unknown",
      scheme: "Digest",
      credential: data,
    });
  });
});

describe("parseAuthorization edge cases", () => {
  it("accepts a lowercase scheme, as RFC 7235 requires", () => {
    expect(parseAuthorization("bearer a.b.c")).toEqual({
      type: "Bearer",
      token: "a.b.c",
    });
    const encoded = Buffer.from("id:password", "utf-8").toString("base64");
    expect(parseAuthorization(`BASIC ${encoded}`)).toEqual({
      type: "Basic",
      credential: { id: "id", password: "password" },
    });
  });

  it("reports an unknown scheme with the spelling the client used", () => {
    expect(parseAuthorization("DiGeSt abc")).toEqual({
      type: "Unknown",
      scheme: "DiGeSt",
      credential: "abc",
    });
  });

  it("treats a token without a space as Unknown with empty parts", () => {
    expect(parseAuthorization("Bearer")).toEqual({
      type: "Unknown",
      scheme: "",
      credential: "",
    });
  });

  it("treats a token starting with a space as Unknown with empty parts", () => {
    expect(parseAuthorization(" Bearer abc")).toEqual({
      type: "Unknown",
      scheme: "",
      credential: "",
    });
  });

  it("treats an empty token as Unknown with empty parts", () => {
    expect(parseAuthorization("")).toEqual({
      type: "Unknown",
      scheme: "",
      credential: "",
    });
  });

  it("keeps a Bearer token that contains spaces intact after the first space", () => {
    expect(parseAuthorization("Bearer a b c")).toEqual({
      type: "Bearer",
      token: "a b c",
    });
  });

  it("returns empty id and password when a Basic credential has no colon", () => {
    const encoded = Buffer.from("no-colon-here", "utf-8").toString("base64");
    expect(parseAuthorization(`Basic ${encoded}`)).toEqual({
      type: "Basic",
      credential: { id: "", password: "" },
    });
  });

  it("returns empty id and password when a Basic credential starts with a colon", () => {
    const encoded = Buffer.from(":password-only", "utf-8").toString("base64");
    expect(parseAuthorization(`Basic ${encoded}`)).toEqual({
      type: "Basic",
      credential: { id: "", password: "" },
    });
  });

  it("splits a Basic credential only at the first colon", () => {
    const encoded = Buffer.from("id:pa:ss", "utf-8").toString("base64");
    expect(parseAuthorization(`Basic ${encoded}`)).toEqual({
      type: "Basic",
      credential: { id: "id", password: "pa:ss" },
    });
  });

  it("trims whitespace around a decoded Basic credential", () => {
    const encoded = Buffer.from("  id:password\n", "utf-8").toString("base64");
    expect(parseAuthorization(`Basic ${encoded}`)).toEqual({
      type: "Basic",
      credential: { id: "id", password: "password" },
    });
  });
});

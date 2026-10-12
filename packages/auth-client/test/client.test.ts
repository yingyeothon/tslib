import { describe, expect, it } from "vitest";
import {
  createAuthClient,
  createAuthNonce,
  isAuthClientError,
  readTokenClaims,
} from "../src/index.js";
import {
  fakeResponse,
  fakeToken,
} from "../../../test-support/game-kit-fakes.js";
const jwt = fakeToken("alice");
const baseUrl = "https://auth.invalid";
function client(
  status = 200,
  body: unknown = { jwt, userId: "alice", exp: 2000000000 },
) {
  return createAuthClient({
    baseUrl,
    channelId: "ch_test",
    fetch: () => Promise.resolve(fakeResponse(status, body)),
  });
}
describe("auth wire", () => {
  it("makes config, exchange and verify requests with safe headers", async () => {
    const requests: { url: string; request: unknown }[] = [];
    const c = createAuthClient({
      baseUrl,
      channelId: "ch_test",
      fetch: (url, request) => {
        requests.push({ url, request });
        return Promise.resolve(
          fakeResponse(
            200,
            url.endsWith("config")
              ? {
                  issuer: "issuer",
                  audience: "game",
                  providers: ["github"],
                  startUrl: "url",
                  redirectAllowlist: ["https://game.invalid"],
                  tokenTtlSec: 10,
                  expiresAt: 100,
                }
              : { jwt, userId: "alice", exp: 2000000000 },
          ),
        );
      },
    });
    expect((await c.fetchConfig()).providers).toEqual(["github"]);
    expect(
      await c.exchange({ provider: "github", accessToken: "provider-secret" }),
    ).toEqual({ jwt, userId: "alice", exp: 2000000000 });
    expect(
      await c.exchange({ provider: "google", idToken: "id-secret" }),
    ).toMatchObject({ userId: "alice" });
    expect(await c.verify(jwt)).toMatchObject({ jwt });
    expect(requests[1]).toMatchObject({
      url: `${baseUrl}/c/ch_test/token`,
      request: {
        method: "POST",
        body: '{"provider":"github","accessToken":"provider-secret"}',
      },
    });
    expect(requests[3]).toMatchObject({
      request: { headers: { authorization: `Bearer ${jwt}` } },
    });
    expect(await client(401).verify(jwt)).toBeUndefined();
  });
  it("builds a nonce-bearing URL and validates redirect identity, nonce and origin", () => {
    const c = client();
    const redirectUrl = "https://game.invalid/callback";
    const start = new URL(
      c.buildStartUrl({ provider: "github", redirectUrl, nonce: "abc" }),
    );
    expect(
      new URL(start.searchParams.get("redirect")!).searchParams.get("nonce"),
    ).toBe("abc");
    const returnedUrl = `${redirectUrl}?nonce=abc#token=${jwt}&userId=alice&exp=2000000000`;
    expect(
      c.parseRedirect({ returnedUrl, redirectUrl, expectedNonce: "abc" }),
    ).toMatchObject({ jwt, userId: "alice" });
    for (const bad of [
      returnedUrl.replace("game.invalid", "attacker.invalid"),
      returnedUrl.replace("callback", "wrong"),
      returnedUrl.replace("nonce=abc", "nonce=abd"),
      returnedUrl.replace("userId=alice", "userId=bob"),
      redirectUrl + "?nonce=abc",
      "bad-url",
    ])
      expect(() =>
        c.parseRedirect({
          returnedUrl: bad,
          redirectUrl,
          expectedNonce: "abc",
        }),
      ).toThrow();
    expect(() =>
      c.parseRedirect({ returnedUrl, redirectUrl, expectedNonce: "" }),
    ).toThrow();
    expect(() =>
      c.buildStartUrl({ provider: "", redirectUrl, nonce: "abc" }),
    ).toThrow(RangeError);
    expect(() =>
      c.buildStartUrl({ provider: "github", redirectUrl: "bad", nonce: "abc" }),
    ).toThrow(RangeError);
    expect(() =>
      c.buildStartUrl({
        provider: "github",
        redirectUrl: redirectUrl + "#secret",
        nonce: "abc",
      }),
    ).toThrow(RangeError);
  });
  it("generates secure nonces and reads claims without claiming signature validation", () => {
    expect(createAuthNonce()).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(createAuthNonce()).not.toBe(createAuthNonce());
    expect(readTokenClaims(jwt)).toMatchObject({ userId: "alice" });
    for (const bad of [
      "",
      "a.b.c",
      "a.$.c",
      `a.${Buffer.from("{}").toString("base64url")}.c`,
      `a.${Buffer.from("[1]").toString("base64url")}.c`,
      fakeToken("", 0),
    ])
      expect(() => readTokenClaims(bad)).toThrow(TypeError);
  });
  it("sanitizes malformed bodies, errors and credential failures", async () => {
    const lines: unknown[] = [];
    const write = (...args: unknown[]) => {
      lines.push(args);
    };
    const c = createAuthClient({
      baseUrl,
      channelId: "ch_test",
      logger: {
        severity: "debug",
        debug: write,
        info: write,
        warn: write,
        error: write,
      },
      fetch: () => Promise.resolve(fakeResponse(503, "PROVIDER-SECRET")),
    });
    await expect(c.verify(jwt)).rejects.toMatchObject({
      status: 503,
      code: "http_503",
    });
    expect(JSON.stringify(lines)).toContain("auth request");
    expect(JSON.stringify(lines)).not.toContain(jwt);
    expect(JSON.stringify(lines)).not.toContain("PROVIDER-SECRET");
    await expect(
      client(200, "SECRET-NOT-JSON").verify(jwt),
    ).rejects.toMatchObject({ code: "malformed_response" });
    await expect(client(200, {}).verify(jwt)).rejects.toMatchObject({
      code: "malformed_response",
    });
    await expect(client(200, []).fetchConfig()).rejects.toMatchObject({
      code: "malformed_response",
    });
    await expect(client(200, {}).fetchConfig()).rejects.toMatchObject({
      code: "malformed_response",
    });
    await expect(client().verify(jwt + "\n")).rejects.toThrow(TypeError);
    await expect(client().exchange({ provider: "github" })).rejects.toThrow(
      TypeError,
    );
    await expect(
      client().exchange({ provider: "github", accessToken: "a", idToken: "b" }),
    ).rejects.toThrow(TypeError);
    const failed = createAuthClient({
      baseUrl,
      channelId: "ch",
      fetch: () => Promise.reject(new Error("secret")),
    });
    await expect(failed.fetchConfig()).rejects.toMatchObject({
      code: "network",
      status: 0,
    });
    expect(isAuthClientError(null)).toBe(false);
    try {
      await failed.fetchConfig();
    } catch (error) {
      expect(isAuthClientError(error)).toBe(true);
    }
    for (const url of [
      "bad",
      "ftp://a",
      "https://u:p@a",
      "https://a?q=secret",
      "https://a#secret",
    ])
      expect(() => createAuthClient({ baseUrl: url, channelId: "ch" })).toThrow(
        RangeError,
      );
    expect(() => createAuthClient({ baseUrl, channelId: "../ch" })).toThrow(
      RangeError,
    );
  });
});

it("pins custom-scheme callback protocol and host", () => {
  const c = client();
  const fragment = `#token=${jwt}&userId=alice&exp=2000000000`;
  expect(
    c.parseRedirect({
      returnedUrl: `mygame://auth?nonce=n${fragment}`,
      redirectUrl: "mygame://auth",
      expectedNonce: "n",
    }),
  ).toMatchObject({ userId: "alice" });
  expect(() =>
    c.parseRedirect({
      returnedUrl: `other-app://hijack?nonce=n${fragment}`,
      redirectUrl: "mygame://auth",
      expectedNonce: "n",
    }),
  ).toThrow();
});

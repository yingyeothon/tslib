# @yingyeothon/lambda-authorizer-jwt

JWT-based AWS API Gateway custom authorizers built on [`@yingyeothon/lambda-authorizer`](../lambda-authorizer). Invalid logins and unknown schemes produce a `Deny` policy, while invalid, expired, or malformed JWTs raise `Unauthorized` (HTTP 401).

- `createJwtAuthorizer` — a **TOKEN** authorizer for REST APIs. `Basic` is checked against your `login` callback and, on success, a freshly signed JWT is returned as the context value `token`; `Bearer` is verified and its claims published through `buildContext`.
- `createJwtRequestAuthorizer` — a **REQUEST** authorizer that verifies only. This is the one to attach to a WebSocket API's `$connect` route, because a WebSocket API supports no other _Lambda_ authorizer type. It never issues: a handshake has no response body to hand a token back through, so keep the login exchange behind a REST endpoint using `createJwtAuthorizer`.

## Install

```bash
npm install @yingyeothon/lambda-authorizer-jwt
```

## Usage

ESM:

```ts
import { createJwtAuthorizer } from "@yingyeothon/lambda-authorizer-jwt";

export const handler = createJwtAuthorizer({
  jwtSecret: process.env.JWT_SECRET!,
  jwtExpiresIn: "30m",
  buildJWTPayload: ({ id }) => ({ id }),
  login: async ({ id, password }) => checkCredentials(id, password),
});
```

CJS:

```js
const { createJwtAuthorizer } = require("@yingyeothon/lambda-authorizer-jwt");

exports.handler = createJwtAuthorizer({
  jwtSecret: process.env.JWT_SECRET,
  login: async ({ id, password }) => checkCredentials(id, password),
});
```

After a successful `Basic` login the issued JWT is available to downstream integrations as the authorizer context value `token`; clients then send it back as `Authorization: Bearer <token>`.

## Verifying on a WebSocket `$connect`

```ts
import { createJwtRequestAuthorizer } from "@yingyeothon/lambda-authorizer-jwt";

export const handler = createJwtRequestAuthorizer({
  jwtSecret: process.env.JWT_SECRET_KEY!,
  verifyOptions: { issuer: "yyt-lobby", audience: "instant-dungeon" },
});
```

A browser cannot set an `Authorization` header on a WebSocket handshake, so the default sources also accept `new WebSocket(url, ["bearer", token])`, which arrives as `Sec-WebSocket-Protocol: bearer, <token>`. Your `$connect` integration must echo the selected subprotocol back or the browser aborts the handshake — see `handleConnect`'s `selectSubprotocol` in [`@yingyeothon/lambda-gamebase`](../lambda-gamebase).

**Pin `issuer` and `audience`.** A valid signature only proves the token was minted by a holder of the secret; it says nothing about which deployment it was minted for. With a shared symmetric secret, every holder of that secret can mint any identity, so the secret is a signing capability and not merely a verification key — treat it accordingly.

Set the API Gateway authorizer's result cache TTL to **0**. `$connect` runs once per connection, so caching buys nothing and lets an allow outlive the token's expiry. Revocation after the handshake is not the authorizer's job either: an established connection is dropped by the application, not by a policy.

## Context

`buildContext` turns verified claims into the policy context. The default, `memberIdFromSubject`, publishes `{ memberId: claims.sub }` — falling back to `claims.id`, which is what this package's own `buildJWTPayload` default issues — and nothing else. That value also becomes the policy's `principalId`.

**An empty context is a refusal.** If `buildContext` returns `{}`, the token is denied rather than allowed with no identity: an authorizer whose job is to establish who is calling must not say yes when it established nobody. So a correctly signed token carrying no subject claim does not get through.

A token with no `exp` claim is denied too, since a bearer credential that never expires cannot be timed out — pass `requireExpiry: false` if you genuinely want one.

The context is deliberately narrow. API Gateway only carries string, number, and boolean values there, and `$context.authorizer.*` can be configured into access logs, so a _verified_ token is never placed in it.

The one exception is `createJwtAuthorizer`'s `Basic` exchange, which returns the JWT it just issued as `context.token` — that is the only way the caller receives it. On an API using that exchange, a live credential is reachable through `$context.authorizer.token`: do not write the authorizer context into access logs there.

## Public API

- `createJwtAuthorizer(options)` — builds an `APIGatewayTokenAuthorizerHandler` from `JwtAuthorizerOptions`.
- `createJwtRequestAuthorizer(options)` — builds an `APIGatewayRequestAuthorizerHandler` from `JwtRequestAuthorizerOptions`.
- `memberIdFromSubject(claims)` — the default `buildContext`: `{ memberId: sub ?? id }`, or `{}`.
- `JwtAuthorizerOptions` (type) — `{ jwtSecret, jwtExpiresIn?, buildJWTPayload?, buildContext?, verifyOptions?, requireExpiry?, login, logger? }`. Defaults: `jwtExpiresIn: "30m"`, `buildJWTPayload: ({ id }) => ({ id })`, `buildContext: memberIdFromSubject`, `requireExpiry: true`.
- `JwtRequestAuthorizerOptions` (type) — `{ jwtSecret, verifyOptions?, buildContext?, requireExpiry?, sources?, onError?, logger? }`. Same defaults.
- `BuildAuthorizerContext` (type) — `(claims: JwtPayload) => APIGatewayAuthorizerResultContext`.

## Migrating from the legacy package

- The npm package was renamed: `@yingyeothon/aws-lambda-jwt-custom-authorizer` → `@yingyeothon/lambda-authorizer-jwt` (and its base package `@yingyeothon/aws-lambda-custom-authorizer` → `@yingyeothon/lambda-authorizer`).
- `buildJWTAuthorizer` → `createJwtAuthorizer`, and its options type `JWTAuthorizerArguments` (legacy `IJWTAuthorizerArguments`) → `JwtAuthorizerOptions`.
- The default export is gone: use the named export `createJwtAuthorizer`.
- `jsonwebtoken` was upgraded from v8 to v9. Verification semantics are unchanged for this package (invalid signature, expired, and malformed tokens all still yield `Unauthorized`), but `jwtExpiresIn` is now typed as `SignOptions["expiresIn"]` (a number of seconds or an `ms`-style string such as `"30m"`), and `buildJWTPayload` is a plain function returning `string | Buffer | object` instead of a generic.
- The `logger` you pass is now also used by the underlying authorizer, so verification errors are logged before `Unauthorized` is thrown (the legacy version silently discarded them). It no longer logs the credential id, the decoded claims, or the issued policy context.
- A verified `Bearer` no longer echoes the token back as the context value `token`. The context is now built from the claims (`{ memberId }` by default); pass `buildContext` to shape it. The `Basic` exchange still returns `{ token }`, because that is the only way the caller receives the JWT it just earned.
- `createJwtRequestAuthorizer` is new. The legacy package built only a TOKEN authorizer, which a WebSocket API cannot use.
- A verified token must now yield an identity and an expiry: an empty `buildContext` result or a missing `exp` denies rather than allows. `requireExpiry: false` restores the old expiry behaviour; there is no opt-out for the identity check.
- A verified token's subject becomes the policy `principalId`.

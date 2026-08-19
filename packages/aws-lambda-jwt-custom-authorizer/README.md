# @yingyeothon/aws-lambda-jwt-custom-authorizer

A JWT-based AWS API Gateway TOKEN custom authorizer built on [`@yingyeothon/aws-lambda-custom-authorizer`](../aws-lambda-custom-authorizer). A `Basic` authorization header is checked against your `login` callback and, on success, a signed JWT is issued in the policy context; a `Bearer` header is verified as a JWT signed with your secret. Invalid logins and unknown schemes produce a `Deny` policy, while invalid, expired, or malformed JWTs raise `Unauthorized` (HTTP 401).

## Install

```bash
npm install @yingyeothon/aws-lambda-jwt-custom-authorizer
```

## Usage

ESM:

```ts
import { buildJWTAuthorizer } from "@yingyeothon/aws-lambda-jwt-custom-authorizer";

export const handler = buildJWTAuthorizer({
  jwtSecret: process.env.JWT_SECRET!,
  jwtExpiresIn: "30m",
  buildJWTPayload: ({ id }) => ({ id }),
  login: async ({ id, password }) => checkCredentials(id, password),
});
```

CJS:

```js
const {
  buildJWTAuthorizer,
} = require("@yingyeothon/aws-lambda-jwt-custom-authorizer");

exports.handler = buildJWTAuthorizer({
  jwtSecret: process.env.JWT_SECRET,
  login: async ({ id, password }) => checkCredentials(id, password),
});
```

After a successful `Basic` login the issued JWT is available to downstream integrations as the authorizer context value `token`; clients then send it back as `Authorization: Bearer <token>`.

## Public API

- `buildJWTAuthorizer(args)` — builds an `APIGatewayTokenAuthorizerHandler` from `JWTAuthorizerArguments`.
- `JWTAuthorizerArguments` (type) — `{ jwtSecret, jwtExpiresIn?, buildJWTPayload?, login, logger? }`. Defaults: `jwtExpiresIn: "30m"`, `buildJWTPayload: ({ id }) => ({ id })`.

## Migrating from the legacy package

- The default export is gone: use the named export `buildJWTAuthorizer`.
- `IJWTAuthorizerArguments` → `JWTAuthorizerArguments`.
- `jsonwebtoken` was upgraded from v8 to v9. Verification semantics are unchanged for this package (invalid signature, expired, and malformed tokens all still yield `Unauthorized`), but `jwtExpiresIn` is now typed as `SignOptions["expiresIn"]` (a number of seconds or an `ms`-style string such as `"30m"`), and `buildJWTPayload` is a plain function returning `string | Buffer | object` instead of a generic.
- The `logger` you pass is now also used by the underlying authorizer, so verification errors are logged before `Unauthorized` is thrown (the legacy version silently discarded them).

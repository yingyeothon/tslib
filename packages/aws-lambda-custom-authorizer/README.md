# @yingyeothon/aws-lambda-custom-authorizer

Helpers for AWS API Gateway TOKEN custom authorizers: it parses the `Authorization` header into `Basic`, `Bearer`, or `Unknown` credentials, delegates the allow/deny decision to your `authorize` callback, and builds the IAM policy document (`execute-api:Invoke` on the event's `methodArn`) that API Gateway expects. Errors thrown while authorizing are logged and turned into an `Unauthorized` error (HTTP 401) by default, or handed to your custom `onError` callback.

## Install

```bash
npm install @yingyeothon/aws-lambda-custom-authorizer
```

## Usage

ESM:

```ts
import { buildAuthorizer } from "@yingyeothon/aws-lambda-custom-authorizer";

export const handler = buildAuthorizer({
  authorize: async (authorization) => {
    if (authorization.type === "Basic") {
      const { id, password } = authorization.credential;
      return { allow: id === "admin" && password === "secret" };
    }
    if (authorization.type === "Bearer") {
      return { allow: await isValidToken(authorization.token) };
    }
    return { allow: false };
  },
});
```

CJS:

```js
const {
  buildAuthorizer,
} = require("@yingyeothon/aws-lambda-custom-authorizer");

exports.handler = buildAuthorizer({
  authorize: async (authorization) => ({
    allow: authorization.type === "Bearer" && authorization.token === "ok",
  }),
});
```

Values returned in `context` from `authorize` are passed through to the policy's `context`, so downstream integrations can read them (for example an issued token).

## Public API

- `buildAuthorizer(args)` — builds an `APIGatewayTokenAuthorizerHandler` from `AuthorizerArguments`.
- `parseAuthorization(token)` — parses a raw `Authorization` header value into an `Authorization`.
- `AuthorizerArguments` (type) — `{ authorize, onError?, logger? }`.
- `Authorizer` (type) — `(authorization: Authorization) => Promise<Authorized>`.
- `Authorized` (type) — `{ allow: boolean; context?: APIGatewayAuthorizerResultContext }`.
- `Authorization` (type) — union of the three shapes below.
- `BasicAuthorization` (type) — `{ type: "Basic"; credential: BasicCredential }`.
- `BasicCredential` (type) — `{ id: string; password: string }`.
- `BearerAuthorization` (type) — `{ type: "Bearer"; token: string }`.
- `UnknownAuthorization` (type) — `{ type: "Unknown"; scheme: string; credential: string }`.

## Migrating from the legacy package

- The default export is gone: use the named export `buildAuthorizer`.
- Interface names dropped the `I` prefix: `IBasicCredential` → `BasicCredential`, `IAuthorized` → `Authorized`, `IHandlerArguments` → `AuthorizerArguments`.
- Types now come from current `@types/aws-lambda`: the handler is an `APIGatewayTokenAuthorizerHandler` and the result an `APIGatewayAuthorizerResult` (the deprecated `CustomAuthorizerHandler`/`CustomAuthorizerResult` aliases are no longer used). The generated policy document shape is unchanged.
- `parseAuthorization` is now exported for direct use.

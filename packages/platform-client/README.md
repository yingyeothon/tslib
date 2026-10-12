# @yingyeothon/platform-client

Small platform HTTP wire client. Wave A exposes the unauthenticated `/time`
route. It returns milliseconds explicitly and contains no device-clock policy.

```mermaid
flowchart LR
  C[createPlatformClient] --> T[GET /time]
  T --> E[epochMs and ISO UTC now]
```

## Install

```bash
npm install @yingyeothon/platform-client
```

## Usage

```ts
import { createPlatformClient } from "@yingyeothon/platform-client";
const platform = createPlatformClient({ baseUrl: "https://doc.yyt.life" });
const time = await platform.time();
```

CJS uses `require("@yingyeothon/platform-client")`. Requests send no bearer;
`game-kit` anchors the returned time to an injected monotonic clock.

## Public API

- `createPlatformClient(PlatformClientOptions)` returns `PlatformClient` with
  `time(): Promise<PlatformTime>`.
- `PlatformClientOptions`: `baseUrl`, structural `fetch?`, `logger?`.
- `PlatformTime`: ISO UTC `now`, integer `epochMs` in milliseconds.
- `PlatformClientError`, `isPlatformClientError`: safe status/code errors.
- `PlatformFetchLike`, `PlatformFetchRequest`, `PlatformFetchResponse`: structural
  HTTP types, compatible with the global fetch without DOM declarations.

## Behavior changes

New package. Malformed responses and HTTP/network refusals carry safe errors;
neither response bodies nor URLs enter those errors.

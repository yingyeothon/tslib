# @yingyeothon/actor-system-aws-lambda-support

AWS Lambda glue for [`@yingyeothon/actor-system`](../actor-system): an API Gateway proxy handler that turns HTTP requests into actor messages, a Lambda handler that processes an actor's queue within the invocation's lifetime, and a shift function that hands remaining work to a fresh asynchronous Lambda invocation when the current one runs out of time.

## Install

```bash
npm install @yingyeothon/actor-system-aws-lambda-support @aws-sdk/client-lambda
```

`@aws-sdk/client-lambda` is a peer dependency, used by `shiftToNextLambda`.

## Usage

ESM:

```ts
import {
  handleActorAPIEvent,
  handleActorLambdaEvent,
  shiftToNextLambda,
  globalTimeline,
} from "@yingyeothon/actor-system-aws-lambda-support";
import { singleConsumer } from "@yingyeothon/actor-system";

// Shared actor environment: queue/lock/awaiter come from your own
// subsystem (for example @yingyeothon/actor-system-redis-support).
const newActorEnv = (actorId: string) => ({
  ...singleConsumer,
  ...actorSubsys,
  id: actorId,
  onMessage: (message: { delta: number }) => applyDelta(message.delta),
  shift: shiftToNextLambda({ functionName: "my-actor-worker" }),
});

// API Gateway entrypoint: enqueue the request body as an actor message
// and process the queue inline ("send") or leave it to a worker ("post").
export const api = handleActorAPIEvent({
  newActorEnv: (apiPath) => newActorEnv(apiPath.slice(1)),
  policy: { type: "send" },
});

// Worker Lambda entrypoint: drain the actor's queue while this
// invocation is alive, then shift the rest to the next invocation.
export const worker = handleActorLambdaEvent({
  newActorEnv: ({ actorId }) => newActorEnv(actorId),
});

// User code can check the remaining invocation lifetime at any point.
if (globalTimeline.over) {
  // wrap up quickly
}
```

CJS:

```js
const {
  handleActorLambdaEvent,
} = require("@yingyeothon/actor-system-aws-lambda-support");

exports.handler = handleActorLambdaEvent({ newActorEnv });
```

## Public API

- `handleActorAPIEvent({ newActorEnv, parseMessage?, logger?, policy })` — builds an `APIGatewayProxyHandler` that parses the request body (default `JSON.parse`) into a message for the actor returned by `newActorEnv(apiPath, event)`. `policy.type: "send"` processes the queue inline (default options: 5s `aliveMillis`, one-shot, shiftable); `policy.type: "post"` only enqueues. Returns `200 OK`; throws on a missing environment, empty body, or falsy parsed message.
- `handleActorLambdaEvent({ newActorEnv, logger?, processOptions? })` — builds a `Handler<LambdaPayload, void>` that resets `globalTimeline` (default lifetime 870s, or `processOptions.aliveMillis`) and runs `tryToProcess` on the environment from `newActorEnv(event)`; by default a shiftable one-shot bounded by the remaining lifetime.
- `shiftToNextLambda({ functionName, functionVersion?, buildPayload?, client? })` — returns an `ActorShift` that invokes `functionName` with `InvocationType: "Event"` and payload `buildPayload(actorId)` (default `{ actorId }`, qualifier default `$LATEST`).
- `Timeline` — tracks elapsed/remaining lifetime: `reset(timeoutMillis?)`, `epochMillis`, `timeoutMillis`, `passedMillis`, `remainMillis`, `over`.
- `globalTimeline` — the process-wide `Timeline`, reset by `handleActorLambdaEvent` at the start of each invocation.
- `ActorLambdaEvent` — `{ actorId: string }`, the default worker invocation payload (type)
- `ActorAPIEventHandlerArguments`, `ActorLambdaHandlerArguments`, `ShiftToNextLambdaArguments` — argument shapes of the factories above (types)

## Migrating from the legacy package

- The package now ships dual ESM/CJS with types; deep imports (`.../lib/handle/...`) are no longer supported — import everything from the package root.
- `shiftToNextLambda` accepts an optional `client: LambdaClient`; by default one client is created per `shiftToNextLambda` call and reused across shifts (the legacy version created a new client on every shift).
- The argument interfaces (`ActorAPIEventHandlerArguments`, `ActorLambdaHandlerArguments`, `ShiftToNextLambdaArguments`) are now exported as types.
- `handleActorLambdaEvent` validates the environment before touching it and stringifies the event in its `No actor env` error message.

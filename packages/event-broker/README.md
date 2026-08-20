# @yingyeothon/event-broker

A tiny, type-safe event broker: define your events as a TypeScript event map, create a broker with `createEventBroker`, and fire events into synchronous or asynchronous handlers. Handlers run in registration order and each async handler is awaited before the next one runs.

## Install

```bash
npm install @yingyeothon/event-broker
```

## Usage

ESM:

```ts
import { createEventBroker } from "@yingyeothon/event-broker";

interface ReaderEventMap {
  read: string;
  error: Error;
}

const reader = createEventBroker<ReaderEventMap>();
reader.on("read", console.log).once("error", console.error);

try {
  for (const line of ["hello", "world"]) {
    await reader.fire("read", line);
  }
} catch (error) {
  await reader.fire("error", error as Error);
}
```

CJS:

```js
const { createEventBroker } = require("@yingyeothon/event-broker");

const ticker = createEventBroker();
const onTick = (value) => console.log("tick", value);
ticker.on("tick", onTick);
ticker.fire("tick", 1).then(() => ticker.off("tick", onTick));
```

There is no need to await the result of `fire` when every handler is synchronous.

## Public API

- `createEventBroker<E>()` — factory that returns an `EventBroker<E>`.
- `EventBroker<E>` — interface. Listener registration via `on(name, handler)`, `once(name, handler)`, and `off(name, handler)`, each returning the broker for chaining. Events are dispatched with `fire(name, event)`, which awaits handlers one by one in registration order and resolves to `true` when at least one handler was registered. A handler that throws (or rejects) makes `fire` reject and skips the remaining handlers.
- `EventListenable<E>` — interface with the listener-facing surface: `on`, `once`, and `off`.
- `EventHandler<T>` — type of an event handler: `(event: T) => unknown`, where a returned promise is awaited.

## Migrating from the legacy package

- `EventBroker<E>` is now an interface, not a class: replace `new EventBroker()` (or subclassing) with `createEventBroker<E>()`. `fire` is part of the public surface instead of a protected method, so dispatching no longer requires a subclass.
- `once` and `off` are new; the legacy broker only supported `on`.
- `EventListenable<E>` now declares `once` and `off` in addition to `on`, so custom implementations must provide all three.
- Handlers are snapshotted per `fire` call: handlers added or removed during dispatch take effect from the next `fire`, whereas the legacy broker iterated the live handler array.
- `fire` resolves to `false` when the event has no remaining handlers (the legacy broker returned `false` only when the event name had never been registered).

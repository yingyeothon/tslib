# @yingyeothon/event-broker

A tiny, type-safe event broker: define your events as a TypeScript event map, extend `EventBroker`, and fire events into synchronous or asynchronous handlers. Handlers run in registration order and each async handler is awaited before the next one runs.

## Install

```bash
npm install @yingyeothon/event-broker
```

## Usage

ESM:

```ts
import { EventBroker } from "@yingyeothon/event-broker";

interface ReaderEventMap {
  read: string;
  error: Error;
}

class Reader extends EventBroker<ReaderEventMap> {
  public async start(lines: string[]): Promise<void> {
    try {
      for (const line of lines) {
        await this.fire("read", line);
      }
    } catch (error) {
      await this.fire("error", error as Error);
    }
  }
}

await new Reader()
  .on("read", console.log)
  .once("error", console.error)
  .start(["hello", "world"]);
```

CJS:

```js
const { EventBroker } = require("@yingyeothon/event-broker");

class Ticker extends EventBroker {
  async tick(value) {
    await this.fire("tick", value);
  }
}

const ticker = new Ticker();
const onTick = (value) => console.log("tick", value);
ticker.on("tick", onTick);
ticker.tick(1).then(() => ticker.off("tick", onTick));
```

There is no need to await the result of `fire` when every handler is synchronous.

## Public API

- `EventBroker<E>` — class. Listener registration via `on(name, handler)`, `once(name, handler)`, and `off(name, handler)`, each returning `this` for chaining. Subclasses dispatch events with the protected `fire(name, event)`, which awaits handlers one by one in registration order and resolves to `true` when at least one handler was registered. A handler that throws (or rejects) makes `fire` reject and skips the remaining handlers.
- `EventListenable<E>` — interface with the listener-facing surface: `on`, `once`, and `off`.
- `EventHandler<T>` — type of an event handler: `(event: T) => unknown`, where a returned promise is awaited.

## Migrating from the legacy package

- `once` and `off` are new; the legacy broker only supported `on`.
- `EventListenable<E>` now declares `once` and `off` in addition to `on`, so custom implementations must provide all three.
- Handlers are snapshotted per `fire` call: handlers added or removed during dispatch take effect from the next `fire`, whereas the legacy broker iterated the live handler array.
- `fire` resolves to `false` when the event has no remaining handlers (the legacy broker returned `false` only when the event name had never been registered).

## License

MIT

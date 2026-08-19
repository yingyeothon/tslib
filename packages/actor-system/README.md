# @yingyeothon/actor-system

Lightweight actor system built on three pluggable abstractions — a per-actor message queue, a per-actor lock, and an awaiter that lets senders wait for their message's completion. Any backing store (in-memory, Redis, DynamoDB, ...) can drive it by implementing a handful of small interfaces; in-memory implementations are included. Zero runtime dependencies.

## Install

```bash
npm install @yingyeothon/actor-system
```

## Usage

ESM:

```ts
import {
  AwaitPolicy,
  InMemoryAwaiter,
  InMemoryLock,
  InMemoryQueue,
  send,
  singleConsumer,
  tryToProcess,
} from "@yingyeothon/actor-system";

interface AdderMessage {
  delta: number;
}

let value = 0;
const env = {
  ...singleConsumer,
  id: "adder",
  queue: new InMemoryQueue(),
  lock: new InMemoryLock(),
  awaiter: new InMemoryAwaiter(),
  onMessage: ({ delta }: AdderMessage) => {
    value += delta;
  },
};

// Enqueue a message and process the queue in this thread,
// waiting until this message has been committed.
await send(env, { item: { delta: 1 }, awaitPolicy: AwaitPolicy.Commit });

// Or only enqueue (post) and let a dedicated processor drain the queue.
await tryToProcess(env, { aliveMillis: 10_000, shiftable: true });
```

CJS:

```js
const {
  eventLoop,
  InMemoryLock,
  InMemoryQueue,
} = require("@yingyeothon/actor-system");

await eventLoop({
  id: "loop-1",
  queue: new InMemoryQueue(),
  lock: new InMemoryLock(),
  loop: async (poll) => {
    for (const item of await poll()) {
      console.log(item);
    }
  },
});
```

## Concepts

- `enqueue` appends a message to an actor's queue; `post` enqueues and optionally waits for another processor to complete it; `send` enqueues and then tries to process the queue in the calling thread.
- `AwaitPolicy` selects how long a sender waits: `Forget` (not at all), `Act` (until its handler ran), or `Commit` (until the whole processing pass, including `onCommit`, finished).
- `tryToProcess` acquires the actor's lock and drains the queue, either message-by-message (`singleConsumer` + `onMessage`) or all-at-once (`bulkConsumer` + `onMessages`). With `aliveMillis`/`shiftable` it cooperates with limited-lifetime containers such as AWS Lambda by invoking `shift` when time runs out.
- `eventLoop` hands the lock plus a `poll` drain function to a user-supplied loop.

## Public API

Functions:

- `enqueue(env, input)` — queue a message, filling in `messageId` (random UUID), `awaitPolicy` (`Forget`), and `awaitTimeoutMillis` (0).
- `post(env, input)` — enqueue and await completion according to the message's `AwaitPolicy`.
- `send(env, input, options?)` — enqueue, try to process in this thread, and await completion.
- `tryToProcess(env, options?)` — lock and drain the actor's queue; returns the `AwaiterMeta[]` of processed messages.
- `eventLoop(env)` — lock the actor and run a user loop with a queue-draining `poll`; `false` if the lock was held.

Values:

- `AwaitPolicy` — `Forget` | `Act` | `Commit` enum.
- `singleConsumer`, `bulkConsumer` — spreadable consume-type markers.
- `InMemoryQueue`, `InMemoryLock`, `InMemoryAwaiter` — in-process support implementations.
- `noopLogger` — a logger that discards everything.

Types:

- Messages: `AwaiterMeta`, `UserMessage`, `UserMessageItem`, `UserMessageMeta`.
- System interfaces: `QueueProducer`, `QueueSingleConsumer`, `QueueBulkConsumer`, `QueueLength`, `LockAcquire`, `LockRelease`, `AwaiterWait`, `AwaiterResolve`, `ActorShift`.
- Environments: `ActorProperty`, `ActorLogger`, `ActorErrorHandler`, `ActorSingleMessageHandler`, `ActorMessageBulkConsumer`, `ActorEnqueueEnvironment`, `ActorPostEnvironment`, `ActorSendEnvironment`, `ActorProcessEnvironment`, `ActorLoopEnvironment`, `ActorSingleEnv`, `ActorBulkEnv`, `ActorEventLoopEnvironment`, `ActorProcessOptions`.
- Logging: `ActorSystemLogger` — a minimal structural logger (`debug`/`info`/`error`), compatible with `@yingyeothon/logger`'s `Logger`.

## Migrating from the legacy package

- Everything is exported from the package root as named exports; deep imports such as `@yingyeothon/actor-system/lib/queue/producer` are gone — import the same names from the root instead.
- The package no longer depends on `uuid` (uses `crypto.randomUUID()`) or `@yingyeothon/logger`; the `logger` environment field now accepts any `ActorSystemLogger`, which every `@yingyeothon/logger` `Logger` satisfies.
- The misspelled `ActroEventLoopEnvironment` type is now `ActorEventLoopEnvironment`.

# @yingyeothon/naive-socket

Zero-dependency TCP socket client over `node:net` with a serialized request queue, per-request timeouts, pluggable response matching (regex, fixed length, or a custom function), and automatic reconnection. Useful for talking to simple line- or length-based text protocols (for example Redis) without pulling in a full client library.

## Install

```bash
npm install @yingyeothon/naive-socket
```

## Usage

ESM:

```ts
import { NaiveSocket, withMatch } from "@yingyeothon/naive-socket";

const socket = new NaiveSocket({
  host: "localhost",
  port: 6379,
  connectionRetryInterval: 5000, // negative value disables auto-reconnect
});

// Consume everything received so far (default fulfill).
const pong = await socket.send({ message: "PING\r\n" });

// Wait until the response matches; the first capture group is consumed.
const ok = await socket.send({
  message: 'SET "greeting" "hello"\r\n',
  fulfill: /^(\+OK\r\n)$/,
  timeoutMillis: 1000,
});

// Consume a fixed number of characters.
const fixed = await socket.send({
  message: 'GET "greeting"\r\n',
  fulfill: "$5\r\nhello\r\n".length,
});

// Or scan the buffer with a custom matcher.
const custom = await socket.send({
  message: "SMEMBERS my-set\r\n",
  fulfill: withMatch((m) => m.capture("\r\n").capture("\r\n")),
  urgent: true, // jump to the front of the queue
});

socket.disconnect();
```

CJS:

```js
const { NaiveSocket } = require("@yingyeothon/naive-socket");
const socket = new NaiveSocket({ host: "localhost", port: 6379 });
socket
  .send({ message: "PING\r\n", timeoutMillis: 500 })
  .then(console.log)
  .finally(() => socket.disconnect());
```

Requests are written one at a time: the next queued message is sent only after the previous response is fulfilled. A `fulfill` result `<= 0` means "wait for more data"; a positive result consumes that many characters from the head of the receive buffer and resolves the request with them, leaving the remainder for the next request.

## Public API

- `NaiveSocket` — the client; `send(request)` returns `Promise<string>`, `disconnect()` rejects all pending requests with `DeadSocket`
- `NaiveSocketOptions` — `{ host, port, connectionRetryInterval?, logger?, onConnectionStateChanged? }` (type)
- `SendRequest` — `{ message, fulfill?, timeoutMillis?, urgent? }` (type)
- `Fulfill` — `((buffer: string) => number) | RegExp | number` (type)
- `ConnectionState` — `Connecting | Connected | Disconnected` (enum)
- `ConnectionStateListener` — callback for `onConnectionStateChanged` (type)
- `Logger` — `{ info, warn, error }` sink used for internal logging (type)
- `TextMatch` — cursor-based text scanner: `capture(endMark)`, `values()`, `evaluate()`
- `withMatch(chain)` — lifts a `TextMatch` chain into a `fulfill` function
- `TextMatchChain` — `(m: TextMatch) => TextMatch` (type)

## Migrating from the legacy package

- All exports are named now: `import NaiveSocket from "naive-socket"` becomes `import { NaiveSocket } from "@yingyeothon/naive-socket"`, and `import TextMatch, { withMatch } from "naive-socket/lib/match"` becomes `import { TextMatch, withMatch } from "@yingyeothon/naive-socket"` — deep imports are no longer supported.
- The package ships dual ESM/CJS with bundled types; runtime behavior of `send`, `disconnect`, fulfill strategies, timeouts, urgent ordering, and auto-reconnect is unchanged.

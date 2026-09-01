# gateway-client

A lobby client and a dungeon client, driven against an injected fake socket —
no network, no gateway, no token. It ends on the distinction the whole client
exists to make: **a run that finished, and a run that was aborted.**

The deployable counterpart is any browser game on a yyt channel; the C# half of
the same SDK is [`csharplib`](https://github.com/yingyeothon/csharplib).

```bash
pnpm --filter yyt-example-gateway-client start
```

```
lobby url:        wss://gw.yyt.life/?channel=lobby_demo
subprotocols:     ["bearer","a.channel.jwt"]
  ^ the JWT rides here, never in the URL, and is never logged
connect() gave:   zone=town
peers after move: [{"userId":"u2","x":4,"y":1}]

how a dungeon run ends:
  close 1000 -> finished  event=finished
  close 4001 -> aborted   event=aborted
  1000 finished the run; 4001 means the actor died and a retry
  needs a NEW gameId — the old queue key is gone. Neither
  reconnects; every other code does, with backoff.
```

## Why a fake socket rather than a real one

The SDK reads `globalThis.WebSocket` only as the default behind an injectable
option, so passing a class is enough to run the real client with no network.
That is not only convenience: **a real socket cannot be asked to close with code
4001 on cue**, and that code is the one a game most needs to handle. The class
in `src/fake-web-socket.ts` is the same one `gamebase-client`'s own tests use,
copied rather than imported because a package's `test/` directory is not
published.

## The two clients differ in when `connect()` resolves

- **Lobby:** on the `hello` frame, not on the socket opening. `hello` is the
  only delivery path for the channel's capabilities and its map pointer, so
  nothing is meaningfully connected before it.
- **Dungeon (`q`):** on the socket opening, because a `q` channel has no
  handshake frame. A connected socket is therefore not yet a joined run — wait
  for the actor's first frame, usually a snapshot.

## Finished, aborted, and the difference

| Close  | Event      | What happened                           | What to do                  |
| ------ | ---------- | --------------------------------------- | --------------------------- |
| `1000` | `finished` | the game ended normally and dropped you | show the result             |
| `4001` | `aborted`  | the actor stopped consuming its queue   | **allocate a new `gameId`** |

Neither reconnects. A retry after an abort with the same `gameId` is refused:
the gateway deleted the queue key. Every other code reconnects with backoff —
500 ms, ×2, capped at 15 s, ±20 % jitter — until `backoff.maxAttempts` runs out.
This example passes `maxAttempts: 0`, so a closed run stops immediately instead
of retrying a socket the test will never reopen.

## Two frames that look right and are dropped

Both were caught by the compiler or by this example failing, not by review:

- **`capabilities.say` is a list of scopes, not a boolean.** The SDK's types
  mirror the gateway's Go structs, including the JSON tags.
- **A `pos` frame carries its own `zone`,** not just a zone per peer. Frames for
  another zone are ignored, so a `pos` without one silently never reaches the
  peer map — the peer stays where the snapshot put it.

The same class of trap: `dir` is an opaque **string** of at most 16 bytes
(`"n"`, `"left"`). A numeric `dir` makes the whole frame a `bad_message` and the
position is dropped.

## Read next

[`@yingyeothon/gamebase-client`](../../packages/gamebase-client/README.md) for
the full reconnect policy, the party roster's `omitempty` fields, and the
complete close-code table.

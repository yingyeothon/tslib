# actor-game

A whole game — wait, play, end, drop — running through the **real
`handleActor`** in one process, with no AWS, no Redis and no gateway.

The deployable version of this is `examples/sample-dungeon` in the `service`
repository: the same two functions, wired to a Serverless stack, an auth service
and a `q` channel.

```bash
pnpm --filter yyt-example-actor-game start
```

```
  -> local:m1  {"type":"snapshot","payload":{"bossHp":12,"bossMaxHp":12,...}}
  -> local:m2  {"type":"snapshot","payload":{"bossHp":12,"bossMaxHp":12,...}}
  -> local:m1,local:m2  {"type":"stage","payload":{"stage":"wait","age":0}}
  -> local:m1,local:m2  {"type":"stage","payload":{"stage":"running","age":0}}
  -> local:m1,local:m2  {"type":"hit","payload":{"memberId":"m1","dealt":2}}
  ...four more hits...
  -> local:m1,local:m2  {"type":"result","payload":{"reason":"cleared",...}}
  -> local:m1,local:m2  {"type":"stage","payload":{"stage":"end","age":5}}
  xx local:m1 dropped
  xx local:m2 dropped

boss hp 0/12, cleared=true, 12 frames, 2 connections dropped
```

## What is real, and what is swapped out

`handleActor` and `runGameAllTogether` are the actual entry points a Lambda
calls. Only what they talk to is replaced, and each replacement is an option the
library already offers:

| Production                               | Here                                                         |
| ---------------------------------------- | ------------------------------------------------------------ |
| Redis queue and lock                     | `createInMemoryQueue` / `createInMemoryLock` via `subsystem` |
| `redisSet` / `redisDel`                  | `saveStartEvent` / `deleteStartEvent`                        |
| API Gateway or a Redis pub/sub transport | a recording `Transport` (`src/transport.ts`)                 |

Supplying all three is what lets `handleActor` run with **no `redisConnection`
and no `context`** — those are the only three things it would use one for.

`src/game.ts` is the half you replace: pure rules, no imports, no IO, no clock,
so it unit-tests without a queue or a socket.

## Two things that look right and are not

**Attacks are pushed while the game runs, not queued up front.** The wait stage
drains the queue looking for `enter`/`leave` and discards everything else, so a
raid seeded with attacks before it starts ends on `timeout` with nobody having
hit anything. The first draft of this example did exactly that.

**The tick policy is a choice, not a default to accept.** `perMessage` is right
here because nothing moves unless somebody acts. A real-time game needs
`{ mode: "fixed", intervalMillis: 50 }`, or monster AI, damage over time and
cooldowns freeze whenever the party stands still and then jump by seconds at
once.

## Ending a game so the party hears about it

`onGameEnd` runs while the connections are still open, which is why the result
goes out there. `endDropDelayMillis` (default 1000) then lets that frame flush
before the sockets close — API Gateway can lose a message posted immediately
before `DeleteConnection`. This example sets it to `0` only because a recording
transport cannot lose anything.

Over `createRedisPubSubTransport` you also need `endRepeatCount` of 2 or more:
those frames are published exactly once, pub/sub has no redelivery, and unlike a
tick snapshot nothing later heals the gap.

## Read next

[`@yingyeothon/lambda-gamebase`](../../packages/lambda-gamebase/README.md) for
the actor loop and the gateway integration contract, and
[`@yingyeothon/gamebase-all-together`](../../packages/gamebase-all-together/README.md)
for the stage machine and the tick policy.

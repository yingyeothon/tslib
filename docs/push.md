# Android push

This page owns `push-client` and `push-server`: registering a device from an app
and sending from a game server. The
[service push contract](https://github.com/yingyeothon/service/blob/main/docs/push.md)
owns routes, message limits, campaign CSVs and operator setup.

## Register from an app

Use [push-client](../packages/push-client/README.md) with the player's JWT.
The app owns Firebase configuration and the FCM SDK; pass its registration token
and Firebase project to `register` on every start and token refresh. Before
clearing the JWT on sign-out, call `unregister` with that registration token.
This package supports Android/FCM; iOS and browser Web Push are unsupported.

## Send from a server

Use [push-server](../packages/push-server/README.md) with the push channel API key.
**Keep the API key on the server.** State and console have separate base URLs:
state handles targeted sends, console handles uploads, jobs and broadcasts.

A targeted send result describes FCM acceptance per user, not device receipt.
Retry only recipients reported failed with `budget` or `unavailable`; never
resend an entire call after an ambiguous network failure. The wrapper retries
nothing automatically.

For campaigns, create a template in the console, obtain an upload URL, upload the
CSV with exactly its signed headers, then submit a job using a caller-supplied
idempotency key. Presigned upload and report requests must not carry the API key.
Broadcasts use caller-supplied idempotency keys too; their topic is public and a
message cannot prove ownership of a reward.

## Try it without infrastructure

The [push example](../examples/push/README.md) exercises registration, targeted
send, upload/job replay, report URL and broadcast with a shared structural fake.
It does not prove delivery on a phone. Device receipt remains an owner check.

Continue with [Game kit](game-kit.md) for session and room composition.

# kvstore-client

The two things a game does with the yyt key-value store, against an in-memory
stand-in for the state stack: **read the announcements** the team publishes,
and **save and load the player's own record** — with no network, no console
and no real token.

```bash
pnpm --filter yyt-example-kvstore-client start
```

```
announcements:        ["Season 2 starts","Maintenance on Monday"]
a player writing one: forbidden
my profile:           {"name":"lacti","volume":0.5}
versions after saves: 1 -> 2
stale ifMatch=1:      {"status":409,"currentVersion":2}

requests the client made (the token rode in Authorization, never here):
  GET /kv/announcements/entries
  PUT /kv/announcements/entries/2026-09-07-hax
  PUT /kv/profile/u/me/entries/settings
  GET /kv/profile/u/me/entries/settings
  PUT /kv/profile/u/me/entries/settings ("1")
  PUT /kv/profile/u/me/entries/settings ("1")
  GET /kv/profile/u/me/entries/settings
```

## Why a fake server rather than the dev stage

The client reads `globalThis.fetch` only as the default behind its `fetch`
option, so a function is enough to run the real client end to end. The stand-in
in `src/fake-kv-server.ts` keeps the parts of the contract a game meets first:
`team` scopes that refuse the API, the `/u/{owner}` namespace that
`writeScope: user` implies, versions as `ETag`, `If-Match`, and the `409` that
names the live version. It is deliberately not the server — the wire contract
of record is `services/state/README.md` in the service repository, and the
package's own integration test runs against the real one when
`YYT_KV_BASE_URL` and `YYT_KV_TOKEN` are set.

## What the two cases show

- **Announcements** are one `list({ values: true, order: "desc" })`. The
  collection was created with `readScope: project, writeScope: team`, so every
  player reads it and the only writer is the console or `yyt kv` — a player's
  `put` is a `403`, not a silent no-op.
- **My record** lives under `mine`, which is `/kv/profile/u/me/entries`. The
  server resolves `me` from the JWT, so the client never learns or types a
  user id. With this collection's `readScope: user` another player cannot read
  it either; a public profile would use `readScope: project` instead.
- **A stale write loses.** The second save passes `ifMatch` with the version it
  read, and a third write that still believes version 1 gets `409` carrying
  `currentVersion: 2`. Read again and retry; the client does not do that for
  you.

## Read next

[`@yingyeothon/kvstore-client`](../../packages/kvstore-client/README.md) for
the full API, the local refusals, and what the error carries.

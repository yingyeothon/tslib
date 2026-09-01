# repository-cas

Two writers edit one document from the same starting revision, and both of their
changes survive. Runs in one process with no Redis, no AWS and no Docker.

The deployable version of this idea is the character sheet in the `service`
repository's `examples/sample-morpg` — the same conditional write, against the
platform's doc store.

```bash
pnpm --filter yyt-example-repository-cas start
```

## What it shows

`createMapDocument` does a read-modify-write on every edit. On a `CasRepository`
that write is conditioned on the revision it read, so a writer that lost a race
is **refused rather than applied**, re-reads, and re-applies its own change. The
example makes that race happen every time by holding the first conditional write
open until the second one has committed — see `src/stall.ts` for why a real
interleaving is not worth asserting.

Expected output:

```
scores:  {"alice":1,"bob":2}
version: 2 (one write each)
the stale write was refused: true
```

**Without the conditional write, `alice` would be gone.** The second writer
would send a whole document built from what it read before the first writer
committed. That is the inventory-duplication bug in its smallest form.

## Against a real Redis

The identical script, one environment variable. It is namespaced on purpose:
plain `REDIS_HOST` is already set to a real store in the environments this
repository is developed in, and an example must never reach for one by
accident.

```bash
docker run --rm -d -p 6379:6379 redis:7-alpine
YYT_EXAMPLE_REDIS_HOST=127.0.0.1 pnpm --filter yyt-example-repository-cas start
```

`@yingyeothon/repository-redis` refuses a write with no TTL, which is why every
write here passes `expiresInMillis`. On a shared `allkeys-lru` Redis a key that
never expires evicts someone else's first.

## Read next

[`@yingyeothon/repository`](../../packages/repository/README.md) for the three
interfaces and what a revision token actually is on each backend, and
[`@yingyeothon/repository-redis`](../../packages/repository-redis/README.md) for
the TTL rule this example obeys.

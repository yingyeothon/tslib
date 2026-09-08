# Manual Verification

Unit tests passing is not proof a library change works for consumers. After
tests pass, exercise the change against the real build.

## Procedure

1. `pnpm build` — the published artifact is `dist`, not `src`.
2. Write a throwaway script under a scratch directory (never commit it) that
   imports the package the way a consumer would, and run it with Node >= 20.
3. Verify **both** module systems, because every package ships dual output:
   - ESM: `import { createX } from "@yingyeothon/<pkg>"`
   - CJS: `const { createX } = require("@yingyeothon/<pkg>")`
4. Check the type surface too: `pnpm typecheck`, and for export-map changes run
   `pnpm dlx @arethetypeswrong/cli --pack packages/<name>` (the dev dependency is
   already declared for this purpose).

## Verify in the real consumer before publishing

- A release is not the test bed. Point the service repo at this checkout
  with `node scripts/link-service.mjs link` (writes a marked `overrides:`
  block into each target's `pnpm-workspace.yaml` — pnpm 11 ignores
  `pnpm.overrides` in `package.json` — and installs), run its typecheck and
  tests, and deploy an example to the `dev` stage from the link when the
  change touches runtime behaviour (reconnects, TTLs, protocol).
- Consumers resolve `dist`, so `pnpm build` here after every edit.
- `unlink` before committing in the consumer; the block and the lockfile
  churn must never land there. `unlink` restores `pnpm-workspace.yaml` but
  leaves the samples' `pnpm-lock.yaml` rewritten — `git checkout --` those two
  files afterwards and confirm both consumer trees are clean.
- Publish only after the linked verification passed end to end. The 2026-09-08
  run (timeout budget, urgent ordering, post-game cleanup, the `4005`/`aoi`
  client fields) covered: service `build` + `typecheck` + `test` (1212 tests),
  and both samples' `typecheck` + `test` (19 and 308).

## Verifying a platform client against the dev stage

- The service repo's smoke helpers do the provisioning: import
  `scripts/smoke/_lib.mjs` (`jsonClient`, `debugLogin`, `asUser`,
  `createChecker`) and `_team.mjs` (`ensureTeam`, reuse the `smoke-kv` team)
  from a scratch script, with `local/deploy/debug-key.dev` as the debug key
  against `console-dev` / `auth-dev` / `doc-dev.yyt.life`.
- Order: `debugLogin` a synthetic member → `ensureTeam` → `POST
/projects/{prj}/channels` `{kind:"auth", config:{audience, tokenTtlSec,
redirectAllowlist:[], providers:{}}}` → `POST /projects/{prj}/kv` per
  collection → seed with the **console** entry route, whose body is
  `{ valueText: "<json>" }` (not the raw value the KV API takes) → mint a
  player JWT with auth's `POST /debug/token` `{channelId, userId}` → run the
  env-gated integration test with `YYT_KV_*` → exercise the built `dist` by
  hand → `finally`: delete the collections and the channel, and re-login the
  member with `role: "pending"`. `kvstore-client` was verified this way on
  2026-09-06 (round trip, `ifMatch`/`ifNoneMatch` 409s, `wrong_namespace`,
  another owner's 403, a bad token's 401, listing by name).
- Console writes take a 550 ms slot per member (`jsonClient({ writeSlotMs })`);
  the KV API has none, so use a second client for it.

## Making states reachable without infrastructure

The library equivalents of debug-only state hooks are the injection seams; use
them instead of standing up cloud infrastructure to observe a code path:

- Inject a capturing `Logger` to observe internal decisions.
- Use the in-memory implementations (`repository` in-memory impl, in-memory
  actor system) to drive flows without Redis, S3, or Lambda.
- Point Redis-backed code at a local container
  (`docker run --rm -p 6379:6379 redis:7-alpine`) rather than a shared server.
- Pass options directly rather than exporting extra env knobs. Never add a
  verification-only export to the public API — if a state is unreachable through
  the public surface, that is a design finding, not a reason for a back door.

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
  churn must never land there. Publish only after the linked verification
  passed end to end.

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

# Release & Versioning

## Versioning

- All 20 packages share one version, and the version **is committed**: the
  Release workflow writes it into every `packages/*/package.json`, commits
  `Release vX.Y.Z`, and tags that commit. Between releases the manifests carry
  the last released version. Never edit `version` by hand — only the workflow
  (or the bootstrap script, transiently) does.
- `scripts/set-version.mjs <x.y.z>` stamps a version into every package.
  Workspace ranges (`workspace:^`) stay intact; `pnpm publish` rewrites them
  to real semver.
- `scripts/verify-release-version.mjs <x.y.z>` is the gate: stable semver
  only, and the version must exceed every version already published on npm
  for every package (a name new to npm passes). If the tag already exists it
  must carry that version — that is the publish-retry path.

## Release flow (the user runs it)

1. Ensure `main` is green (see [workflow.md](workflow.md)) and pushed.
2. GitHub → Actions → **Release** → _Run workflow_ with `version: X.Y.Z`
   (no leading `v`). The workflow, on a fresh checkout of `main`:
   verify version → stamp → build/lint/format/typecheck/test →
   commit + annotated tag → `git push --atomic origin main vX.Y.Z` →
   `pnpm -r publish --provenance` → GitHub Release with generated notes.
3. Version, tag, commit, and npm provenance therefore all point at the same
   commit. The push is atomic: either the release commit and tag both land or
   neither does, and nothing is published unless the push succeeded.
4. If publishing fails part-way, re-run the workflow with the same version:
   it detects the existing tag, checks it out, and `pnpm -r publish` skips the
   packages already on npm.
5. The job uses the `npm-release` GitHub environment. Add required reviewers
   there if the "Run workflow" button alone feels too easy to press.
6. `main` branch protection must let `github-actions[bot]` push (or exempt the
   workflow); otherwise the push step fails before anything is published.

## Authentication: Trusted Publishing (OIDC)

- Publishing uses npm Trusted Publishing. There is **no `NPM_TOKEN`** — do not
  reintroduce a `NODE_AUTH_TOKEN` env or reference the secret anywhere.
- The job needs `permissions: id-token: write` and npm >= 11.5.1 (the workflow
  upgrades npm because Node 22 ships an older one). Provenance is attached
  automatically on the OIDC path.
- Every package must have `yingyeothon` / `tslib` / `release.yml` registered
  as a Trusted Publisher on npmjs.com (package → Settings → Trusted Publisher
  → GitHub Actions; the environment name `npm-release` may be set there too).
- Registration is only possible for packages that already exist, so a
  brand-new name needs one manual publish first:
  `scripts/bootstrap-publish.sh <version> <dir>...` (after `npm login`). It
  stamps transiently, publishes only the listed packages under the
  `bootstrap` dist-tag, and restores the manifests; it is not a release, so
  nothing is committed or tagged. Register the Trusted Publisher, then run the
  real Release workflow — npm has no cooldown between successive versions.
  Pending: `@yingyeothon/repository-dynamodb` (added 2026-08-29) is not on
  npm yet and needs this bootstrap before its first Release.
- After a brand-new name is published, `npm access get status` answers at
  once but `npm view` can return 404 for ~5 minutes while the read replicas
  catch up. Wait; do not republish. The first version of a package always
  gets `latest` as well, whatever `--tag` said — the next real release
  overrides it.
- `ci.yml` must never touch publish credentials.

## Pre-release verification

```bash
pnpm -r exec npm pack --dry-run              # tarballs contain dist + README + package.json only
pnpm -r publish --dry-run --no-git-checks --access public
pnpm dlx @arethetypeswrong/cli --pack packages/<name>   # export map / .d.cts sanity
```

Confirm each tarball ships `dist/index.d.cts`, no `src/`, and no test files.

## Legacy packages

- Renamed-away names (`slack-logger`, `actor-system-redis-support`,
  `actor-system-aws-lambda-support`, `aws-lambda-custom-authorizer`,
  `aws-lambda-jwt-custom-authorizer`) are deprecated on npm, not unpublished
  (`npm deprecate "<pkg>@*" "Moved to <new>"`; an empty message undoes it).
- Kept names must never be deprecated — v2 publishes under the same names.
- Legacy GitHub repos get a DEPRECATED notice pushed to the README _before_
  being archived; archiving makes them read-only. Done 2026-08-28 for
  `nodejs-actor-system`, `nodejs-lambda-authorizer`, `nodejs-repository`,
  `nodejs-toolkit`, `naive-redis`, `naive-socket`, `s3-cache-bridge-client`,
  `slack-logger`. Their clones under `~/git/yyt.life/` are read-only history
  now; commits there need `--no-verify` because the old husky hooks are gone.
- Executing these steps is the user's job. Assist only when asked.

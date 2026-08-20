# Release & Versioning

## Versioning

- All 18 packages share one version. `version` stays `0.0.0` in git — never bump
  it by hand.
- `scripts/set-version.mjs <x.y.z>` stamps the tag version into every
  `packages/*/package.json` at release time. Workspace ranges (`workspace:^`)
  stay intact; `pnpm publish` rewrites them to real semver.

## Release flow (the user performs the release)

1. Ensure `main` is green (see [workflow.md](workflow.md)) and pushed.
2. Publish a GitHub Release with a stable tag `vX.Y.Z` — the workflow rejects
   anything else, and the version must exceed any previously published version
   of a kept package name (hence v2.0.0+).
3. `.github/workflows/release.yml` then stamps, builds, lints, typechecks,
   tests, and runs `pnpm -r publish --access public --no-git-checks --provenance`.

## Authentication: Trusted Publishing (OIDC)

- Publishing uses npm Trusted Publishing. There is **no `NPM_TOKEN`** — do not
  reintroduce a `NODE_AUTH_TOKEN` env or reference the secret anywhere.
- The job needs `permissions: id-token: write`. Provenance is attached
  automatically on the OIDC path.
- Every package must have `yingyeothon` / `tslib` / `release.yml` registered as a
  Trusted Publisher on npmjs.com (package → Settings → Trusted Publisher →
  GitHub Actions). Registration is only possible for packages that already
  exist, so a brand-new package name needs one manual `npm publish` (with
  `npm login` + OTP) before it can be added.
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
  being archived; archiving makes them read-only.
- Executing these steps is the user's job. Assist only when asked.

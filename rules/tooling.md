# Toolchain, Build & CI

## Order of operations

- `pnpm build` first. `typecheck` and `test` resolve workspace dependency types
  through each package's `dist`, so a stale or missing build produces confusing
  `TS2307`/`TS7016` errors — especially right after a rename. `examples/*` are
  workspace projects too, so this applies to them for the same reason.
- **Run `pnpm format` after anything that touches `pnpm-lock.yaml`.** The
  committed lockfile is Prettier-formatted, and pnpm rewrites it in its own raw
  YAML style (single quotes, a blank line after `importers:`) whenever a
  manifest changes. The result is a ~5500-line diff that hides the three real
  lines and fails `format:check`; re-running Prettier collapses it back.
- CI (`.github/workflows/ci.yml`) runs, in order:
  install → build → lint → format:check → check:docs → typecheck → coverage,
  on Node 22 and 24. `.githooks/pre-push` runs the same list in the same order;
  keep the two in step, including the hook's echoed summary.
  `format:check` is a hard gate: run `pnpm format` before committing.

## Package manifest invariants

- `"type": "module"`, dual `exports` map (import/require × types/default),
  `files: ["dist"]`, `sideEffects: false`, `engines.node >= 20`.
- Build script is always `tsup --config ../../tsup.config.base.ts`.
- `version` is written only by the Release workflow — see [release.md](release.md).
- **Any `@types/*` package referenced by a public `.d.ts` must be a runtime
  `dependency`, not a devDependency.** `@types/aws-lambda` (4 packages) and
  `@types/jsonwebtoken` (jwt authorizer) are there for that reason; moving them
  back to devDependencies breaks consumers with `TS2307`/`TS7016`.
- Pin dependencies that would break the CJS half of the dual build. Known:
  `serialize-error` must stay on `^8` (v9+ is ESM-only).
- pnpm is pinned via `packageManager`; workflows rely on that, not a major-only
  version.

## TypeScript

- `tsconfig.base.json` is NodeNext + `strict` + `noUncheckedIndexedAccess` +
  `verbatimModuleSyntax`. Consequences: relative imports carry the `.js`
  extension, and type-only imports must use `import type`.
- Each package's `tsconfig.json` `include` must list `src`, `test`, and
  `vitest.config.ts` when one exists — otherwise type-aware lint fails on the
  config file.

## Lint

- ESLint 9 flat config, type-aware (`recommendedTypeChecked`).
  `no-floating-promises`, `no-misused-promises`, and `consistent-type-imports`
  are errors. Unused names must be prefixed `_` to be ignored.

## CI runtime vs. library target

- `packageManager` is pnpm 11, which needs Node >= 22.13. CI and the release
  workflow run on Node 22/24 only; a Node 20 matrix entry fails inside
  `actions/setup-node`'s pnpm cache step before any script runs, and
  `fail-fast` then cancels the healthy job too. Node 20 support of the
  published output comes from `tsup` `target: node20` and `engines`.

## `examples/`

- `examples/*` are workspace projects (`pnpm-workspace.yaml`), not packages.
  They exist so the code the guide points at cannot rot.
- **`private: true` on every one of them**, and an unscoped `yyt-example-*`
  name. That is the only thing keeping `pnpm -r publish` off them; see
  [release.md](release.md).
- **No `build` script**, so `pnpm -r build` skips them. A `typecheck` script is
  required, so `pnpm -r typecheck` covers them.
- Dependencies on `@yingyeothon/*` use `workspace:^`, like every package edge.
  Declare `lambda-gamebase`'s AWS SDK peers as devDependencies where an example
  imports it: without them pnpm warns on every install, and `skipLibCheck: true`
  would otherwise hide the missing peer inside `dist/index.d.ts`, so the example
  would compile while modelling a broken install.
- `tsconfig.json` is `{ "extends": "../../tsconfig.base.json", "include": ["src", "test"] }`.
  Every `.ts` file must be inside that `include`, or type-aware lint fails with
  "was not found by the project service".
- **An example must build with no AWS credentials, no Docker and no deployed
  gateway.** Infrastructure is opt-in behind an env var, and the zero-infra path
  is the one the docs describe.
- Do not add `"DOM"` to `tsconfig.base.json` for a browser-facing example. Reach
  the runtime global the way `gamebase-client` itself does, through a typed
  `globalThis` cast; the DOM lib is forbidden by
  [architecture.md](architecture.md).

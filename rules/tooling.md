# Toolchain, Build & CI

## Order of operations

- `pnpm build` first. `typecheck` and `test` resolve workspace dependency types
  through each package's `dist`, so a stale or missing build produces confusing
  `TS2307`/`TS7016` errors — especially right after a rename.
- CI (`.github/workflows/ci.yml`) runs, in order:
  install → build → lint → format:check → typecheck → coverage, on Node 20 and 22.
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

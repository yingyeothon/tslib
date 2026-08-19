# Package migration conventions (internal, temporary)

Rules for migrating a legacy library into `packages/<name>/` of this pnpm monorepo.

## Where things go

- Sources: `packages/<name>/src/`, public API re-exported from `src/index.ts` as **named exports only** (no default exports anywhere).
- Tests: `packages/<name>/test/*.test.ts` using **vitest** (`import { describe, expect, it, vi } from "vitest"`).
- Package README: `packages/<name>/README.md`, in **English**: one-paragraph purpose, install (`npm install @yingyeothon/<name>`), ESM and CJS usage snippets that match the real API, a "Public API" section listing every export, and a "Migrating from the legacy package" note when the API changed.
- `package.json` and `tsconfig.json` already exist — do NOT change `name`, `version`, `exports`, `files`, `scripts`, or dependency lists. (Only touch package.json if a truly required runtime dep is missing; then say so in your report.)

## Code style

- TypeScript 5.9 strict, base config uses `module: NodeNext`, `verbatimModuleSyntax`, `noUncheckedIndexedAccess`. Relative imports MUST use the `.js` extension (`import { x } from "./y.js"`), types via `import type`.
- Modern, minimal implementation: keep the observable behavior/API of the legacy code, but rewrite in modern syntax. Node >= 20: use global `fetch`, `crypto.randomUUID()`, `node:` prefixed builtin imports, `AbortController`, `structuredClone` where they simplify.
- Preserve behavior — this is a modernization, not a redesign, unless the migration notes for the package say otherwise.
- Follow `packages/logger/` as the style template.

## Verification loop (run all, from repo root unless noted)

1. Build: `cd packages/<name> && pnpm build` (tsup dual ESM+CJS+dts).
2. Typecheck: `cd packages/<name> && pnpm typecheck`.
3. Tests: `pnpm vitest run --project '@yingyeothon/<name>'` (root).
4. Coverage: `pnpm vitest run --coverage --project '@yingyeothon/<name>'` — target >= 90% lines for your package (hard floor 80% lines / 70% branches).
5. Lint: `pnpm lint` (root; must pass with zero errors).
6. Format: `pnpm exec prettier --write "packages/<name>/**"`.

Do NOT run `pnpm install`, do NOT commit, do NOT touch files outside `packages/<name>/`.

## Test quality

Port every existing legacy test (jest → vitest is mostly mechanical), then ADD tests until coverage target is met: error paths, timeout paths, edge cases. Tests must be deterministic — use fake timers (`vi.useFakeTimers()`) instead of real sleeps where possible.

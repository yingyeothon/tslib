# Repository Instructions

## Project Shape

- `tslib` is a pnpm workspace monorepo publishing 18 `@yingyeothon/*` TypeScript
  libraries (codec, logger, naive-socket/redis, repository, actor-system, lambda
  glue, gamebase) from `packages/*`, all sharing one version.
- Every package is a library: no app, no runtime entry point. Build output is
  dual ESM+CJS+types via tsup; Node >= 20.
- Source of truth documents:
  - `CONVENTIONS.md` — v2 API design rules (factories, options objects, logger,
    env injection). Canonical; do not restate or contradict it.
  - `README.md` — package list, dependency graph, dev commands, release flow.
  - Each `packages/<name>/README.md` — that package's public API surface.

## Required Rule Lookup

- Before non-trivial work, open `rules/index.md` and the relevant rule files.
- Keep this file short; put reusable lessons in `rules/`.
  (`AGENTS.md` is a symlink to this file — edit `CLAUDE.md` only.)
- After each completed task, update the relevant `rules/*.md` (and
  `rules/index.md` if files were added or removed).

## Essential Commands

```bash
pnpm install
pnpm build        # tsup, topological order — run before typecheck
pnpm typecheck    # tsc --noEmit per package (workspace types resolve from dist)
pnpm lint         # eslint, type-aware
pnpm format:check # prettier (CI fails on unformatted files)
pnpm test         # vitest across all packages (needs Docker for Redis)
pnpm coverage     # vitest with per-package v8 thresholds
```

## Non-Negotiables

- Follow `CONVENTIONS.md` and `rules/architecture.md` for every exported symbol.
- Never interpolate untrusted data into a wire protocol, and never log request
  events or credentials — see `rules/security.md`.
- No exported classes, no `process.env` reads in library code, no `console.*`.
- New or changed behavior ships with tests — see `rules/testing.md`.
- Manually verify against the built `dist` in both ESM and CJS —
  see `rules/manual-verification.md`.
- Follow the per-task completion ritual in `rules/workflow.md`.
- Never bump `version` in git; releases are tag-driven —
  see `rules/release.md`.

# Workflow

## Working agreement

- Commit directly to `main`; upstream is `git@github.com:yingyeothon/tslib.git`.
- Commit messages are English, imperative, one coherent purpose per commit.
  Last line: `Co-Authored-By: Claude <noreply@anthropic.com>`.
- Stage intentionally. Never `git add .` while `dist/`, `coverage/`, or
  `.claude/` artifacts are present (they are git-ignored — keep them that way).
- Large multi-package work may be delegated per package to subagents, but run
  `pnpm install` only from the main session so the lockfile cannot conflict.
- Talk to the user in Korean; write all repository content (code, comments,
  READMEs, rules, commit messages) in English.

## Per-task completion ritual

1. Make the change testable, then cover the new or changed behavior with tests
   ([testing.md](testing.md)).
2. Manually verify against the built `dist` in ESM and CJS
   ([manual-verification.md](manual-verification.md)).
3. Run three fresh-context subagents to adversarially review the change. This
   repo's real bugs (Redis protocol injection, credential logging, dev-only
   `@types/*` in public `.d.ts`) were all found this way, not by tests.
4. Apply the review feedback.
5. Fold durable lessons into `rules/*.md`; update `rules/index.md` if files
   changed.
6. Run the full green gate below, then commit and push to `main`.

## Green gate (must stay green)

```bash
pnpm install --frozen-lockfile
pnpm build         # 18 packages × ESM/CJS/DTS
pnpm lint          # 0 errors
pnpm format:check  # CI gate — run `pnpm format` before committing
pnpm typecheck     # only meaningful after pnpm build
pnpm coverage      # per-package thresholds must hold
```

Docker must be running (Redis testcontainers). Order matters: build before
typecheck/test, because workspace types resolve through each package's `dist`.

## Scope decisions already made

- Backward compatibility with the legacy standalone packages was deliberately
  dropped before v2.0.0. Do not reintroduce legacy deep-import entry points or
  old package names.
- Cleaning up the legacy repos and npm packages is the user's own task; do not
  touch other repositories under `~/git/yyt.life/`.

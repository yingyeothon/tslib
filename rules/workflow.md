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

## Task tracker — `todo/`

- Remaining work lives in the git-ignored, machine-local `todo/`.
  `todo/index.md` is the single entry point: an ordered "Next up" list (one
  line per file with its first concrete step), the session-start procedure,
  the base commit, and a "Waiting on user" list.
- One file per topic, `todo/<kebab-topic>.md`: why the work exists, which
  `rules/`/docs to read first (service contract docs by relative path
  `../service/...`), the change classification that selects the completion
  procedure, ordered checkboxes with key paths, and done-criteria. State and
  pointers only — facts and lessons go to `docs/` or `rules/`.
- When told to continue the remaining work, start from `todo/index.md`:
  confirm the base commit, reconcile commits that landed since, then apply the
  per-task completion ritual above.
- Tick items when done. Delete a file when it is fully done and drop its index
  line. Add a new file for newly discovered work.
- Never leave root-level todo files or scattered TODO comments.
- `todo/` is never committed, but this repo is public: keep it free of
  secrets and private infrastructure identifiers anyway.

## Green gate (must stay green)

```bash
pnpm install --frozen-lockfile
pnpm build         # 22 packages × ESM/CJS/DTS
pnpm lint          # 0 errors
pnpm format:check  # CI gate — run `pnpm format` before committing
pnpm typecheck     # only meaningful after pnpm build
pnpm coverage      # per-package thresholds must hold
```

Docker must be running (Redis testcontainers). Order matters: build before
typecheck/test, because workspace types resolve through each package's `dist`.

The same gate runs automatically from `.githooks/pre-push` (registered by the
`prepare` script via `core.hooksPath`), so `git push` fails locally instead of
in CI. Do not bypass it with `SKIP_CI_GATE=1` or `--no-verify` unless the user
explicitly asks; CI will still reject the push.

## Scope decisions already made

- Backward compatibility with the legacy standalone packages was deliberately
  dropped before v2.0.0. Do not reintroduce legacy deep-import entry points or
  old package names.
- Cleaning up the legacy repos and npm packages is the user's own task; do not
  touch other repositories under `~/git/yyt.life/`.

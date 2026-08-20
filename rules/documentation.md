# Documentation

## Package README structure

Every `packages/<name>/README.md` uses the same sections, in this order:

1. `# @yingyeothon/<name>` + a one-paragraph purpose statement.
2. `## Install`
3. `## Usage` — a runnable ESM snippet, then the CJS equivalent.
4. `## Public API` — must list the _actual_ named exports of `src/index.ts`.
5. `## Migrating from the legacy package` — old name/import → new name/import.

Keep examples short, runnable, and English. Match the depth and tone of the
existing READMEs rather than inventing a new format for one package.

## Keeping docs true

- When exports change, update that package's `## Public API` in the same commit.
  Drifted API listings were a real defect class here; a mechanical diff of
  `src/index.ts` exports against the README is worth running after API edits.
- When a workspace dependency edge changes, update both the package table and
  the mermaid graph in the root `README.md`.
- `CONVENTIONS.md` is canonical for API design. Point at it; do not duplicate or
  contradict it in package READMEs.
- Do not create temporary tracking documents in the repo root — they were
  removed once already. Session-scoped notes belong in `.claude/` (git-ignored).

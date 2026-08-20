# Rules Index

Compact, reusable lessons for agents working in this repository. Open only the
files relevant to the task at hand. `CLAUDE.md` (with `AGENTS.md` as its symlink) is the entry point;
`CONVENTIONS.md` (repo root) is the canonical API design document.

| File                                             | Open it when                                                                 |
| ------------------------------------------------ | ---------------------------------------------------------------------------- |
| [architecture.md](architecture.md)               | Adding/changing any exported symbol, package layout, or dependency edge      |
| [workflow.md](workflow.md)                       | Starting or finishing any task (includes the per-task completion ritual)     |
| [testing.md](testing.md)                         | Writing tests, touching mocks/testcontainers, or hitting coverage thresholds |
| [manual-verification.md](manual-verification.md) | Confirming a change actually works in a consumer, after tests pass           |
| [security.md](security.md)                       | Touching wire protocols, auth, or logging of request data                    |
| [tooling.md](tooling.md)                         | Build, typecheck, lint, format, or CI failures                               |
| [documentation.md](documentation.md)             | Editing any README or public API listing                                     |
| [release.md](release.md)                         | Versioning, publishing, or npm-facing changes                                |

## Maintenance

- After each completed task, fold new durable lessons into the matching file.
- Add a row here whenever a rule file is created or removed.
- Keep rules in English, compact, and imperative. Point at canonical docs
  instead of copying them.

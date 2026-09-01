# Documentation

Three layers, and each owns something the others must not restate.

| Layer                       | Owns                                                              | Kept true by      |
| --------------------------- | ----------------------------------------------------------------- | ----------------- |
| `docs/`                     | The guide: platform → token → a running actor → every feature     | `pnpm check:docs` |
| `packages/<name>/README.md` | That package's own reference: its exports, its options, its traps | `pnpm check:docs` |
| `README.md` (root)          | The package table and the exact dependency graph                  | `pnpm check:docs` |

The `service` repository owns the wire protocol, the auth endpoints, the channel
kinds and the console. Link to them; do not re-derive them. When this repository
and `gateway/README.md` disagree, that document is right, and the disagreement is
a bug here worth reporting.

## `docs/` — the guide

`docs/README.md` is the index and every other page must be reachable from it.
One fact, one owner: a duplicated limit or table drifts, and the drift is always
found by a reader who followed the wrong copy.

Current owners, so a new page does not take one over by accident. The
parenthesised names are the packages that page documents, and `check-docs.mjs`
asserts this list covers `packages/` exactly once each:

- `platform.md` — the whole yyt picture, the two channel kinds, the three
  storage shapes, and where tslib sits
- `getting-started.md` — the one ordered path, and nothing that is not on it
- `game-actor.md` — the actor: invocation lifecycle, the gateway contract, the
  stages, ending safely (`lambda-gamebase`, `gamebase-all-together`)
- `actor-system.md` — the generic substrate: queue, lock lease, awaiter, the
  Redis layouts, the Lambda shift (`actor-system`, `actor-system-redis`,
  `actor-system-lambda`)
- `realtime-client.md` — the browser client: states, close codes, backoff
  (`gamebase-client`)
- `storage.md` — repositories, revisions, CAS, documents, choosing a backend
  (`repository`, `repository-redis`, `repository-s3`, `repository-dynamodb`)
- `auth.md` — the channel JWT and the two authorizer shapes
  (`lambda-authorizer`, `lambda-authorizer-jwt`)
- `operations.md` — env injection, key prefixes and the ACL, every TTL,
  concurrency, sizing a run
- `logging.md` — composition, call style, and what must never be logged
  (`logger`, `logger-slack`, `logger-s3`)
- `redis-and-sockets.md` — the transport floor (`naive-socket`, `naive-redis`)
- `building-blocks.md` — the three small pieces everything else composes with
  (`codec`, `event-broker`, `s3-cache-bridge-client`)
- `troubleshooting.md` — symptom → the one check → the link. Not a second
  explanation

**Every package in `packages/` is owned by exactly one page in that list.** A new
package is not documented until a page claims it here and `docs/README.md` routes
to it.

### Page shape

1. `# Sentence-case heading`
2. Two or three lines saying what this page owns and what it defers to, with the
   link it defers to.
3. `## Topic sections`, each self-contained.
4. A closing line handing the reader to the next page by link.

Only `getting-started.md` numbers its headings (`## 1.` … `## 6.`); it is the
one page that is an ordered path.

### Prose

English, hard-wrapped at 88 columns, paragraphs rather than bullet fragments, and
a reason clause wherever a rule could look arbitrary. **Bold is reserved for the
trap the reader will otherwise get wrong** — not for emphasis, not for terms.

Concrete numbers always, written next to the option name they belong to. A bare
"30 seconds" is unverifiable; "`lockTimeoutSeconds`, default 30, heartbeated at a
third of that" is not. This is also what makes a drifted default findable.

Tables for anything enumerable. The third column is always "why you'd hit this".

Code samples are short, state their `import` preamble once per page, and carry
inline `//` comments rather than a paragraph after them.

Cross-links are relative markdown. A link to a section is written with a section
sign: `[Actor system § Leases](actor-system.md#leases)`. Links into `examples/`
point at `examples/<name>/README.md`, never at a source file inside it, so
renaming a file in an example cannot rot the guide.

## Package READMEs

Same sections, in this order:

1. `# @yingyeothon/<name>` and a one-paragraph purpose statement.
2. **One mermaid diagram of this package's mechanism**, with a one-line lead-in
   sentence above it. See "Diagrams" below.
3. `## Install`
4. `## Usage` — a runnable ESM snippet, then the CJS equivalent.
5. Any section the package genuinely needs (`## Tick policy`, `## Reconnect
policy`, `## Gateway integration contract`, `## Security`).
6. `## Public API` — must list the _actual_ named exports of `src/index.ts`.
7. `## Behavior changes`, when there are any.
8. `## Migrating from the legacy package` — old name/import → new name/import.

The diagram sits above `## Install` because it is orientation: a reader who
bounces at `## Usage` has still seen the mechanism. Keep the purpose paragraph
complete on its own — **npm's README renderer does not draw mermaid** and shows
the fence as plain text.

Keep examples short, runnable, and English. Match the depth and tone of the
existing READMEs rather than inventing a new format for one package.

## Diagrams

A diagram beats a paragraph whenever the subject is a shape, an order, or a
lifecycle. Prefer one; then write the prose the diagram does not carry, and
delete the prose it does.

| Type                  | Use it for                                             | Examples here                                                |
| --------------------- | ------------------------------------------------------ | ------------------------------------------------------------ |
| `flowchart` / `graph` | static structure, ownership, decision trees            | the platform picture, the backend choice, logger composition |
| `sequenceDiagram`     | an ordering contract, where the wrong order is the bug | the gateway↔actor keys, `$connect`, the CAS retry            |
| `stateDiagram-v2`     | a lifecycle with named states and a terminal state     | the actor invocation, the game stages, the client connection |
| `erDiagram`           | the shape of a stored record                           | the DynamoDB item                                            |
| `classDiagram`        | an interface family and what refines what              | the three repository interfaces                              |

Rules:

- **One diagram per H2 at most, one per package README.** A page that is mostly
  diagrams has no argument in it.
- Small: at most about twelve nodes, ten messages, or eight states. Split rather
  than shrink the labels. The one standing exception is a **routing map that has
  to be exhaustive to be useful** — `docs/README.md`'s page-owns-package diagram
  is deliberately one node per package, because a reader arriving from npm looks
  up a name in it and a partial list would send them away empty.
- Label every edge. An unlabelled arrow is a claim the reader has to guess.
- **No `style`, `classDef`, `fill`, or colour.** GitHub renders in both light and
  dark themes and a hard-coded colour is unreadable in one of them.
- `flowchart LR` for pipelines, `flowchart TD` for trees. Prefer `flowchart` over
  `graph` for new diagrams; the root `README.md` keeps `graph LR` because its
  dependency graph predates this rule.
- **Never name a flowchart node `end`.** It is a keyword there and it breaks the
  parse outright; `flowchart TD` with `running --> end` does not render. A
  `stateDiagram-v2` does accept it, but write `Ending` in both so the game's
  third stage reads the same wherever it appears.
- **Quote any label containing `(`, `)`, `:`, `,`, `{`, `}` or `#`** —
  `A["poll() returns undefined"]`. An unquoted parenthesis is the most common
  parse failure, and a failed block degrades silently into a grey code fence.
- The only HTML allowed inside a label is `<br/>`.
- Every diagram gets a one-line lead-in naming what it settles, so a renderer
  that does not draw it still leaves a readable page.
- `troubleshooting.md` gets **no diagrams**. Its contract is one cause and one
  check per symptom, and a diagram there is the second explanation the page
  exists to avoid.

When a package README and a guide page cover the same subject, they get
_different_ diagrams — static structure in the README, order or disposition in
the guide — and each links to the other. Four pairs are like this today:
`lambda-gamebase` (the key map) vs `game-actor.md` (the key sequence),
`gamebase-all-together` (one tick) vs `game-actor.md` (the stage machine),
`gamebase-client` (the two clients) vs `realtime-client.md` (states and close
codes), and `lambda-authorizer-jwt` (the verify decision) vs `auth.md` (the
`$connect` sequence). Do not unify them; the duplicate is what drifts.

## Examples

Runnable examples live in `examples/*` and are the code the guide points at. Each
is single-purpose and **runs with zero infrastructure by default**; Redis or a
deployed gateway is opt-in behind an env var. The full deployable stacks stay in
the sibling `service` repository (`examples/sample-dungeon`,
`examples/sample-morpg`) — do not duplicate them here.

Every example needs a `README.md` linked from `examples/README.md`, a docs page
that points at it, and a smoke test that runs it. See [tooling.md](tooling.md)
for the manifest rules and [testing.md](testing.md) for why an example cannot
move a coverage threshold.

**Links run one way: `docs/` points into `examples/`, and an example points at
package READMEs.** An example never links forward into `docs/`, so neither half
can be written into a state that fails the link gate while the other is still
being drafted.

**Namespace an example's environment variables `YYT_EXAMPLE_*`.** A bare
`REDIS_HOST` is already set to a real store in the environments this repository
is developed in, so an unnamespaced opt-in makes `pnpm start` reach for
production infrastructure on a machine that happens to have it exported.

## Keeping docs true

- **`pnpm check:docs` is the gate**, and it runs in CI and in the pre-push hook.
  It verifies that every mermaid fence parses; that every relative link and
  heading anchor resolves; that no `docs/` page is orphaned from
  `docs/README.md`; that every package has a README, a matching H1, a
  self-consistent `## Install` and a row in the root table; that the root mermaid
  graph equals the real `dependencies` edges; and that every named export of
  `src/index.ts` is mentioned in that README's `## Public API`.
- When exports change, update that package's `## Public API` in the same commit.
  Drifted API listings were a real defect class here, which is why the diff is
  now mechanical rather than a habit.
- When a workspace dependency edge changes, update both the package table and the
  mermaid graph in the root `README.md`.
- A number in the guide must also appear in the source or in the owning package
  README, next to the option name it belongs to.
- `CONVENTIONS.md` is canonical for API design. Point at it; do not duplicate or
  contradict it in package READMEs.
- Do not create temporary tracking documents in the repo root — they were removed
  once already. Session-scoped notes belong in `.claude/` (git-ignored).

## Writing the gate itself

`scripts/check-docs.mjs` is small and its mistakes are expensive, because a
false positive trains people to ignore it and a blind spot makes it decorative.
Three lessons already paid for:

- **Strip inline code spans before scanning links, and fences only before
  slugging headings.** A page that documents link syntax inside backticks is
  otherwise read as containing that link; and stripping spans from a heading
  turns `## The \`queue:\` segment` into an anchor nothing can match.
- **Scan the index files, not only the leaves.** `examples/README.md` was
  neither `examples/*/README.md` nor under `docs/`, so it was the one file
  nothing checked — and a dead link sat in it from the day it was created.
- **Break every gate on purpose before trusting it.** A gate that has never
  failed is not a gate. Each one here was confirmed by a deliberate edit that
  produced exactly one `FAIL:` line.

`mermaid.parse` needs a DOM that Node does not have, so a valid diagram rejects
with a `TypeError` from DOMPurify. A **grammar** failure throws a jison error
carrying `hash`, strictly earlier, so `error.hash !== undefined` is the
discriminator — not the message text.

## What a doc review actually catches

No check can see a claim that is plausible and wrong. For a substantial doc
change, run three fresh-context reviews: one checking every claim against the
source, one walking the guide as a newcomer with nothing installed, one cutting
redundancy between the guide and the package READMEs. The classes worth hunting:

- **A silent failure documented as an error.** Most of this repository's traps
  report nothing at all — a wrong queue key, a bare payload, a dropped broadcast,
  a retyped ACL prefix. If the guide says "you will see an error", check.
- **A diagram that is prettier than it is true.** A diagram makes a wrong claim
  more convincing, not less. Verify its arrows the way you verify a sentence.
- **A number without its option name**, which is how a default drifts out of the
  guide and stays there.

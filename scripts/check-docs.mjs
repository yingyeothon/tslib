#!/usr/bin/env node
// Usage: node scripts/check-docs.mjs
//
// Keeps the documentation honest about itself.
//
// Tests prove the code works; nothing proves the prose around it still does. A
// link that rots, a page nothing reaches, a diagram that silently stopped being
// a diagram, or a `## Public API` that lost an export are all invisible in
// review and all cheap to check. Every gate here failed on a real defect in
// this repository at least once, which is why they are checks and not
// conventions.
//
// Known limitations, stated rather than papered over: angle-bracket links
// (`[x](<a b.md>)`) and reference-style links (`[x][ref]`) are not matched, and
// gate 5 asserts an export is *mentioned* in its README, not that it is
// described.
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const failures = [];
const fail = (message) => failures.push(message);
const rel = (absolute) => relative(root, absolute) || ".";

const read = (path) => readFileSync(join(root, path), "utf8");
const dirsIn = (path) => {
  const absolute = join(root, path);
  if (!existsSync(absolute)) return [];
  return readdirSync(absolute)
    .filter((name) => statSync(join(absolute, name)).isDirectory())
    .sort();
};

const packages = dirsIn("packages");
// A leading underscore marks a scratch directory. Without this an untracked
// `examples/_probe/` — the obvious place to verify a snippet — fails the gate
// and therefore `.githooks/pre-push`, blocking every push until it is moved.
const examples = dirsIn("examples").filter((name) => !name.startsWith("_"));

/** Every markdown file this script is responsible for, repo-relative. */
const markdownFiles = () => {
  const files = ["README.md", "CONVENTIONS.md", "CLAUDE.md"];
  const walk = (path) => {
    const absolute = join(root, path);
    if (!existsSync(absolute)) return;
    for (const name of readdirSync(absolute).sort()) {
      const child = join(path, name);
      // AGENTS.md is a symlink to CLAUDE.md; following it double-reports.
      if (lstatSync(join(root, child)).isSymbolicLink()) continue;
      if (statSync(join(root, child)).isDirectory()) walk(child);
      else if (name.endsWith(".md")) files.push(child);
    }
  };
  walk("docs");
  walk("rules");
  for (const name of packages) files.push(`packages/${name}/README.md`);
  // The index itself, not only the leaves: a dead link sat in examples/README.md
  // precisely because it was the one markdown file nothing checked.
  files.push("examples/README.md");
  for (const name of examples) files.push(`examples/${name}/README.md`);
  return files.filter((path) => existsSync(join(root, path)));
};

/**
 * Blank out fenced blocks and inline code spans, preserving line count. Without
 * this a page that *documents* markdown link syntax — `[Page § Bit](p.md#bit)`,
 * which the guide's own conventions section does — is scanned as if it
 * contained that link, and the checker reports a file nobody meant to link.
 */
const stripFences = (source) => {
  // The opening delimiter is remembered, because a fence closes only on one of
  // the same character and at least as long. Toggling on any ``` desynced on a
  // ````-wrapped block containing one — silently accepting every dead link
  // after it — and ignoring ~~~ let a heading inside one become a real anchor.
  let fence = null;
  return source
    .split("\n")
    .map((line) => {
      const mark = /^\s*(`{3,}|~{3,})/.exec(line);
      if (fence === null) {
        if (mark) {
          fence = mark[1];
          return "";
        }
        return line;
      }
      if (mark && mark[1][0] === fence[0] && mark[1].length >= fence.length) {
        fence = null;
      }
      return "";
    })
    .join("\n");
};

/**
 * Fences plus inline code spans, for link scanning only.
 *
 * Headings must NOT go through this: `## The \`queue:\` segment` would lose the
 * word the anchor is named after, and every link to it would be reported dead.
 */
const stripCode = (source) =>
  stripFences(source)
    .split("\n")
    .map((line) => line.replace(/`[^`]*`/g, ""))
    .join("\n");

/** GitHub's heading slugs, including its `-1`/`-2` suffix for repeats. */
const anchorsOf = (source) => {
  const seen = new Map();
  const anchors = new Set();
  for (const line of stripFences(source).split("\n")) {
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (!heading) continue;
    const base = heading[1]
      .replace(/`/g, "")
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .toLowerCase()
      .replace(/[^a-z0-9 _-]/g, "")
      .trim()
      .replace(/\s+/g, "-");
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    anchors.add(count === 0 ? base : `${base}-${count}`);
  }
  return anchors;
};

/** The body of one `## Heading` section, or null when it is absent. */
const section = (source, heading) => {
  const lines = source.split("\n");
  const start = lines.findIndex((line) => line.trim() === heading);
  if (start === -1) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^## /.test(line));
  return (end === -1 ? rest : rest.slice(0, end)).join("\n");
};

/** A markdown inline link: `](<target>)` or `](target "title")`. */
const LINK = /\]\(\s*(?:<([^>]*)>|([^)\s]+))(?:\s+["'(][^)]*)?\s*\)/g;

/** Every ```mermaid block, with the line it starts on. */
const mermaidBlocks = (source) => {
  const blocks = [];
  const lines = source.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    if (!/^\s*```mermaid\s*$/.test(lines[i])) continue;
    const body = [];
    let j = i + 1;
    for (; j < lines.length && !/^\s*```\s*$/.test(lines[j]); j += 1) {
      body.push(lines[j]);
    }
    blocks.push({ line: i + 1, source: body.join("\n") });
    i = j;
  }
  return blocks;
};

// ---- 0. every mermaid fence parses ----------------------------------------
//
// A syntax error renders on GitHub as a grey code block with no error anywhere,
// so this is the one gate a reader cannot do for us. `mermaid.parse` needs a DOM
// to finish, which we do not have; a *grammar* failure throws a jison error
// carrying `hash` and happens strictly before that point, so `hash` is the
// discriminator. A later DOM failure means the grammar was fine.
let diagrams = 0;
{
  const { default: mermaid } = await import("mermaid");
  for (const file of markdownFiles()) {
    for (const block of mermaidBlocks(read(file))) {
      diagrams += 1;
      if (block.source.trim() === "") {
        fail(`${file}:${block.line} mermaid block is empty`);
        continue;
      }
      try {
        await mermaid.parse(block.source);
      } catch (error) {
        // Admit only the one failure we know is ours, not mermaid's: parsing
        // succeeds and then the sanitiser reaches for a DOM this process does
        // not have. Anything else is the diagram's fault.
        //
        // The first version of this excluded known-bad instead — "no `hash`,
        // so not a grammar error" — and `grpah TD` sailed through, because a
        // misspelled diagram type raises UnknownDiagramError, which carries no
        // `hash`. That is exactly the grey-code-block case this gate is for.
        const message = String(error?.message ?? error);
        if (/DOMPurify/.test(message)) continue;
        fail(
          `${file}:${block.line} mermaid block does not parse — ${message.split("\n")[0]}`,
        );
      }
    }
  }
}

// ---- 1. every relative link resolves, including its anchor -----------------
//
// http(s) links are somebody else's uptime. A dead *anchor* matters as much as a
// dead path: GitHub renders one as a jump to the top of the page, not an error.
let links = 0;
for (const file of markdownFiles()) {
  const from = dirname(join(root, file));
  // `[x](<a b.md>)` and `[x](page.md "title")` are both valid markdown that
  // GitHub renders. The first version rejected the one outright and never saw
  // the other, so a real file failed CI while a dead one passed.
  for (const match of stripCode(read(file)).matchAll(LINK)) {
    const target = match[1] ?? match[2];
    if (/^(https?:|mailto:|#)/.test(target)) continue;
    links += 1;
    const [path, fragment] = target.split("#");
    const destination = path ? resolve(from, path) : join(root, file);
    if (!existsSync(destination)) {
      fail(`${file} links to ${target}, which does not exist`);
      continue;
    }
    if (!fragment) continue;
    if (!destination.endsWith(".md")) {
      fail(`${file} links to ${target}, but an anchor needs a .md target`);
      continue;
    }
    if (!anchorsOf(readFileSync(destination, "utf8")).has(fragment)) {
      fail(
        `${file} links to ${target}, but ${rel(destination)} has no such heading`,
      );
    }
  }
}

// ---- 2. no orphan guide page ----------------------------------------------
//
// A page nothing links to is a page nobody reads. Matched by resolved path, not
// by the substring "(name.md", so a link to a same-named file elsewhere in the
// tree cannot satisfy it.
if (existsSync(join(root, "docs"))) {
  const index = "docs/README.md";
  if (!existsSync(join(root, index))) {
    fail(`${index} is missing; it is the guide index`);
  } else {
    const linked = new Set();
    for (const match of stripCode(read(index)).matchAll(LINK)) {
      const path = (match[1] ?? match[2]).split("#")[0];
      if (path && !/^(https?:|mailto:)/.test(path)) {
        linked.add(resolve(join(root, "docs"), path));
      }
    }
    for (const name of readdirSync(join(root, "docs")).sort()) {
      if (!name.endsWith(".md") || name === "README.md") continue;
      if (!linked.has(join(root, "docs", name))) {
        fail(`docs/${name} is not linked from ${index}`);
      }
    }
  }
}

// ---- 3. package and example READMEs, and the root table --------------------
const rootReadme = read("README.md");
{
  const tabled = new Set(
    [
      ...rootReadme.matchAll(
        /\|\s*\[@yingyeothon\/([a-z0-9-]+)\]\(packages\/([a-z0-9-]+)\)/g,
      ),
    ]
      .filter(([, linkName, path]) => linkName === path)
      .map(([, linkName]) => linkName),
  );
  for (const name of packages) {
    const readme = `packages/${name}/README.md`;
    if (!existsSync(join(root, readme))) {
      fail(`packages/${name} has no README.md`);
      continue;
    }
    const source = read(readme);
    const heading = source.split("\n")[0];
    if (heading !== `# @yingyeothon/${name}`) {
      fail(`${readme} starts with "${heading}", not "# @yingyeothon/${name}"`);
    }
    const install = section(source, "## Install");
    if (install === null) fail(`${readme} has no "## Install" section`);
    else if (!install.includes(`@yingyeothon/${name}`)) {
      fail(`${readme}'s "## Install" does not install @yingyeothon/${name}`);
    }
    if (!tabled.has(name)) fail(`packages/${name} is not in README.md's table`);
  }
  for (const name of tabled) {
    if (!packages.includes(name)) {
      fail(`README.md's package table lists packages/${name}, which is absent`);
    }
  }
}

if (examples.length > 0) {
  const index = "examples/README.md";
  if (!existsSync(join(root, index))) {
    fail(`${index} is missing; it is the examples index`);
  } else {
    const source = read(index);
    for (const name of examples) {
      if (!existsSync(join(root, `examples/${name}/README.md`))) {
        fail(`examples/${name} has no README.md`);
      }
      if (!source.includes(`${name}/README.md`)) {
        fail(`examples/${name} is not linked from ${index}`);
      }
      const manifest = join(root, `examples/${name}/package.json`);
      if (!existsSync(manifest)) {
        fail(`examples/${name} has no package.json`);
        continue;
      }
      const parsed = JSON.parse(readFileSync(manifest, "utf8"));
      // npm has no unpublish, so this one is worth stating twice.
      if (parsed.private !== true) {
        fail(`examples/${name}/package.json must set "private": true`);
      }
      if (String(parsed.name).startsWith("@yingyeothon/")) {
        fail(`examples/${name} must not use the @yingyeothon scope`);
      }
      if (parsed.scripts?.build) {
        fail(`examples/${name} must not define a "build" script`);
      }
      if (!parsed.scripts?.typecheck) {
        fail(`examples/${name} must define a "typecheck" script`);
      }
    }
  }
}

// ---- 4. the dependency graph equals the real edges -------------------------
//
// devDependencies are test-only and peerDependencies are not workspace edges,
// so only `dependencies` counts. The same pass asserts every cross-package
// range is `workspace:^`: a `workspace:*` publishes as an exact pin and forces
// consumers into lockstep upgrades (rules/architecture.md).
let edges = 0;
{
  const expected = new Set();
  for (const name of packages) {
    const manifest = JSON.parse(read(`packages/${name}/package.json`));
    for (const [dep, range] of Object.entries(manifest.dependencies ?? {})) {
      if (!dep.startsWith("@yingyeothon/")) continue;
      expected.add(`${name} --> ${dep.slice("@yingyeothon/".length)}`);
      if (range !== "workspace:^") {
        fail(
          `packages/${name} depends on ${dep} at "${range}", not workspace:^`,
        );
      }
    }
  }
  edges = expected.size;

  const fence = /```mermaid\n([\s\S]*?)```/.exec(rootReadme);
  if (!fence) fail("README.md has no mermaid dependency graph");
  else {
    const actual = new Set(
      fence[1]
        .split("\n")
        .map((line) => /^\s*([a-z0-9-]+)\s*-->\s*([a-z0-9-]+)\s*$/.exec(line))
        .filter(Boolean)
        .map(([, from, to]) => `${from} --> ${to}`),
    );
    for (const edge of expected) {
      if (!actual.has(edge)) {
        fail(`README.md's dependency graph is missing "${edge}"`);
      }
    }
    for (const edge of actual) {
      if (!expected.has(edge)) {
        fail(
          `README.md's dependency graph has "${edge}", which is not a dependency`,
        );
      }
    }
  }
}

// ---- 5. every named export is mentioned in ## Public API -------------------
//
// Drifted API listings are a recorded defect class here. This asserts an export
// is *mentioned*, not described: the existing READMEs legitimately group
// ("- Options types: `A`, `B`, ...") and demanding a bullet each would make
// them worse.
let exportCount = 0;
for (const name of packages) {
  const indexPath = `packages/${name}/src/index.ts`;
  const readmePath = `packages/${name}/README.md`;
  if (
    !existsSync(join(root, indexPath)) ||
    !existsSync(join(root, readmePath))
  ) {
    continue;
  }
  const source = read(indexPath)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

  // This checker cannot see through either, and both are already forbidden.
  if (/^export\s+\*/m.test(source)) {
    fail(
      `${indexPath} uses "export *"; check-docs cannot verify its Public API`,
    );
    continue;
  }
  if (/^export\s+default\b/m.test(source)) {
    fail(`${indexPath} uses "export default"; named exports only`);
    continue;
  }

  const names = new Set();
  for (const block of source.matchAll(/export\s+(?:type\s+)?\{([^}]*)\}/g)) {
    for (const specifier of block[1].split(",")) {
      const cleaned = specifier.replace(/\btype\s+/g, "").trim();
      if (!cleaned) continue;
      const parts = cleaned.split(/\s+as\s+/);
      const exported = (parts[1] ?? parts[0]).trim();
      if (/^[A-Za-z_$][\w$]*$/.test(exported)) names.add(exported);
    }
  }
  for (const declaration of source.matchAll(
    /^export\s+(?:declare\s+)?(?:async\s+)?(?:abstract\\s+)?(?:function\\s*\\*?|const|let|var|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/gm,
  )) {
    names.add(declaration[1]);
  }
  exportCount += names.size;

  const publicApi = section(read(readmePath), "## Public API");
  if (publicApi === null) {
    fail(`${readmePath} has no "## Public API" section`);
    continue;
  }
  const missing = [...names].filter(
    // `\b` before a `$` never matches, so a `$`-prefixed export could never be
    // reported as documented — an unfixable CI failure waiting to happen.
    (exported) =>
      !new RegExp(
        `(^|[^\\w$])${exported.replace(/\$/g, "\\$")}([^\\w$]|$)`,
      ).test(publicApi),
  );
  if (missing.length > 0) {
    fail(
      `${readmePath} "## Public API" does not mention: ${missing.join(", ")}`,
    );
  }
}

// ---- 6. exactly one diagram in every package README, above ## Install ------
//
// One, not "at least one": rules/documentation.md fixes the section order, and
// the diagram is the newest part of it and so the easiest to drop in a rewrite.
for (const name of packages) {
  const readme = `packages/${name}/README.md`;
  const source = read(readme);
  const blocks = mermaidBlocks(source);
  if (blocks.length !== 1) {
    fail(
      `${readme} must carry exactly one mermaid diagram, not ${blocks.length}`,
    );
    continue;
  }
  const install = source.split("\n").findIndex((line) => line === "## Install");
  const first = blocks[0];
  if (install !== -1 && first !== undefined && first.line > install) {
    fail(`${readme}'s diagram must sit above "## Install"`);
  }
}

// ---- 7. every close code the SDK knows reaches the page that lists them ----
//
// The disposition table is the one place a reader looks. A code added to
// close-codes.ts and not to the guide is a code nobody handles.
{
  const source = "packages/gamebase-client/src/close-codes.ts";
  const page = "docs/realtime-client.md";
  if (existsSync(join(root, source)) && existsSync(join(root, page))) {
    const listed = read(page);
    for (const match of read(source).matchAll(
      /^\s{2}([a-zA-Z][\w$]*):\s*(\d{4}),/gm,
    )) {
      const [, name, code] = match;
      if (!listed.includes(String(code))) {
        fail(`${page} never mentions close code ${code} (${name})`);
      }
    }
  }
}

// ---- 8. the repository writes in English -----------------------------------
//
// The project is worked on in Korean and written in English; a stray sentence
// in the wrong one is easy to miss in review and impossible to miss for a
// reader. The root README's one Korean gloss is deliberate and out of scope.
for (const file of markdownFiles()) {
  // The root README's one Korean gloss is deliberate; everything else — rules
  // and examples included, which the first version skipped — is English. Prose
  // only: a Korean string literal inside a code sample is data, not writing.
  if (file === "README.md") continue;
  const hangul = /[\u3131-\u318E\uAC00-\uD7A3]/.exec(stripFences(read(file)));
  if (hangul) {
    fail(
      `${file} contains Hangul ("${hangul[0]}") outside a code block; ` +
        "this repository writes English",
    );
  }
}

// ---- 9. every workspace project outside packages/ is unpublishable --------
//
// npm has no unpublish, so this is worth checking from the workspace file
// rather than from a directory listing: adding a glob is the one edit that
// could carry something new into `pnpm -r publish` without touching anything
// else this script looks at.
{
  const workspace = read("pnpm-workspace.yaml");
  const globs = [...workspace.matchAll(/^\s*-\s*["']?([^"'\s]+)["']?\s*$/gm)]
    .map((match) => match[1])
    .filter((glob) => glob.endsWith("/*"));
  for (const glob of globs) {
    const dir = glob.slice(0, -2);
    if (dir === "packages") continue;
    for (const name of dirsIn(dir)) {
      if (name.startsWith("_")) continue;
      const manifestPath = join(root, dir, name, "package.json");
      if (!existsSync(manifestPath)) continue;
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      if (manifest.private !== true) {
        fail(`${dir}/${name} is in the workspace and is not "private": true`);
      }
      if (String(manifest.name).startsWith("@yingyeothon/")) {
        fail(`${dir}/${name} is in the workspace and uses the published scope`);
      }
    }
  }
}

// ---------------------------------------------------------------------------
for (const message of failures) console.error(`FAIL: ${message}`);
if (failures.length > 0) {
  console.error(`\ndocs: ${failures.length} problem(s)`);
  process.exit(1);
}
console.log(
  `docs: ${diagrams} mermaid diagrams parse, ${links} relative links resolve, ` +
    `${packages.length} package READMEs cover ${exportCount} exports, ` +
    `${edges} dependency edges match the graph, no orphan page`,
);

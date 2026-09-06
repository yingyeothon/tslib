#!/usr/bin/env node
// Usage: node scripts/release-summary.mjs <version> <retry:true|false>
//
// Prints the Markdown that the Release workflow appends to its run summary:
// the version, the commit and tag it points at, whether this run was a
// publish retry, and one row per package saying whether that exact version is
// on npm now. Each row is checked against the registry rather than inferred
// from the publish step's exit code, so a partial failure is recorded as it
// is: the packages that landed say `published`, the rest say `missing`.
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const [version, retry] = process.argv.slice(2);
if (!version) {
  console.error("usage: release-summary.mjs <version> <retry>");
  process.exit(2);
}

const root = new URL("..", import.meta.url).pathname;
const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root })
  .toString()
  .trim();
const packages = readdirSync(join(root, "packages"))
  .sort()
  .map((dir) => {
    const manifest = JSON.parse(
      readFileSync(join(root, "packages", dir, "package.json"), "utf8"),
    );
    return { dir, name: manifest.name, stamped: manifest.version };
  });

/** The registry's answer for `name@version`, or `""` when it is not there. */
function onNpm(name) {
  try {
    return execFileSync("npm", ["view", `${name}@${version}`, "version"], {
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
  } catch {
    return "";
  }
}

const rows = packages.map((p) => ({
  ...p,
  status: onNpm(p.name) === version ? "published" : "missing",
}));
const missing = rows.filter((r) => r.status === "missing");

const lines = [
  `## Release v${version}`,
  "",
  `| | |`,
  `| --- | --- |`,
  `| Version | \`${version}\` |`,
  `| Tag | \`v${version}\` |`,
  `| Commit | \`${sha}\` |`,
  `| Publish retry | ${retry === "true" ? "yes (existing tag re-run)" : "no"} |`,
  `| Packages on npm at this version | ${rows.length - missing.length} / ${rows.length} |`,
  "",
  `| Package | Stamped | npm |`,
  `| --- | --- | --- |`,
  ...rows.map(
    (r) =>
      `| \`${r.name}\` | \`${r.stamped}\` | ${r.status === "published" ? "✅ published" : "❌ missing"} |`,
  ),
  "",
];
if (missing.length > 0) {
  lines.push(
    `> ${missing.length} package(s) did not reach npm at \`${version}\`. ` +
      `Re-run this workflow with the same version: it checks out tag \`v${version}\` ` +
      `and \`pnpm -r publish\` skips the packages already there.`,
    "",
  );
}
process.stdout.write(lines.join("\n"));

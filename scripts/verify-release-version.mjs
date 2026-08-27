#!/usr/bin/env node
// Usage: node scripts/verify-release-version.mjs <version>
// Refuses a release version that is not a stable semver, already exists as a
// git tag (unless that tag already carries this version, i.e. a publish retry),
// or does not exceed every version already published on npm for any package.
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const version = process.argv[2];
if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
  console.error(
    `Release version must be stable semver (x.y.z): ${version ?? "(none)"}`,
  );
  process.exit(1);
}

const compare = (a, b) => {
  const [pa, pb] = [a, b].map((v) => v.split(/[-+]/)[0].split(".").map(Number));
  for (let i = 0; i < 3; i += 1) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
};

const run = (cmd, args) =>
  execFileSync(cmd, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();

const tag = `v${version}`;
let tagExists = false;
try {
  run("git", ["rev-parse", "--verify", "--quiet", `refs/tags/${tag}`]);
  tagExists = true;
} catch {
  /* tag absent */
}

const packagesDir = new URL("../packages", import.meta.url).pathname;
const manifests = readdirSync(packagesDir).map((name) =>
  JSON.parse(readFileSync(join(packagesDir, name, "package.json"), "utf8")),
);

if (tagExists) {
  const stamped = manifests.every((m) => m.version === version);
  if (!stamped) {
    console.error(
      `Tag ${tag} already exists but the checked-out packages are not ${version}`,
    );
    process.exit(1);
  }
  console.log(
    `Tag ${tag} exists and matches the workspace: treating this run as a publish retry`,
  );
}

let failed = false;
for (const { name } of manifests) {
  let published = [];
  try {
    published = JSON.parse(run("npm", ["view", name, "versions", "--json"]));
    if (typeof published === "string") published = [published];
  } catch {
    console.log(`${name}: not on npm yet`);
    continue;
  }
  const highest = published.reduce((a, b) => (compare(a, b) >= 0 ? a : b));
  if (published.includes(version) && tagExists) {
    console.log(
      `${name}: ${version} already published (will be skipped by pnpm)`,
    );
  } else if (published.includes(version)) {
    console.error(
      `${name}: ${version} is already on npm and no release tag exists`,
    );
    failed = true;
  } else if (compare(version, highest) <= 0) {
    console.error(`${name}: ${version} does not exceed published ${highest}`);
    failed = true;
  } else {
    console.log(`${name}: ${highest} -> ${version}`);
  }
}
if (failed) process.exit(1);

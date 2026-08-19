#!/usr/bin/env node
// Usage: node scripts/set-version.mjs <version>
// Stamps <version> into every packages/*/package.json (workspace ranges stay intact;
// pnpm publish rewrites them to real semver at publish time).
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const version = process.argv[2];
if (!version || !/^\d+\.\d+\.\d+(-[0-9A-Za-z-.]+)?$/.test(version)) {
  console.error(`Invalid or missing version: ${version ?? "(none)"}`);
  process.exit(1);
}

const packagesDir = new URL("../packages", import.meta.url).pathname;
for (const name of readdirSync(packagesDir)) {
  const manifestPath = join(packagesDir, name, "package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.version = version;
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  console.log(`${manifest.name}@${version}`);
}

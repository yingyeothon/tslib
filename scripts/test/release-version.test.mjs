import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const currentVersion = JSON.parse(
  readFileSync(
    new URL("../../packages/game-kit/package.json", import.meta.url),
    "utf8",
  ),
).version;

const script = fileURLToPath(
  new URL("../verify-release-version.mjs", import.meta.url),
);

// Exercise the real CLI without publishing, querying npm, or changing manifests.
// Only the two external commands are replaced; package discovery stays real.
function verify({ requested = "2.4.0", published, tagged = false }) {
  const directory = mkdtempSync(join(tmpdir(), "tslib-release-version-"));
  try {
    writeFileSync(
      join(directory, "npm"),
      `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(JSON.stringify(published))});\n`,
      { mode: 0o700 },
    );
    writeFileSync(
      join(directory, "git"),
      `#!/usr/bin/env node\nprocess.exit(${tagged ? 0 : 1});\n`,
      { mode: 0o700 },
    );
    const result = spawnSync(process.execPath, [script, requested], {
      encoding: "utf8",
      env: { ...process.env, PATH: directory + delimiter + process.env.PATH },
    });
    assert.ifError(result.error);
    return { status: result.status, output: result.stdout + result.stderr };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("permits stable release after its same-core bootstrap prerelease", () => {
  const result = verify({ published: ["2.3.0", "2.4.0-bootstrap.0"] });
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /2\.4\.0-bootstrap\.0 -> 2\.4\.0/);
});

test("refuses a release below a newer prerelease", () => {
  const result = verify({ published: ["2.3.0", "2.5.0-bootstrap.0"] });
  assert.equal(result.status, 1);
  assert.match(result.output, /does not exceed published 2\.5\.0-bootstrap\.0/);
});

test("refuses already-published stable version without its release tag", () => {
  for (const published of [
    ["2.4.0", "2.4.0-bootstrap.0"],
    ["2.4.0-bootstrap.0", "2.4.0"],
  ]) {
    const result = verify({ published });
    assert.equal(result.status, 1);
    assert.match(result.output, /already on npm and no release tag exists/);
  }
});

test("does not let a later bootstrap hide a higher stable publication", () => {
  const result = verify({ published: ["2.5.0", "2.4.0-bootstrap.0"] });
  assert.equal(result.status, 1);
  assert.match(result.output, /does not exceed published 2\.5\.0/);
});

test("keeps publish retry when the tag and checked-out manifests match", () => {
  const result = verify({
    requested: currentVersion,
    published: currentVersion,
    tagged: true,
  });
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /treating this run as a publish retry/);
  assert.match(result.output, /already published/);
});

test("refuses a tag for a version absent from the checked-out manifests", () => {
  const requested = currentVersion === "999.0.0" ? "998.0.0" : "999.0.0";
  const result = verify({
    requested,
    published: [currentVersion],
    tagged: true,
  });
  assert.equal(result.status, 1);
  assert.ok(
    result.output.includes(`checked-out packages are not ${requested}`),
  );
});

test("rejects prerelease workflow input", () => {
  const result = verify({
    requested: "2.4.0-bootstrap.0",
    published: ["2.3.0"],
  });
  assert.equal(result.status, 1);
  assert.match(result.output, /Release version must be stable semver/);
});

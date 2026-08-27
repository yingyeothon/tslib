#!/usr/bin/env bash
# One-off manual publish for package names that do not exist on npm yet.
# npm Trusted Publishing can only be configured on an existing package, so a
# brand-new name needs exactly one publish from a logged-in account first.
#
# Usage: scripts/bootstrap-publish.sh <version> <package-dir>...
#   e.g. scripts/bootstrap-publish.sh 0.1.0 gamebase-client logger-slack
#
# Stamps <version> temporarily, builds, publishes only the listed packages
# under the `bootstrap` dist-tag (so `latest` is left for the real release),
# and restores package.json files afterwards. Nothing is committed or tagged:
# this is a placeholder publish, not a release of the workspace.
set -euo pipefail

version="${1:?version required}"
shift
[[ $# -gt 0 ]] || { echo "at least one package dir required" >&2; exit 1; }

root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"

if [[ -n "$(git status --porcelain packages/*/package.json)" ]]; then
  echo "packages/*/package.json must be clean before bootstrapping" >&2
  exit 1
fi
npm whoami >/dev/null || { echo "run 'npm login' first" >&2; exit 1; }

restore() { git checkout -- packages/*/package.json; }
trap restore EXIT

node scripts/set-version.mjs "$version"
pnpm build

for dir in "$@"; do
  name="$(node -p "require('./packages/$dir/package.json').name")"
  if npm view "$name" version >/dev/null 2>&1; then
    echo "$name already exists on npm; skipping (use the Release workflow instead)" >&2
    continue
  fi
  pnpm --filter "$name" publish --access public --no-git-checks --tag bootstrap
done

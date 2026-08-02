#!/usr/bin/env bash
#
# Bump the app version in lockstep across every manifest that must agree:
#   - package.json
#   - src-tauri/Cargo.toml   (the [package] version)
#   - src-tauri/Cargo.lock   (the local package entry)
#   - src-tauri/tauri.conf.json
#
# The updater compares the running app's version (from tauri.conf.json) against
# the version in the published latest.json, so these MUST match or auto-update
# won't trigger. Usage:
#
#   scripts/bump-version.sh 1.0.1
#
# After running, commit, then tag `v<version>` to trigger the release workflow.
set -euo pipefail

if [ $# -ne 1 ]; then
  echo "usage: $0 <semver>   e.g. $0 1.0.1" >&2
  exit 1
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
VERSION="$1"

python3 scripts/release_preflight.py validate-version "$VERSION"
python3 scripts/release_preflight.py set-version "$VERSION"
python3 scripts/release_preflight.py check --no-git --skip-changelog

echo "Bumped to $VERSION in:"
echo "  package.json           -> $(grep -m1 '"version"' package.json | tr -d ' ,')"
echo "  src-tauri/tauri.conf.json -> $(grep -m1 '"version"' src-tauri/tauri.conf.json | tr -d ' ,')"
echo "  src-tauri/Cargo.toml   -> $(grep -m1 '^version' src-tauri/Cargo.toml | tr -d ' ')"
echo "  src-tauri/Cargo.lock   -> $(sed -n '/name = "ccie-terminal"/{n;p;q;}' src-tauri/Cargo.lock | tr -d ' ')"
echo
echo "Next: review the diff, commit, create an annotated tag, then push only it:"
echo "  git tag -a v$VERSION -m 'TerminAI v$VERSION'"
echo "  git push origin v$VERSION"

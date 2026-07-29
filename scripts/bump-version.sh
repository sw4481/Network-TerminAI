#!/usr/bin/env bash
#
# Bump the app version in lockstep across all three manifests that must agree:
#   - package.json
#   - src-tauri/Cargo.toml   (the [package] version)
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

VERSION="$1"
if ! echo "$VERSION" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+([-.+][0-9A-Za-z.]+)?$'; then
  echo "error: '$VERSION' is not a valid semver" >&2
  exit 1
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# package.json — first top-level "version" key.
perl -0pi -e 's/("version"\s*:\s*")[^"]+(")/${1}'"$VERSION"'${2}/ if !$done++;' package.json

# tauri.conf.json — top-level "version" key (line 4, but match structurally).
perl -0pi -e 's/("version"\s*:\s*")[^"]+(")/${1}'"$VERSION"'${2}/ if !$done++;' src-tauri/tauri.conf.json

# Cargo.toml — the version line inside [package] (the first `version = "..."`).
perl -0pi -e 's/^(version\s*=\s*")[^"]+(")/${1}'"$VERSION"'${2}/m if !$done++;' src-tauri/Cargo.toml

echo "Bumped to $VERSION in:"
echo "  package.json           -> $(grep -m1 '"version"' package.json | tr -d ' ,')"
echo "  src-tauri/tauri.conf.json -> $(grep -m1 '"version"' src-tauri/tauri.conf.json | tr -d ' ,')"
echo "  src-tauri/Cargo.toml   -> $(grep -m1 '^version' src-tauri/Cargo.toml | tr -d ' ')"
echo
echo "Next: review the diff, commit, then:  git tag v$VERSION && git push --tags"

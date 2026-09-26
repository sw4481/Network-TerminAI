#!/usr/bin/env bash
# Check only Rust files changed by this push/PR; legacy files stay out of scope.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

BASE_REF="${1:-}"
HEAD_REF="${2:-HEAD}"

if [[ -z "$BASE_REF" || "$BASE_REF" =~ ^0+$ ]]; then
  if git rev-parse --verify "${HEAD_REF}^" >/dev/null 2>&1; then
    BASE_REF="${HEAD_REF}^"
  else
    echo "rustfmt: no parent commit; nothing to compare"
    exit 0
  fi
fi

if ! git rev-parse --verify "$HEAD_REF" >/dev/null 2>&1; then
  echo "error: rustfmt head ref is unavailable: $HEAD_REF" >&2
  exit 1
fi

if ! git rev-parse --verify "$BASE_REF" >/dev/null 2>&1; then
  if git rev-parse --verify "${HEAD_REF}^" >/dev/null 2>&1; then
    echo "rustfmt: base ref unavailable; using head parent"
    BASE_REF="${HEAD_REF}^"
  else
    echo "rustfmt: no comparable base; nothing to compare"
    exit 0
  fi
fi

if ! MERGE_BASE="$(git merge-base "$BASE_REF" "$HEAD_REF")"; then
  if git rev-parse --verify "${HEAD_REF}^" >/dev/null 2>&1; then
    echo "rustfmt: no merge base; using head parent"
    MERGE_BASE="${HEAD_REF}^"
  else
    echo "rustfmt: no comparable base; nothing to compare"
    exit 0
  fi
fi
files=()
while IFS= read -r -d '' path; do
  if [[ "$path" == src-tauri/* && "$path" == *.rs ]]; then
    files+=("$path")
  fi
done < <(git diff --name-only --diff-filter=ACMR -z "$MERGE_BASE" "$HEAD_REF" -- src-tauri)

if (( ${#files[@]} == 0 )); then
  echo "rustfmt: no changed Rust files"
  exit 0
fi

status=0
for path in "${files[@]}"; do
  # `lib.rs` and `mod.rs` normally make rustfmt recurse into every child
  # module. That would turn one changed file back into a repository-wide gate.
  if ! rustfmt --edition 2021 --config skip_children=true --check "$path"; then
    status=1
  fi
done

if (( status != 0 )); then
  echo "error: changed Rust files are not formatted" >&2
  exit "$status"
fi
echo "rustfmt OK: ${#files[@]} changed Rust file(s)"

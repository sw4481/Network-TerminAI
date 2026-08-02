#!/usr/bin/env bash
# Fail without echoing values when any credential/variable required to publish is absent.
set -euo pipefail

required=(
  TAURI_SIGNING_PRIVATE_KEY
  TAURI_SIGNING_PRIVATE_KEY_PASSWORD
  TERMINAI_GITHUB_CLIENT_ID
)

missing=()
for name in "${required[@]}"; do
  if [[ -z "${!name:-}" ]]; then
    missing+=("$name")
  fi
done

if (( ${#missing[@]} > 0 )); then
  printf 'error: missing release secrets or variables:\n' >&2
  printf '  %s\n' "${missing[@]}" >&2
  exit 1
fi

echo "release credential preflight OK"

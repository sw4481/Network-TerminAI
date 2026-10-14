#!/usr/bin/env bash
# Sign source native resources before Tauri copies them and seals the outer app.
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "macOS resource signing skipped on this platform"
  exit 0
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exec "${PYTHON:-python3}" -I "$ROOT/scripts/sign_macos_resources.py" "$ROOT/sidecar/dist/python"

#!/usr/bin/env bash
# Prove the configured public updater key verifies signatures from the CI private key.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [[ -z "${TAURI_SIGNING_PRIVATE_KEY:-}" ]]; then
  echo "error: TAURI_SIGNING_PRIVATE_KEY is not set" >&2
  exit 1
fi
if [[ -z "${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}" ]]; then
  echo "error: TAURI_SIGNING_PRIVATE_KEY_PASSWORD is not set" >&2
  exit 1
fi
if ! command -v minisign >/dev/null 2>&1; then
  echo "error: minisign is required to verify the updater keypair" >&2
  exit 1
fi

work_dir="$(mktemp -d)"
cleanup() {
  rm -rf "$work_dir"
}
trap cleanup EXIT

printf 'TerminAI updater key verification\n' > "$work_dir/probe"
bun tauri signer sign "$work_dir/probe" >/dev/null 2>&1

python3 - "$work_dir/probe.sig" "$work_dir/probe.minisig" \
  "$work_dir/public.key" <<'PY'
import base64
import json
import sys
from pathlib import Path

encoded_signature = Path(sys.argv[1]).read_text(encoding="utf-8").strip()
Path(sys.argv[2]).write_bytes(base64.b64decode(encoded_signature, validate=True))

config = json.loads(Path("src-tauri/tauri.conf.json").read_text(encoding="utf-8"))
encoded_public_key = config["plugins"]["updater"]["pubkey"]
Path(sys.argv[3]).write_bytes(base64.b64decode(encoded_public_key, validate=True))
PY

minisign -Vm "$work_dir/probe" \
  -x "$work_dir/probe.minisig" \
  -p "$work_dir/public.key" \
  -q >/dev/null 2>&1

echo "updater signing keypair verification OK"

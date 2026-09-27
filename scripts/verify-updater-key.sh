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
if ! command -v openssl >/dev/null 2>&1; then
  echo "error: openssl is required to verify the updater keypair" >&2
  exit 1
fi

work_dir="$(mktemp -d)"
cleanup() {
  rm -rf "$work_dir"
}
trap cleanup EXIT

printf 'TerminAI updater key verification\n' > "$work_dir/probe"
bun tauri signer sign "$work_dir/probe" >/dev/null 2>&1

python3 - "$work_dir/probe" "$work_dir/probe.sig" "$work_dir/public.der" \
  "$work_dir/signature.bin" "$work_dir/probe.blake2b" <<'PY'
import base64
import hashlib
import json
import sys
from pathlib import Path

probe_path, signature_b64, public_der, signature_bin, digest_path = sys.argv[1:]
config = json.loads(Path("src-tauri/tauri.conf.json").read_text(encoding="utf-8"))
public_key_text = base64.b64decode(
    config["plugins"]["updater"]["pubkey"], validate=True
).decode("utf-8")
public_key_lines = public_key_text.strip().splitlines()
if len(public_key_lines) < 2:
    raise SystemExit("invalid updater public key")
public_key_blob = base64.b64decode(public_key_lines[1], validate=True)
if len(public_key_blob) != 42 or public_key_blob[:2] != b"Ed":
    raise SystemExit("invalid updater public key")

signature_text = base64.b64decode(
    Path(signature_b64).read_text(encoding="utf-8").strip(), validate=True
).decode("utf-8")
signature_lines = signature_text.strip().splitlines()
if len(signature_lines) < 2:
    raise SystemExit("invalid updater signature")
signature_blob = base64.b64decode(signature_lines[1], validate=True)
if len(signature_blob) != 74 or signature_blob[:2] != b"ED":
    raise SystemExit("invalid updater signature")

Path(public_der).write_bytes(bytes.fromhex("302a300506032b6570032100") + public_key_blob[10:])
Path(signature_bin).write_bytes(signature_blob[10:74])
Path(digest_path).write_bytes(
    hashlib.blake2b(Path(probe_path).read_bytes(), digest_size=64).digest()
)
PY

openssl pkeyutl -verify -rawin -pubin -keyform DER \
  -inkey "$work_dir/public.der" \
  -sigfile "$work_dir/signature.bin" \
  -in "$work_dir/probe.blake2b" >/dev/null

echo "updater signing keypair verification OK"

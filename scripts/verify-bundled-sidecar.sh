#!/usr/bin/env bash
# Extract one installer and prove its bundled Python can import and ping ccie_sidecar.
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "usage: $0 <macos|windows|linux> <installer>" >&2
  exit 1
fi

PLATFORM="$1"
BUNDLE="$2"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOST_PYTHON="${PYTHON:-python}"

if [[ ! -f "$BUNDLE" ]]; then
  echo "error: installer does not exist: $BUNDLE" >&2
  exit 1
fi
BUNDLE="$(cd "$(dirname "$BUNDLE")" && pwd)/$(basename "$BUNDLE")"

work_dir="$(mktemp -d)"
mounted_path=""
cleanup() {
  if [[ -n "$mounted_path" ]]; then
    hdiutil detach "$mounted_path" -quiet || true
  fi
  rm -rf "$work_dir"
}
trap cleanup EXIT

run_smoke() {
  local bundled_python="$1"
  local expected_root="$2"
  if [[ -z "$bundled_python" || ! -f "$bundled_python" ]]; then
    echo "error: installer has no bundled Python executable" >&2
    exit 1
  fi
  PYTHONDONTWRITEBYTECODE=1 "$HOST_PYTHON" -I "$ROOT/sidecar/scripts/smoke_portable_sidecar.py" \
    "$bundled_python" \
    --expected-root "$expected_root"
}

case "$PLATFORM" in
  macos)
    case "$BUNDLE" in
      *.dmg)
        mounted_path="$work_dir/mount"
        mkdir -p "$mounted_path"
        hdiutil attach -nobrowse -readonly -mountpoint "$mounted_path" "$BUNDLE" >/dev/null
        extract_dir="$mounted_path"
        ;;
      *.app.tar.gz)
        extract_dir="$work_dir/updater"
        mkdir -p "$extract_dir"
        # Isolated extraction; the data filter rejects escaping paths/links
        # and special files, while retaining portable Python's internal links.
        "$HOST_PYTHON" -I - "$BUNDLE" "$extract_dir" <<'PY'
import sys
import tarfile

with tarfile.open(sys.argv[1], "r:gz") as archive:
    archive.extractall(sys.argv[2], filter="data")
PY
        ;;
      *)
        echo "error: unsupported macOS bundle: $BUNDLE" >&2
        exit 1
        ;;
    esac
    app_path="$(find "$extract_dir" -maxdepth 2 -type d -name '*.app' -print -quit)"
    if [[ -z "$app_path" ]]; then
      echo "error: artifact has no application bundle" >&2
      exit 1
    fi
    resource_root="$app_path/Contents/Resources/python"
    "$HOST_PYTHON" -I - "$app_path" "$resource_root" <<'PY'
import sys
from pathlib import Path

app, resources = (Path(arg).resolve(strict=True) for arg in sys.argv[1:])
if not resources.is_relative_to(app):
    raise SystemExit("error: Python resource root resolves outside the app")
PY
    # --deep verifies the outer seal, but arbitrary resource-tree native code
    # also needs explicit verification. Neither step re-signs the artifact.
    codesign --verify --deep --strict "$app_path"
    "$HOST_PYTHON" -I "$ROOT/scripts/sign_macos_resources.py" --verify-only "$resource_root"
    run_smoke "$resource_root/bin/python3" "$resource_root"
    codesign --verify --deep --strict "$app_path"
    "$HOST_PYTHON" -I "$ROOT/scripts/sign_macos_resources.py" --verify-only "$resource_root"
    ;;
  windows)
    if ! command -v 7z >/dev/null 2>&1; then
      echo "error: 7z is required to inspect the NSIS installer" >&2
      exit 1
    fi
    extract_dir="$work_dir/nsis"
    mkdir -p "$extract_dir"
    7z x -y "-o$extract_dir" "$BUNDLE" >/dev/null
    bundled_python="$(find "$extract_dir" -type f -iname 'python.exe' -path '*/python/*' -print -quit)"
    run_smoke "$bundled_python" "$(dirname "$bundled_python")"
    ;;
  linux)
    extract_dir="$work_dir/linux"
    mkdir -p "$extract_dir"
    case "$BUNDLE" in
      *.deb)
        dpkg-deb --extract "$BUNDLE" "$extract_dir"
        ;;
      *.AppImage)
        chmod +x "$BUNDLE"
        (
          cd "$extract_dir"
          "$BUNDLE" --appimage-extract >/dev/null
        )
        ;;
      *)
        echo "error: unsupported Linux bundle: $BUNDLE" >&2
        exit 1
        ;;
    esac
    bundled_python="$(find "$extract_dir" \( -type f -o -type l \) -path '*/python/bin/python3' -print -quit)"
    resource_root="$(dirname "$(dirname "$bundled_python")")"
    run_smoke "$bundled_python" "$resource_root"
    ;;
  *)
    echo "error: unsupported platform: $PLATFORM" >&2
    exit 1
    ;;
esac

echo "installer sidecar verification OK: $(basename "$BUNDLE")"

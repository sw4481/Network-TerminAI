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
  "$HOST_PYTHON" "$ROOT/sidecar/scripts/smoke_portable_sidecar.py" \
    "$bundled_python" \
    --expected-root "$expected_root"
}

case "$PLATFORM" in
  macos)
    mounted_path="$work_dir/mount"
    mkdir -p "$mounted_path"
    hdiutil attach -nobrowse -readonly -mountpoint "$mounted_path" "$BUNDLE" >/dev/null
    app_path="$(find "$mounted_path" -maxdepth 2 -type d -name '*.app' -print -quit)"
    if [[ -z "$app_path" ]]; then
      echo "error: DMG has no application bundle" >&2
      exit 1
    fi
    resource_root="$app_path/Contents/Resources/python"
    run_smoke "$resource_root/bin/python3" "$resource_root"
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

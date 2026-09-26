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
HOST_PYTHON="${PYTHON:-python3}"
CURRENT_STAGE="initializing"
report_failure() {
  local rc=$?
  trap - ERR
  echo "::error title=bundled sidecar verification failed::platform=${PLATFORM} stage=${CURRENT_STAGE} bundle=${BUNDLE} exit=${rc}" >&2
  exit "$rc"
}
fatal() {
  echo "error: $1" >&2
  echo "::error title=bundled sidecar verification failed::platform=${PLATFORM} stage=${CURRENT_STAGE} bundle=${BUNDLE} exit=1" >&2
  exit 1
}
trap report_failure ERR

if [[ ! -e "$BUNDLE" ]]; then
  fatal "bundle does not exist: $BUNDLE"
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
    fatal "installer has no bundled Python executable"
  fi
  "$HOST_PYTHON" "$ROOT/sidecar/scripts/smoke_portable_sidecar.py" \
    "$bundled_python" \
    --expected-root "$expected_root"
}

case "$PLATFORM" in
  macos)
    CURRENT_STAGE="locate macOS app bundle"
    if [[ -d "$BUNDLE" && "$BUNDLE" == *.app ]]; then
      app_path="$BUNDLE"
    else
      mounted_path="$work_dir/mount"
      mkdir -p "$mounted_path"
      hdiutil attach -nobrowse -readonly -mountpoint "$mounted_path" "$BUNDLE" >/dev/null
      app_path="$(find "$mounted_path" -maxdepth 2 -type d -name '*.app' -print -quit)"
    fi
    if [[ -z "$app_path" ]]; then
      fatal "macOS bundle has no application bundle"
    fi
    resource_root="$app_path/Contents/Resources/python"
    CURRENT_STAGE="smoke macOS bundled python"
    run_smoke "$resource_root/bin/python3" "$resource_root"
    ;;
  windows)
    CURRENT_STAGE="extract Windows installer"
    if ! command -v 7z >/dev/null 2>&1; then
      fatal "7z is required to inspect the NSIS installer"
    fi
    extract_dir="$work_dir/nsis"
    mkdir -p "$extract_dir"
    7z x -y "-o$extract_dir" "$BUNDLE" >/dev/null
    bundled_python="$(find "$extract_dir" -type f -iname 'python.exe' -path '*/python/python.exe' -print -quit)"
    resource_root="$(dirname "$bundled_python")"
    if [[ "$(basename "$resource_root")" != "python" ]]; then
      resource_root="$(dirname "$resource_root")"
    fi
    CURRENT_STAGE="smoke Windows bundled python"
    run_smoke "$bundled_python" "$resource_root"
    ;;
  linux)
    CURRENT_STAGE="extract Linux bundle"
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
        fatal "unsupported Linux bundle: $BUNDLE"
        ;;
    esac
    bundled_python="$(find "$extract_dir" \( -type f -o -type l \) -path '*/python/bin/python3' -print -quit)"
    resource_root="$(dirname "$(dirname "$bundled_python")")"
    CURRENT_STAGE="smoke Linux bundled python"
    run_smoke "$bundled_python" "$resource_root"
    ;;
  *)
    fatal "unsupported platform: $PLATFORM"
    ;;
esac

echo "installer sidecar verification OK: $(basename "$BUNDLE")"

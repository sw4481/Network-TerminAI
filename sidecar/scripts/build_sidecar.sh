#!/usr/bin/env bash
# Build a relocatable Python distribution containing the ccie_sidecar
# package + all dependencies (pyATS, Genie, ntc-templates, pyshark, …).
#
# Output: sidecar/dist/python-<target-triple>/python/bin/python3
# Tauri packages the whole tree as a bundle resource (see tauri.conf.json).
set -euo pipefail

cd "$(dirname "$0")/.."

TARGET="${CCIE_TARGET_TRIPLE:-$(rustc -vV | sed -n 's|host: ||p')}"
if [[ -z "$TARGET" ]]; then
    echo "error: could not detect target triple via rustc (set CCIE_TARGET_TRIPLE to override)" >&2
    exit 1
fi

# python-build-standalone release. Update PBS_RELEASE / PBS_VERSION together.
PBS_RELEASE="${PBS_RELEASE:-20260510}"
PBS_VERSION="${PBS_VERSION:-3.12.13}"
PBS_URL="https://github.com/astral-sh/python-build-standalone/releases/download/${PBS_RELEASE}/cpython-${PBS_VERSION}+${PBS_RELEASE}-${TARGET}-install_only_stripped.tar.gz"

DIST_ROOT="dist"
FINAL_DIST_DIR="${DIST_ROOT}/python-${TARGET}"
DOWNLOAD_CACHE="${TERMINAI_DOWNLOAD_CACHE:-${XDG_CACHE_HOME:-$HOME/.cache}/terminai}"
PBS_CACHE_DIR="${PBS_CACHE_DIR:-$DOWNLOAD_CACHE/python-build-standalone}"
ARCHIVE="$PBS_CACHE_DIR/cpython-${PBS_VERSION}+${PBS_RELEASE}-${TARGET}.tar.gz"
BUILD_WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/terminai-sidecar-build.XXXXXX")"
STAGING_DIST_DIR=""
cleanup() {
    rm -rf -- "$BUILD_WORK_DIR"
    if [[ -n "$STAGING_DIST_DIR" ]]; then
        rm -rf -- "$STAGING_DIST_DIR"
    fi
}
trap cleanup EXIT

mkdir -p "$DIST_ROOT" "$PBS_CACHE_DIR"
STAGING_DIST_DIR="$(mktemp -d "${DIST_ROOT}/.python-${TARGET}.XXXXXX")"
DIST_DIR="$STAGING_DIST_DIR"

# Keep downloaded/build artifacts per target, but never cache the installed
# portable environment. Every invocation installs into the fresh staging tree.
export UV_CACHE_DIR="${UV_CACHE_DIR:-$DOWNLOAD_CACHE/uv/${TARGET}}"
if [[ "$TARGET" == *apple-darwin ]]; then
    # neonize 0.3.18.post0's native bridge sets the bundle's real macOS floor.
    export MACOSX_DEPLOYMENT_TARGET="${MACOSX_DEPLOYMENT_TARGET:-15.0}"
fi

echo ">> downloading python-build-standalone for ${TARGET}"
if [[ ! -f "$ARCHIVE" ]]; then
    curl -fL "$PBS_URL" -o "$ARCHIVE.part"
    mv "$ARCHIVE.part" "$ARCHIVE"
fi

echo ">> extracting into $DIST_DIR"
mkdir -p "$DIST_DIR"
tar -xzf "$ARCHIVE" -C "$DIST_DIR"
# python-build-standalone archives unpack as `python/` at the root of DIST_DIR.
if [[ ! -d "$DIST_DIR/python" ]]; then
    echo "error: expected $DIST_DIR/python/ after extract" >&2
    exit 1
fi

# Pick the right python binary path (Unix vs Windows layout).
if [[ "$TARGET" == *windows* ]]; then
    PY="$DIST_DIR/python/python.exe"
else
    PY="$DIST_DIR/python/bin/python3"
fi

if ! command -v uv >/dev/null 2>&1; then
    echo "error: uv is required to install the frozen sidecar dependency graph" >&2
    exit 1
fi
uv lock --check

echo ">> exporting frozen sidecar dependencies"
uv export \
    --quiet \
    --frozen \
    --no-dev \
    --no-emit-project \
    --format requirements.txt \
    --output-file "$BUILD_WORK_DIR/requirements.txt"

echo ">> installing frozen dependencies into bundled python"
uv pip install \
    --quiet \
    --python "$PY" \
    --python-platform "$TARGET" \
    --python-version "$PBS_VERSION" \
    --require-hashes \
    --requirement "$BUILD_WORK_DIR/requirements.txt"

# Plan 12 Phase 2: fetch the ONNX MiniLM-L6 weights into the source tree so
# they ride along inside the wheel via `ccie_sidecar/rag/models/...`. Build
# tools run in uv's frozen build environment and are not shipped to users.
echo ">> fetching ONNX MiniLM-L6 weights (build-time only)"
uv run --frozen --extra build python scripts/fetch_onnx.py

echo ">> building sidecar wheel from the frozen build environment"
uv run --frozen --extra build \
    hatchling build --target wheel --directory "$BUILD_WORK_DIR/wheels"
wheel_paths=("$BUILD_WORK_DIR"/wheels/*.whl)
if [[ ${#wheel_paths[@]} -ne 1 || ! -f "${wheel_paths[0]}" ]]; then
    echo "error: expected exactly one sidecar wheel" >&2
    exit 1
fi
uv pip install --quiet --python "$PY" --no-deps "${wheel_paths[0]}"

echo ">> pruning to shrink the bundle"
# Remove pyc caches, test dirs, doc dirs that ship in some wheels.
find "$DIST_DIR/python" -type d -name __pycache__ -exec rm -rf {} + 2>/dev/null || true
find "$DIST_DIR/python" -type f -name '*.pyc' -delete 2>/dev/null || true
# pyATS ships large test/doc trees we don't need. Strip from both Unix (`lib`)
# and Windows (`Lib`) site-packages layouts.
for libdir in "$DIST_DIR/python/lib" "$DIST_DIR/python/Lib"; do
    [[ -d "$libdir" ]] || continue
    for sub in tests test doc docs examples; do
        find "$libdir" -type d -name "$sub" -prune -exec rm -rf {} + 2>/dev/null || true
    done
done

echo ">> smoke-test: package origin, heartbeat, version, and ping"
"$PY" scripts/smoke_portable_sidecar.py \
    "$PY" \
    --expected-root "$DIST_DIR/python"

# Do not replace the bundle consumed by a running Tauri development process
# until the new portable environment has passed its protocol smoke test.
replace_path() {
    local replacement="$1"
    local destination="$2"
    local backup_root
    backup_root="$(mktemp -d "${DIST_ROOT}/.sidecar-backup.XXXXXX")"

    if [[ -e "$destination" || -L "$destination" ]]; then
        mv "$destination" "$backup_root/previous"
    fi

    if mv "$replacement" "$destination"; then
        rm -rf -- "$backup_root"
        return 0
    fi

    if [[ -e "$backup_root/previous" || -L "$backup_root/previous" ]]; then
        mv "$backup_root/previous" "$destination"
    fi
    rm -rf -- "$backup_root"
    return 1
}

replace_path "$STAGING_DIST_DIR" "$FINAL_DIST_DIR"
STAGING_DIST_DIR=""

# Tauri's bundle.resources path in tauri.conf.json is static, so expose a
# target-agnostic `dist/python`. On Unix we symlink; on Windows (where
# symlinks require elevation) we copy.
if [[ "$TARGET" == *windows* ]]; then
    generic_staging="$(mktemp -d "${DIST_ROOT}/.python-current.XXXXXX")"
    cp -R "$FINAL_DIST_DIR/python/." "$generic_staging/"
    replace_path "$generic_staging" "$DIST_ROOT/python"
else
    generic_staging="${DIST_ROOT}/.python-current-${TARGET}.$$"
    ln -s "python-${TARGET}/python" "$generic_staging"
    replace_path "$generic_staging" "$DIST_ROOT/python"
fi

SIZE=$(du -sh "$FINAL_DIST_DIR" | awk '{print $1}')
echo ">> done. $FINAL_DIST_DIR = $SIZE (dist/python ready for Tauri bundle)"

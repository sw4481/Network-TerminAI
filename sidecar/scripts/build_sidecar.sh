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

DIST_DIR="dist/python-${TARGET}"
ARCHIVE="dist/python-${TARGET}.tar.gz"

mkdir -p dist
rm -rf "$DIST_DIR"

echo ">> downloading python-build-standalone for ${TARGET}"
if [[ ! -f "$ARCHIVE" ]]; then
    curl -fL "$PBS_URL" -o "$ARCHIVE"
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

echo ">> installing sidecar into bundled python"
"$PY" -m pip install --no-cache-dir --upgrade pip

# Plan 12 Phase 2: fetch the ONNX MiniLM-L6 weights into the source tree so
# they ride along inside the wheel via `ccie_sidecar/rag/models/...`. We use
# the bundled python (`$PY`) to install huggingface-hub temporarily — the
# runtime install below is `.` (no `[build]` extras), so the dep does NOT
# leak into the shipped sidecar.
echo ">> fetching ONNX MiniLM-L6 weights (build-time only)"
"$PY" -m pip install --no-cache-dir "huggingface-hub >= 0.24"
"$PY" scripts/fetch_onnx.py

"$PY" -m pip install --no-cache-dir .

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

echo ">> smoke-test: ping"
# Capture the full output rather than piping straight into `head`: `head -n 1`
# exits after the first line (the startup heartbeat) and closes the read end,
# so the sidecar's next stdout.flush() (the ping response) hits a closed pipe
# and dies with BrokenPipeError -> exit 120 under `pipefail`. Letting the
# process run to stdin-EOF makes it exit 0; we slice the first line afterwards.
smoke_out="$(echo '{"id":"1","method":"ping","params":{}}' | "$PY" -m ccie_sidecar)"
printf '%s\n' "$smoke_out" | head -n 1

# Tauri's bundle.resources path in tauri.conf.json is static, so expose a
# target-agnostic `dist/python`. On Unix we symlink; on Windows (where
# symlinks require elevation) we copy.
# Clear both cases defensively: a previous failed build could have left a
# stale symlink OR a stale directory, and `ln -s foo bar` with a bar/
# directory present silently creates the link INSIDE bar.
rm -f dist/python      # remove file or symlink (no-op if dir)
rm -rf dist/python     # remove directory (no-op if already gone)
if [[ "$TARGET" == *windows* ]]; then
    cp -r "$DIST_DIR/python" dist/python
else
    ln -sf "python-${TARGET}/python" dist/python
fi

SIZE=$(du -sh "$DIST_DIR" | awk '{print $1}')
echo ">> done. $DIST_DIR = $SIZE (dist/python ready for Tauri bundle)"

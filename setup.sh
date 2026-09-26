#!/usr/bin/env bash
set -euo pipefail

# Network-TerminAI — first-time setup
# Usage: ./setup.sh

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

echo "=== Network-TerminAI setup ==="

require_command() {
    local command_name="$1"
    local install_hint="$2"
    if ! command -v "$command_name" >/dev/null 2>&1; then
        echo "Error: $command_name is required. $install_hint" >&2
        exit 1
    fi
}

require_command bun "Install Bun 1.3.6 or newer."
require_command uv "Install uv 0.8.19 or newer."
require_command rustup "Install Rust with rustup; rust-toolchain.toml pins the required version."
require_command cargo "Install Rust with rustup."
require_command python3.12 "Install Python 3.12."

if [[ ! -f .env ]]; then
    cp .env.example .env
    echo "Created .env from .env.example. Add credentials only if you need provider or integration features."
else
    echo "Keeping existing .env."
fi

echo "Installing frontend dependencies..."
bun install --frozen-lockfile

echo "Creating the frozen Python sidecar environment..."
(
    cd sidecar
    uv sync --frozen --extra dev
)

# pyATS/Genie is unavailable on Windows. The wrapper is optional there; the
# sidecar falls back to its other parsers when the wrapper is not installed.
if [[ -x sidecar/.venv/bin/python ]]; then
    echo "Installing the local pyATS wrapper..."
    uv pip install --python sidecar/.venv/bin/python -e ./pyats_cli
else
    echo "Skipping the Unix-only pyATS wrapper install."
fi

echo "Fetching the local Whisper model used by the Tauri resource manifest..."
bun scripts/fetch-whisper-model.mjs

echo
echo "=== Setup complete ==="
echo "Edit .env if you need provider or integration credentials."
echo "Start development with: bun run tauri dev"
echo "The development frontend listens on http://localhost:1420"

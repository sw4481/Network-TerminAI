#!/bin/bash
set -e

# TerminAI - Quick Launch Script for macOS
# This script sets up and runs TerminAI in development mode

APP_VERSION="$(sed -n 's/.*\"version\": \"\([^\"]*\)\".*/\1/p' src-tauri/tauri.conf.json | head -n 1)"
echo "🚀 TerminAI v${APP_VERSION} - Quick Launch"
echo "======================================="
echo ""

# Color codes
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Check prerequisites
echo "📋 Checking prerequisites..."

if ! command -v rustc &> /dev/null; then
    echo -e "${RED}❌ Rust not found. Install with:${NC}"
    echo "   curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh"
    exit 1
fi

if ! command -v bun &> /dev/null; then
    echo -e "${RED}❌ Bun not found. Install with:${NC}"
    echo "   curl -fsSL https://bun.sh/install | bash"
    exit 1
fi

if ! command -v python3 &> /dev/null; then
    echo -e "${RED}❌ Python 3 not found. Install with:${NC}"
    echo "   brew install python@3.12"
    exit 1
fi

echo -e "${GREEN}✅ All prerequisites found!${NC}"
echo ""

# Keep development-sidecar imports tied to this checkout. The pyATS wrapper is
# source-owned under pyats_cli/ and does not need a second package install.
CCIE_REPO_ROOT="$(pwd)"
export CCIE_REPO_ROOT

# Setup Python virtual environment
echo "🐍 Setting up Python sidecar..."
cd sidecar

if [ ! -d ".venv" ]; then
    echo "   Creating virtual environment..."
    python3 -m venv .venv
fi

echo "   Activating virtual environment..."
# The environment is created immediately above.
# shellcheck disable=SC1091
source .venv/bin/activate

PYTHONPATH="$(pwd)/../pyats_cli${PYTHONPATH:+:$PYTHONPATH}"
export PYTHONPATH

if ! python -c "import ccie_sidecar, debugpy" 2>/dev/null; then
    echo "   Installing Python dependencies..."
    pip install -e . > /dev/null 2>&1
fi

# The PyATS agent uses the tracked terminai-pyats wrapper in pyats_cli/. The
# sidecar's pyATS dependency alone only provides Cisco's low-level package, so
# a sidecar can look healthy while the heartbeat's pre-bound `pyats` client is
# missing and silently omitted from the sandbox.
if ! python -c "import terminai_pyats" 2>/dev/null; then
    echo "   Installing TerminAI PyATS wrapper..."
    pip install -e ../pyats_cli > /dev/null 2>&1
fi

echo -e "${GREEN}✅ Python sidecar ready!${NC}"
deactivate
cd ..
echo ""

# Install frontend dependencies
echo "📦 Checking frontend dependencies..."
if [ ! -d "node_modules" ]; then
    echo "   Installing dependencies with bun..."
    bun install
    echo -e "${GREEN}✅ Frontend dependencies installed!${NC}"
else
    echo -e "${GREEN}✅ Frontend dependencies already installed!${NC}"
fi
echo ""

# Ensure the local dictation model is available before Tauri validates resources.
bun scripts/fetch-whisper-model.mjs

# Run the app
echo "🎯 Launching TerminAI..."
echo ""
echo -e "${YELLOW}📝 Note: First-time compilation may take 2-3 minutes${NC}"
echo -e "${YELLOW}📝 The app window will open automatically when ready${NC}"
echo ""
echo "Press Ctrl+C to stop the development server"
echo "======================================="
echo ""

# Force the dev sidecar to use sidecar/.venv, never a stale bundled python.
# A leftover target/{debug,release}/python/ tree (from a past build_sidecar.sh
# run) otherwise shadows live sidecar/src edits and surfaces as "unknown method"
# RPC errors or a dead sidecar heartbeat. Belt-and-suspenders: also remove any
# stale bundle so nothing can intercept the spawn.
export CCIE_FORCE_VENV=1
rm -rf src-tauri/target/debug/python src-tauri/target/release/python 2>/dev/null || true

# Tauri dev embeds src-tauri/Info.plist into target/debug/TerminAI during crate
# codegen. Force that crate to rebuild when native permission text changes;
# otherwise macOS TCC can crash the stale dev binary on first mic/speech access.
if [ src-tauri/Info.plist -nt src-tauri/target/debug/TerminAI ]; then
    echo "   Refreshing native permission metadata..."
    cargo clean --manifest-path src-tauri/Cargo.toml -p ccie-terminal >/dev/null
fi

export RUST_LOG=info
mkdir -p /tmp/ccie-logs
echo "Logging to /tmp/ccie-logs/app.log"
bun run tauri dev 2>&1 | tee /tmp/ccie-logs/app.log

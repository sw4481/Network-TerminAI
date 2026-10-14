# Network-TerminAI

**Version:** 1.1.0 | **Port:** 1420 | **Stack:** Tauri 2, Rust 1.97, React 19/TypeScript/Vite, Python 3.12/uv

## What

Network-TerminAI (TerminAI) is a Tauri desktop AI terminal for network engineers. It combines local terminals, AI assistance, network automation, IaC workflows, topology, packet capture, integrations, and local documentation.

## Quick Start

```bash
./setup.sh              # First-time setup
bun run tauri dev       # Start the desktop app
bun run test            # Run frontend checks and Vitest
```

The development window uses Vite at `http://localhost:1420`.

## Commands

```bash
# Setup and development
bun install --frozen-lockfile
./run.sh
bun run tauri dev
bun run build

# Tests and checks
bun run test
uv run --project sidecar --frozen --extra dev pytest -v
cargo test --manifest-path src-tauri/Cargo.toml --locked
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --locked -- -D warnings
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check

# Release bundle
cd sidecar && ./scripts/build_sidecar.sh && cd ..
bun run tauri build -- --locked
```

## Architecture

```text
src/                         React UI, state, windows, and frontend utilities
src-tauri/src/                Rust/Tauri core, IPC commands, PTYs, SQLite, integrations
src-tauri/migrations/         SQLite schema migrations
sidecar/src/ccie_sidecar/     Python NDJSON AI sidecar and network integrations
bundled-agents/               Public agent definitions and prompts
docs/                         User, architecture, security, and feature documentation
scripts/                      Build, validation, model, and release helpers
```

The React frontend calls the Rust core through Tauri IPC. Rust manages desktop integration, terminals, persistence, and sidecar processes; the Python sidecar communicates over NDJSON with configured AI providers and network tools.

## Key Files

- `package.json` — frontend scripts and dependencies
- `src/App.tsx` — primary frontend composition
- `src-tauri/src/lib.rs` — Tauri application wiring
- `src-tauri/src/commands/mod.rs` — command registration and sidecar target resolution
- `src-tauri/tauri.conf.json` — app metadata, port, resources, and bundle settings
- `sidecar/src/ccie_sidecar/server.py` — Python NDJSON server
- `sidecar/pyproject.toml` — Python dependencies and test configuration
- `run.sh` — source-development launcher
- `.env.example` — placeholder environment configuration

## Configuration

Settings are primarily managed in the app. `.env.example` contains public placeholders for providers and integrations; never commit real credentials.

| Variable | Required | Description |
|---|---:|---|
| `ANTHROPIC_API_KEY` | No | Anthropic provider credential |
| `OPENAI_API_KEY` | No | OpenAI-compatible provider credential |
| `GOOGLE_API_KEY` | No | Google provider credential |
| `NVIDIA_API_KEY` | No | NVIDIA provider credential |
| `OLLAMA_HOST` | No | Local Ollama endpoint |
| `VLLM_ENDPOINT` | No | Local or hosted vLLM-compatible endpoint |
| Integration variables | No | See `.env.example` for the complete placeholder list |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Nightly Fixer Rules

These rules apply to the unattended overnight fixer (branches `nightly/*`).

### Scope

- Fix bugs in the Rust core (`src-tauri/`) or the Python sidecar (`sidecar/`).
  An issue that needs frontend (`src/`), packaging, release or CI changes is
  out of scope: SKIP it.

### Verification commands

```bash
# Python sidecar suite (run from the repo root)
uv run --project sidecar --frozen --extra dev pytest -q sidecar/tests
uv run --project sidecar --frozen --extra dev pytest -q sidecar/tests/test_issue_<N>.py

# Rust suite (CCIE_REPO_ROOT must point at the repo root)
CCIE_REPO_ROOT="$PWD" cargo test --manifest-path src-tauri/Cargo.toml --locked
CCIE_REPO_ROOT="$PWD" cargo test --manifest-path src-tauri/Cargo.toml --locked --test issue_<N>_test
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --locked -- -D warnings
rustfmt --edition 2021 --check <each changed .rs file>
```

The full suite is the Python suite, Rust clippy and the Rust suite. All three
must be green.

### Rules for every change

- Make the smallest change that fixes the problem. No refactors, renames,
  reformatting, or "while I'm here" cleanups.
- Never modify or delete an existing test file, and never edit an existing
  `#[cfg(test)]` module. A new regression test goes in a NEW file:
  - Python: `sidecar/tests/test_issue_<N>.py`
  - Rust, public API: `src-tauri/tests/issue_<N>_test.rs`
  - Rust, private items: a new `issue_<N>_tests.rs` beside the module, wired in
    with `#[cfg(test)] #[path = "issue_<N>_tests.rs"] mod issue_<N>_tests;`
- Never add, remove, or upgrade dependencies or lockfiles (`Cargo.toml`
  dependencies, `Cargo.lock`, `pyproject.toml` dependencies, `uv.lock`,
  `package.json`, `bun.lock`).
- Never touch `.github/`, `.claude/`, `CLAUDE.md`, CI config, release scripts,
  or secrets.
- If a fix needs more than 5 files or about 100 changed lines, it is out of
  scope: stop and explain why.
- Match the existing code style. Run `rustfmt --check` only on Rust files you
  changed; never reformat whole files or the crate.

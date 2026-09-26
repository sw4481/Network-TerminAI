# Contributing to Network-TerminAI

Thanks for helping improve Network-TerminAI. Contributions should be focused, reproducible, and safe to share publicly.

## Development setup

Requirements:

- Rust via `rustup`; the repository pins Rust 1.97.0 in `rust-toolchain.toml`
- Bun 1.3.6 or newer
- Python 3.12
- uv 0.8.19 or newer
- Tauri's platform prerequisites for your operating system

From a clean checkout:

```bash
./setup.sh
bun run tauri dev
```

The script creates `.env` from `.env.example` when needed, installs the frozen frontend and sidecar dependencies, and fetches the local Whisper model used by development builds. Keep credentials in `.env` or the app's Settings; never commit them.

## Checks before opening a pull request

```bash
bun run test
bun run build
uv run --project sidecar --frozen --extra dev pytest -v
cargo test --manifest-path src-tauri/Cargo.toml --locked
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --locked -- -D warnings
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
```

For changes that affect the desktop UI, also describe the platform and workflow you exercised. Live-device, provider, or integration tests should identify their prerequisites without including credentials, private addresses, customer data, or command output containing secrets.

## Code style

- Rust: run `cargo fmt`; keep fallible operations explicit and preserve existing Tauri IPC boundaries.
- TypeScript/React: use existing component and Zustand patterns, keep types explicit, and avoid unrelated formatting changes.
- Python: follow PEP 8, use type hints for new interfaces, and keep the NDJSON protocol on stdout free of diagnostic output.
- Prefer small, targeted changes over broad refactors. Add tests for behavior changes when practical.

## Issues and pull requests

1. Open an issue for a bug or feature request before beginning substantial work.
2. Create a focused branch from `main`.
3. Keep commits small and explain user-visible behavior in the pull request.
4. Include testing performed, affected platforms, and any integration prerequisites.
5. Confirm that no secrets, local state, generated dependencies, build output, or private network data are included.
6. Request review and address feedback before merging.

Use the issue templates for bug reports and feature requests. For security-sensitive reports, follow the process in [docs/SECURITY.md](docs/SECURITY.md) rather than posting exploitable details publicly.

## Using with Claude Code

This repository includes [`CLAUDE.md`](CLAUDE.md) with the project commands, architecture, key files, and configuration notes. Run Claude Code from the repository root so it can read that context, review the relevant source, and run the documented checks. Do not provide credentials or private device data in prompts.

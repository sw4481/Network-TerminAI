# Phase 5 Complete - LSP Manager (Rust)

**Date:** 2026-05-12
**Status:** Infrastructure complete. Servers (`pylsp`, `yaml-language-server`) not yet installed on this machine — manager will report them as unavailable until then, which is the expected graceful-degradation path.

---

## What Was Built

Phase 5 adds the Rust-side infrastructure for speaking LSP to language-server subprocesses over JSON-RPC. Phase 6 will wire it into Monaco.

### Sub-Phase 5.1: Dependencies
- `src-tauri/Cargo.toml` — added `process` feature to the existing `tokio` dependency. No new crates; `tower-lsp` / `lsp-types` from the plan were dropped as unnecessary (we're an LSP client, not server, and raw `serde_json::Value` handles JSON-RPC fine).

### Sub-Phase 5.2: LSP Manager Module
- `src-tauri/src/lsp/mod.rs` — `LspManager` with:
  - `start_lsp(language, config)` — spawns the LSP server with piped stdin/stdout, `kill_on_drop` enabled.
  - `stop_lsp(language)` — best-effort kill + wait.
  - `send_request(language, request)` — writes `Content-Length` framed JSON-RPC and reads the framed response via a private `read_message` helper that handles multi-header reads correctly.
  - `is_running(language)` — status check.
- Stored stdin/stdout handles are taken at spawn time (rather than re-borrowed from `child` on every request), which simplifies ownership.
- `src-tauri/src/lib.rs` — `pub mod lsp;` registered.
- `src-tauri/src/commands/mod.rs` — `lsp_manager: Arc<crate::lsp::LspManager>` added to `AppState`, initialized in `AppState::new`.

### Sub-Phase 5.3: Per-language configs
- `src-tauri/src/lsp/python.rs` — `get_python_lsp_config()` (pylsp, no args) and `check_pylsp_installed()`.
- `src-tauri/src/lsp/yaml.rs` — `get_yaml_lsp_config()` (yaml-language-server with `--stdio`) and `check_yaml_ls_installed()`.

### Sub-Phase 5.4: Tauri commands
- `src-tauri/src/commands/lsp.rs` — `lsp_start`, `lsp_stop`, `lsp_request`, `lsp_is_running`, `lsp_check_available`.
- Registered in `src-tauri/src/commands/mod.rs` (`pub mod lsp;`) and `src-tauri/src/lib.rs` (invoke_handler).

### Sub-Phase 5.5: Frontend IPC wrappers
- `src/lib/tauri.ts` — `lspStart`, `lspStop`, `lspRequest<T>`, `lspIsRunning`, `lspCheckAvailable`.

---

## Verification

- `cargo build --manifest-path src-tauri/Cargo.toml` — success in 0.74s, only pre-existing warnings.
- `bunx tsc --noEmit` — no new errors in the edited files; pre-existing unrelated TS errors persist.

---

## Deviations from the Plan

- Dropped `tower-lsp` and `lsp-types` crates. We just need JSON-RPC framing, not a full LSP server framework.
- Stored `ChildStdin` / `BufReader<ChildStdout>` on `LspProcess` instead of re-taking them from `child` every request. The plan's approach wouldn't compile — `child.stdin.as_mut()` after the first move into `HashMap` is awkward.
- `stop_lsp` uses `start_kill` + `wait` instead of `kill().await`, which is non-blocking and avoids a race with `kill_on_drop`.
- Header parsing: the plan only read one line before the empty separator. Real LSP servers can emit multiple headers (`Content-Length` + optional `Content-Type`), so `read_message` consumes headers until the empty line.

---

## Next: Phase 6 — LSP Client (Monaco)

Phase 6 adds:
- `src/hooks/useLspClient.ts` — starts/stops LSP and exposes `sendRequest`.
- `src/components/editor/lsp/CompletionProvider.ts` — Monaco completion provider backed by LSP.
- `src/components/editor/lsp/HoverProvider.ts` — Monaco hover provider.
- `MonacoEditor.tsx` — registers providers when LSP is available.

Note: Phase 6 will still render and work when `lsp_check_available` returns an empty list; providers simply won't register.

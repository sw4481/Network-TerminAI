# Zed Mode Phase 4: Project-wide LSP Navigation

**Date:** 2026-07-29
**Status:** Implemented on `feature/zed-mode-phase-4`; native interaction matrix pending
**Source design:** `Plans/ZED.md` §7
**Prerequisites:** Zed Mode Phases 1–3 on `main`

## Goal

Turn TerminAI's existing single-file LSP prototype into workspace-aware language
intelligence. A Zed Mode editor must be able to go to a definition, find
references, and search symbols across the open project while keeping completion
and hover working in both Zed and classic Monaco modes.

The implementation keeps Monaco as the renderer and extends the existing Rust
`LspManager`; it does not add a second language-client stack.

## Current Codebase Ground Truth

- `src-tauri/src/lsp/mod.rs` can spawn one process per language and frame one
  request/response over stdio, but it does not initialize the server, open or
  synchronize documents, correlate JSON-RPC response IDs, handle server
  notifications/requests, scope a process to a workspace, or restart a crashed
  child.
- `src/hooks/useLspClient.ts` starts and stops that language-global process for
  each mounted Monaco editor. One split or detached-window teardown can
  therefore stop a server still used by another view.
- `CompletionProvider.ts` and `HoverProvider.ts` send requests for Monaco's
  in-memory model URI without first sending `textDocument/didOpen`.
- `MonacoEditor` has the absolute file path, while `EditorPane` also has the
  workspace root. The root is not currently passed into `MonacoEditor`.
- Detached window metadata has the tab, pane, and buffer IDs but not the source
  workspace root.
- Monaco 0.52 exposes definition and reference providers plus
  `editor.registerEditorOpener`. It does not expose a public workspace-symbol
  provider, so project symbol search needs a small TerminAI picker backed by
  `workspace/symbol`.

## Scope

### Included

- One persistent language-server session per canonical
  `(workspace root, language)` pair.
- Client leases so split panes, shared buffers, and detached windows cannot stop
  a session still in use.
- LSP `initialize`/`initialized`, `shutdown`/`exit`, request correlation,
  server-request replies, document open/change/close, bounded request timeouts,
  child cleanup, and automatic restart after an unexpected exit.
- Full-document synchronization with backend-assigned monotonically increasing
  versions and cross-webview document ownership.
- Python via Pyright and YAML via `yaml-language-server`, resolved from
  TerminAI's local `node_modules/.bin` first and then `PATH`.
- Existing completion and hover behavior in both editor modes.
- Zed-gated Monaco go-to-definition and find-references providers.
- Cross-file navigation that opens the target in the initiating attached pane.
- Detached-window cross-file navigation handed back to the source editor tab.
- Zed-gated `Cmd/Ctrl+T` workspace-symbol picker with keyboard and mouse
  selection.
- Focused frontend/Rust tests, full suites, production build, and live Tauri /
  sidecar verification.

### Not included

- Literal Zed embedding.
- DAP/debugging work from Phase 5.
- Rename, code actions, semantic tokens, formatting, or diagnostics UI.
- Downloading language servers dynamically at runtime.
- Persisting LSP state in SQLite or adding a database migration.
- Restoring server processes across a full application restart.
- Bundling a private Node runtime for release packages. Development resolves
  TerminAI's pinned npm servers; production can also use compatible servers on
  `PATH`.

## Backend Contract

### Session identity and leases

All LSP commands carry:

```ts
type LspSession = {
  language: "python" | "yaml";
  workspaceRoot: string; // canonicalized existing directory
};
```

`lsp_start` also receives an opaque `clientId`. Repeating the same client lease
is idempotent. `lsp_stop` releases only that client; the process shuts down after
the final lease is released.

### Protocol lifecycle

Starting a new session:

1. Resolve the configured executable.
2. Spawn it with the workspace as `current_dir`, piped stdin/stdout/stderr, and
   kill-on-drop.
3. Send `initialize` with `rootUri`, `workspaceFolders`, client capabilities,
   TerminAI client info, and the current process ID.
4. Correlate the initialize response by JSON-RPC ID while consuming
   notifications and answering supported server-to-client requests.
5. Send `initialized`.

Stopping the final lease sends `shutdown`, then `exit`, waits briefly, and
kills/reaps the child if it does not exit.

### Requests and supervision

- The backend assigns monotonically increasing request IDs.
- One session serializes stdio access, but messages are read until the matching
  response ID arrives; unrelated notifications cannot be mistaken for a
  response.
- A request has a bounded timeout. A timeout or broken stream invalidates the
  process so the next operation starts a clean protocol session.
- A lightweight monitor detects unexpected child exit. While leases remain, it
  restarts and reopens the latest text for every owned document.
- Server requests needed by Pyright/YAML are answered:
  `workspace/configuration`, `workspace/workspaceFolders`,
  `client/registerCapability`, `window/workDoneProgress/create`, and
  `workspace/applyEdit` (honest unsupported result).
- Unsupported server requests receive JSON-RPC method-not-found.

### Document ownership

High-level commands replace raw frontend notifications:

- `lsp_document_open`: add the calling client to a URI; send `didOpen` only for
  the first owner.
- `lsp_document_change`: store the latest full text, increment the
  backend-owned version, and send one full-content `didChange`.
- `lsp_document_close`: remove the calling client; send `didClose` only after
  the final owner leaves.
- Releasing a client lease also releases all documents owned by that client.

This prevents duplicate `didOpen`/premature `didClose` across Monaco splits and
separate Tauri webviews.

## Frontend Contract

### Client hook

`useLspClient(language, workspaceRoot, enabled)` owns a stable client ID and
exposes:

- `ready`
- `sendRequest(method, params)`
- `openDocument(uri, languageId, text)`
- `changeDocument(uri, text)`
- `closeDocument(uri)`

Effect cleanup releases that client lease. A stale async startup cannot mark a
new language/root session ready.

### Monaco model and document lifecycle

- File-backed shared models use a real `file://` URI. Untitled buffers retain
  an `inmemory://` URI.
- A ref-counted per-webview registration sends one document open/change/close
  stream per model; the Rust ownership layer deduplicates across webviews.
- Completion, hover, definition, and reference requests use zero-based LSP
  positions and the model's file URI.
- LSP ranges/locations are mapped back to Monaco one-based ranges.
- Definition/reference providers reject models not owned by their editor
  instance, preventing cross-workspace provider leakage.

### Cross-file opening

`editor.registerEditorOpener` routes a definition/reference target:

- Attached pane: open the file into the initiating pane, wait for its shared
  model switch, reveal the target, and focus it.
- Detached pane: emit a location event for the source tab, focus the source
  window, and let the main editor open/reveal it.
- Non-file and out-of-workspace URIs are not handled.

### Workspace symbol picker

- Visible only in Zed Mode.
- Opens with `Cmd/Ctrl+T` or a toolbar button.
- Debounces `workspace/symbol` queries.
- Shows symbol name, kind/container, and project-relative file path.
- Arrow keys move selection; Enter opens/reveals; Escape closes.
- Empty, unavailable, loading, and error states are explicit.

## Acceptance Matrix

### Automated

- Rust framing, request correlation helpers, server-request responses, document
  ownership/versioning, executable resolution, session keying, and cleanup
  behavior.
- Tauri bridge payloads and client lease lifecycle.
- File-backed Monaco URIs and shared-model reuse.
- Completion/hover/definition/reference conversion and model gating.
- Workspace-symbol normalization, file URI conversion, and picker interaction.
- Attached/detached location routing metadata.
- Full frontend suite, Rust library suite, `cargo check`,
  `bun run build:relaxed`, scoped formatting, and `git diff --check`.

### Live

1. Launch only through `./run.sh`.
2. Open a two-file Python project in Zed Mode.
3. Confirm Pyright starts once for that workspace.
4. Confirm completion and hover.
5. Confirm go-to-definition opens/reveals the other file.
6. Confirm find-references lists project-wide locations.
7. Confirm `Cmd+T` finds and opens a workspace symbol.
8. Confirm edits update navigation without saving.
9. Confirm a split and detached view share the same session.
10. Confirm a killed server is restarted on the next operation.
11. Confirm classic Monaco hides Phase 4 navigation UI without disturbing its
    prior editing behavior.
12. Verify the TerminAI process, repository-venv sidecar child, warmup ping,
    fresh `sidecar_status.last_seen`, and footer version chip.

## Known Packaging Boundary

The phase pins the language-server npm packages and resolves their development
binaries from TerminAI's repository. A signed production bundle still needs a
separate packaging decision for a Node runtime and server resources; external
compatible binaries on `PATH` remain supported. That packaging decision does not
block the development app capability or the shared process-management
scaffolding Phase 5 will reuse.

## Verification Snapshot

Completed on 2026-07-29:

- Exact-version `pyright@1.1.411` and `yaml-language-server@1.24.0` install
  cleanly from `bun.lock`.
- The real Pyright integration fixture initializes a two-file workspace,
  returns a project symbol and cross-file definition, survives a forced child
  kill through the supervisor, and shuts down without leaving an orphan.
- Focused bridge, lease-race, document-sync, provider, picker, keybinding, and
  detached-routing tests pass.
- The full frontend and Rust library suites, `cargo check`,
  `bun run build:relaxed`, scoped Rust formatting, and `git diff --check` pass.
- `./run.sh` launches `target/debug/TerminAI` with a direct
  `python -m ccie_sidecar` child using `sidecar/.venv`; warmup ping succeeds,
  `sidecar_status.last_seen` remains fresh, and the footer exposes sidecar
  version `0.0.1`.

Still manual:

- The 10 editor interactions in the Live acceptance matrix above. The current
  Playwright Tauri driver serves a mock page instead of attaching to the native
  WKWebView, so automation cannot honestly claim those pointer/keyboard flows.

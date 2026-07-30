# Design: "Zed Mode" for the CCIE Terminal Editor

**Date:** 2026-07-27
**Status:** Phases 1–5 implemented; Phase 5 automated/native health validation complete; operator feature validation pending
**Author:** brainstormed with operator

---

## 1. Motivation & the load-bearing constraint

The operator asked for a Settings toggle to "switch from the Monaco editor to Zed —
basically embed Zed into the app." During brainstorming we established a hard
architectural fact that this spec is built around:

> **Zed cannot be embedded.** Zed is a standalone native macOS/Linux application
> written in Rust on its own GPU framework (GPUI). It is not distributed as a
> library, npm package, web component, or `<iframe>` target, and it paints its own
> OS window. There is no supported way to render Zed inside the CCIE Terminal
> Tauri webview.

The operator's real goal, clarified through questioning, is **the Zed editing
*experience and capabilities* inside CCIE Terminal** — not the literal Zed binary.
Specifically the operator wants, quoting: *"not just the feel but the capabilities
too that we are missing."*

**Settled decision:** We keep **Monaco as the editor engine** (preserving the
existing LSP providers, HCL language, IaC diff preview, and coach-mark
investments) and build the Zed experience *around* Monaco: theme, layout,
modal editing, and out-of-webview subsystems (detached windows, project LSP,
debugger). We do **not** swap to CodeMirror.

## 2. Scope

The operator requested the following capabilities, and elected to capture all of
them in **one phased spec** (Phase 1 at full detail; Phases 2–5 at design-outline
level, each to get its own detailed plan when reached):

| # | Capability | In-webview? | Size | Phase |
|---|---|---|---|---|
| 1 | Zed look/theme + layout + Vim mode + keybindings | ✅ | Small | **Phase 1 (full detail)** |
| 2 | Editor splits & pop-out/detached windows | ✅ (Tauri) | Medium | Phase 2 |
| 3 | GitHub git integration (gutter/blame/status) | ⚠️ partly exists | Medium | Phase 3 |
| 4 | Project-wide LSP navigation | ⚠️ real work | Large | Phase 4 |
| 5 | Debugging (DAP) of user code in the editor | ⚠️ real work | Largest | Phase 5 |

**Debug target (settled):** the debugger targets **user-authored scripts/apps
opened in the editor** — primarily Python network scripts via `debugpy`/DAP —
exactly as Zed debugs the project you have open. It does **NOT** debug the CCIE
Terminal application itself.

### Out of scope
- Embedding the real Zed binary (impossible; see §1).
- A separate "Open in external Zed" handoff (explicitly rejected in favor of
  in-app experience).
- Debugging the Terminal/sidecar app itself.
- Debug adapters for languages with no adapter (Terraform, Ansible have no DAP).

## 3. Architecture: one flag, layered capabilities

A single persisted flag gates everything, following the existing `app_flags`
pattern used across the codebase (e.g. `ccie_git_config`, `ccie_vendor_keywords`,
`ccie_context_graph`).

```
app_flags.ccie_editor_mode  ("monaco" | "zed")   ← persisted, like ccie_git_config
        │
        ▼
Settings → "Editor" tab toggle  (src/windows/Settings.tsx, new activeTab === "editor")
        │  writes via editorModeSet(); reads via editorModeGet()  (src/lib/tauri.ts)
        ▼
ZedModeProvider (React context)  reads flag at app start + on change event
        │
        ├──► Phase 1: MonacoEditor reads context → theme / vim / keybindings / layout CSS
        ├──► Phase 2: editor split state + Tauri WebviewWindow (reuse browser-pane pattern)
        ├──► Phase 3: new Tauri git_* commands → Monaco decorations (gutter/blame)
        ├──► Phase 4: Rust-managed persistent LSP server processes → Monaco providers
        └──► Phase 5: Rust-managed debugpy/DAP client → debug UI panel
```

**Key principles**
- Monaco stays the renderer in every phase.
- Zed Mode is *additive* — turning it off returns the exact current Monaco
  behavior. Nothing existing is removed.
- Each phase is an independent, shippable sub-project with its own detailed plan.
- Backend process management (Phases 4 & 5) shares one Rust scaffolding for
  spawning/supervising child processes.

## 4. Phase 1 — Zed Mode Foundation (FULL DETAIL)

The switch the operator originally asked for. Delivers the "feel" immediately with
**zero backend beyond the flag**.

### 4.1 Persistence & wiring
- **Flag:** `app_flags.ccie_editor_mode`, values `"monaco"` (default) | `"zed"`.
- **Frontend helpers** in `src/lib/tauri.ts`, mirroring `gitConfigGet/Set`:
  - `editorModeGet(): Promise<"monaco" | "zed">`
  - `editorModeSet(mode): Promise<void>`
- **Rust commands** `editor_mode_get` / `editor_mode_set` in
  `src-tauri/src/commands/`, registered in `lib.rs`, reading/writing `app_flags`.
- **Context:** `src/components/editor/ZedModeProvider.tsx` exposes
  `{ mode, vimEnabled, setMode, setVimEnabled }`. Reads flag on mount; listens
  for a `zed-mode-changed` window event so all editor instances update live.

### 4.2 Settings UI
- New tab in `src/windows/Settings.tsx`: add `"editor"` to the `activeTab` union
  and a tab button, following the existing GitCiSettingsTab pattern.
- New `src/windows/settings/EditorSettingsTab.tsx` + `.css`:
  - Toggle: **Editor style** — Monaco (classic) ↔ Zed Mode.
  - Sub-toggle (enabled only in Zed Mode): **Vim mode**.
  - Live preview note; changes apply immediately via the window event.

### 4.3 Theme
- `src/components/editor/themes/zed-one-dark.ts`: a Monaco theme via
  `monaco.editor.defineTheme` approximating Zed's One-dark palette (background,
  syntax token colors, selection, gutter, cursor). Applied when `mode === "zed"`.
- Reverts to the current default theme when `mode === "monaco"`.

### 4.4 Vim mode
- Add `monaco-vim` dependency. When `vimEnabled`, attach `initVimMode` to the
  Monaco instance with a status element in the Zed-style status bar; detach
  cleanly on toggle-off or unmount.

### 4.5 Layout / chrome
- `src/components/editor/zed-mode.css`: Zed-style minimal chrome — slim tabs,
  a breadcrumb bar (file path segments) above the editor, cleaner gutter, Zed
  font stack. Scoped under a `.zed-mode` class so it never affects classic Monaco.

### 4.6 Keybindings
- Register Zed default editor actions on the Monaco instance when in Zed Mode:
  command palette (already partially present via app palette — bridge to it),
  multi-cursor, quick line move/duplicate. Keep them additive and reversible.

### 4.7 Phase 1 testing
- vitest: `editorModeGet/Set` round-trip (mocked invoke); `ZedModeProvider`
  context state + event handling; theme applies on mode switch; Vim attach/detach;
  Settings tab toggles write the flag. Matches existing editor test suites
  (`MonacoEditor`, `EditorCoachMarks`).
- Rust: `editor_mode_get/set` unit tests against a temp `app_flags` store.
- Live-verify in the running app per the "verify before claiming done" rule
  (run vitest with `--exclude '**/.worktrees/**'`).

## 5. Phase 2 — Splits & pop-out windows (OUTLINE)

**Detailed implementation plan:** `docs/superpowers/plans/2026-07-28-zed-mode-phase-2.md`

**Implementation status (2026-07-28):** Tasks 1–9 and the automated
acceptance gates are complete on `feature/zed-mode-phase-2`. The Tauri app and
detached-editor route start cleanly. The final interactive native-window matrix
remains pending because the repository's current Playwright Tauri driver
returns a mock page rather than attaching to the WKWebView, and the active
Codex session cannot use macOS screen capture or Accessibility UI control.

- **Splits:** extend the existing editor tab/registry (`EditorTab`,
  `EditorTerminalPanel`) to support horizontal/vertical split panes sharing the
  editor registry so buffers stay in sync.
- **Pop-out:** tear an editor pane into its own native window using Tauri
  `WebviewWindow`, reusing the browser-pane multi-window pattern
  (`src-tauri/src/browser/mod.rs`, `commands/browser.rs`). The detached window
  hosts a Monaco bound to the same buffer via a shared store.
- Deliverable: split editing + detachable editor windows in Zed Mode.

## 6. Phase 3 — GitHub integration (OUTLINE)

**Detailed implementation plan:** `docs/superpowers/plans/2026-07-29-zed-mode-phase-3.md`

- **Implementation status (2026-07-29):** implemented on
  `feature/zed-mode-phase-3`; automated verification and native startup smoke
  pass, with the interactive macOS matrix still pending.
- Extend the existing Git/CI plumbing (`gitConfigGet/Set`, PushToGit modal,
  GitCiSettingsTab, `github_list_runs`).
- **Backend:** read-only `git2` commands for structured in-memory diff, blame,
  and repository summary data exposed through Tauri.
- **Frontend:** Monaco decorations for the diff gutter (added/modified/deleted
  lines), an inline blame lens, and a status-bar branch/dirty indicator.
- Deliverable: Zed-style git awareness in the editor, built on existing GitHub push.

## 7. Phase 4 — Project-wide LSP navigation (OUTLINE)

**Detailed implementation plan:** `docs/plans/2026-07-29-zed-mode-phase-4.md`

**Implementation status (2026-07-29):** implemented on
`feature/zed-mode-phase-4`. The full frontend and Rust library suites,
production frontend build, real two-file Pyright integration/restart test, and
live Tauri/sidecar release invariant pass. The operator completed the native
editor interaction matrix on 2026-07-29. The repository's Playwright driver
still cannot automate that matrix because it does not attach to the Tauri
WKWebView.

- **Backend:** one persistent, supervised server per canonical
  `(workspace root, language)` session, with reference-counted client/document
  ownership, JSON-RPC correlation, LSP initialize/shutdown lifecycle,
  full-document synchronization, crash restart, and document reopening.
- **Languages:** exact-version Pyright and YAML Language Server dependencies,
  resolved from TerminAI's repository first and then `PATH`.
- **Frontend:** real file-backed Monaco URIs, project-wide go-to-definition and
  find-references, cross-file attached/detached routing, and a Zed-gated
  `Cmd/Ctrl+T` workspace-symbol picker.
- The Rust process lifecycle and supervision seam is the starting scaffold for
  Phase 5's DAP adapter management.
- Deliverable: project-wide code navigation for supported languages in Zed Mode.

## 8. Phase 5 — Debugging / DAP (IMPLEMENTED — OPERATOR VALIDATION IN PROGRESS)

**Detailed implementation plan:** `docs/plans/2026-07-29-zed-mode-phase-5.md`

- **Target:** user-authored scripts opened in the editor, primarily Python via
  `debugpy` (a real DAP adapter). NOT the Terminal app.
- **Backend:** a DAP client + adapter lifecycle manager in Rust, built on the
  Phase 4 process scaffolding; launches `debugpy`, speaks DAP over stdio/socket.
- **Frontend:** debug UI — breakpoint gutter, variables/scopes panel, call stack,
  watch, and step controls (continue/step over/into/out).
- **Operator follow-up:** Steps 7 and 10 passed. Feedback from Steps 9 and 11
  added workspace-scoped folder selection, closable open-file tabs with
  unsaved-change protection, and disposal-safe LSP cleanup for split-pane
  teardown. The corrected interactions are ready for operator retest.
- Depends on Phase 4. Adapters for languages without DAP support are out of scope.
- Deliverable: breakpoint debugging of user Python scripts, Zed-style.

## 9. Cross-cutting data flow

```
Settings "Editor" tab ──► editorModeSet() ──► git_config-style Rust cmd ──► app_flags.ccie_editor_mode
                                                                                   │
App start / zed-mode-changed event ──► editorModeGet() ──► ZedModeProvider ────────┘
                                                              │
                        ┌─────────────────────────────────────┼───────────────────────────────┐
                   Phase 1 (theme/vim/layout)          Phase 2/3 (windows/git)          Phase 4/5 (lsp/dap)
                   pure frontend                       new Tauri commands               Rust child-process mgr
```

## 10. Testing strategy (all phases)

- **Frontend:** vitest for flag round-trips, context/provider behavior, theme
  application, UI toggles, and each phase's components — matching the existing
  editor/settings suites. Run with `--exclude '**/.worktrees/**'`.
- **Backend:** Rust unit tests for each new Tauri command group (editor_mode,
  git_*, lsp process mgr, dap client) against temp stores / fixtures.
- **Live verification:** each phase is live-verified in the running app before
  being called done (operator's standing rule). Requires the dev server running;
  debug via Playwright + console when needed.

## 11. Risks & open questions

- **Vim/keybinding conflicts** with existing app-global shortcuts (⌘⇧-series).
  Phase 1 must scope Zed keybindings to the focused editor and audit collisions.
- **Theme fidelity:** Monaco theming approximates Zed's One-dark; it will not be
  pixel-identical. Accepted (operator wants feel + capability, not pixel match).
- **Phase 4/5 process supervision** on macOS: child processes must be reaped on
  app quit and pane close (compare the TFTP helper daemonization lessons and the
  registry PTY-respawn lesson — avoid orphaned/duplicated processes).
- **Migration number:** if any phase needs a schema migration, next free is
  **V0084** (per project memory). Phases 1–3 likely need none (app_flags only).

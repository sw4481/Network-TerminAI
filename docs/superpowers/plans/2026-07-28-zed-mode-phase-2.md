# Zed Mode Phase 2: Splits and Detached Editor Windows

**Date:** 2026-07-28
**Status:** Implemented on `feature/zed-mode-phase-2`; native interaction matrix pending
**Source design:** `Plans/ZED.md` §5
**Prerequisite:** Zed Mode Phase 1 on `main`

## Current Progress

- [x] Task 1: ordered cross-window Zed snapshots.
- [x] Tasks 2–9: normalized buffers/layout, shared Monaco models, split UI,
  revisioned Rust synchronization, detached windows, and lifecycle integration.
- [x] Task 10 automated acceptance: full suites, production build, Rust check,
  acceptance-spec discovery, and Tauri startup/route smoke.
- [ ] Task 10 native interaction matrix: real split/edit/save/detach/reattach/
  restart clicks in the macOS app.

### Verification snapshot

- Frontend: 217 files and 1,664 tests passed.
- Rust: 379 passed and 5 explicitly ignored library tests; `cargo check` passed.
- `bun run build:relaxed` passed.
- Scoped Phase 2 Rust formatting and `git diff --check` passed.
- `bun run tauri dev` built and launched `target/debug/TerminAI` without a
  runtime error; `?view=editor-detached` was served successfully.
- The strict all-source `tsc --noEmit` command retains unrelated pre-existing
  diagnostics outside Phase 2; the production TypeScript configuration passes.
- `e2e/tauri-driver.ts` currently returns a mock Playwright `Page` and does not
  connect to the Tauri WKWebView or secondary windows. macOS screen capture
  failed and Accessibility inspection was unavailable in this session, so the
  native matrix below is deliberately not marked complete.

## Goal

Add Zed-gated horizontal and vertical editor splits plus native detached editor
windows while keeping Monaco as the editor engine, keeping one logical buffer in
sync across every view, and preserving the current single-editor experience when
classic Monaco mode is selected.

## Current Codebase Ground Truth

Phase 2 must extend the code that exists now:

- `src/components/editor/EditorTab.tsx` owns one editor workspace, file explorer,
  editor toolbar, optional terminal panel, and one Monaco instance.
- `src/state/editorStore.ts` currently stores one file/content/cursor record per
  editor tab. It conflates workspace state, buffer state, and view state.
- `src/components/editor/MonacoEditor.tsx` currently creates an implicit Monaco
  model from `value` and owns that model for one editor instance.
- `src/state/panesStore.ts`, `PaneContainer.tsx`, and `PaneHandle.tsx` already
  prove the recursive split/resize interaction for terminal panes, but their
  persisted leaves contain PTY-specific `terminalId` values.
- `pane_layouts` is already a generic tab-keyed JSON persistence table. Editor
  tabs can use it without a migration because terminal and editor tab IDs cannot
  collide.
- `src-tauri/src/commands/browser.rs` proves backend-created Tauri
  `WebviewWindow` lifecycle and close-handler cleanup, but browser windows load
  external URLs and therefore do not share the app frontend or IPC capability.
- `ZedModeProvider` already synchronizes full mode/Vim snapshots across windows,
  but its events do not yet carry ordering metadata. The Phase 1 handoff
  explicitly requires revision semantics before Phase 2 adds more windows.
- The current Tauri capability targets only `main`. Internal detached editor
  windows need an explicit `editor-*` capability target.

## Scope

### Included

- Split the focused editor pane right or down.
- Clone the focused pane's current buffer into a new view when splitting.
- Open another file into only the focused pane.
- Keep same-file panes synchronized immediately within one webview through one
  shared Monaco text model.
- Resize, focus, navigate, and close editor panes.
- Detach a pane into a native internal Tauri window.
- Keep the detached view synchronized through a revisioned Rust buffer manager.
- Reattach a pane when its detached window closes.
- Persist editor split layouts in the existing `pane_layouts` table.
- Reconcile stale detached markers after an app restart.
- Preserve Phase 1 theme, Vim, keybinding, breadcrumb, save, and cleanup
  behavior in every editor view.

### Not included

- Literal Zed embedding or an external-Zed handoff.
- CRDT/OT collaborative editing between multiple users.
- Restoring native detached windows after a full application restart.
- Moving the file explorer or `EditorTerminalPanel` into a detached window.
- Git gutter/blame/status work from Phase 3.
- Project-wide LSP processes from Phase 4.
- DAP/debugpy work from Phase 5.
- A new database migration.

## Settled User Experience

1. Split and detach controls are visible and active only in Zed Mode.
2. **Split right** creates a side-by-side split. **Split down** creates a
   top/bottom split.
3. A new split initially shows the same buffer as the focused pane. Both views
   have independent cursor, selection, scroll, and Vim state.
4. Selecting a file in the shared explorer opens it in the focused pane only.
   If no pane is focused, the first attached pane is used.
5. Saving applies to the focused pane's buffer. `Cmd/Ctrl+S` inside any pane
   saves that pane's buffer.
6. The last attached pane cannot be closed. It can be detached.
7. Detaching removes the Monaco view from the source pane and leaves a compact
   placeholder with **Focus window** and **Bring back** actions.
8. Closing a detached window automatically reattaches the pane at its original
   layout position.
9. The file explorer remains workspace-wide on the left. The editor terminal
   remains workspace-wide below the complete split tree.
10. A detached window contains one Monaco pane, breadcrumb/header, focused
    buffer status, Save, and Bring Back/Close controls. It does not duplicate
    the explorer or editor terminal.
11. Switching to classic Monaco closes detached editor windows, renders one
    attached pane, and hides all Phase 2 controls. The saved split tree remains
    latent and returns when Zed Mode is enabled again.
12. Phase 2 is single-operator synchronization, not collaborative editing.
    Revision conflicts are ordered and never allow stale snapshots to overwrite
    newer ones; the latest active editor view wins rather than attempting a
    text merge.

## Architecture

```text
EditorTab workspace
├── shared explorer / toolbar
├── EditorSplitTree (Zed Mode)
│   ├── EditorPane ─┐
│   └── EditorPane ─┴── same bufferId -> same Monaco ITextModel
├── one editorStore realm
└── workspace-wide EditorTerminalPanel

                         debounced, one in flight
main webview editorStore ───────────────────────────────┐
                                                       ▼
                                              Rust EditorBufferManager
                                                       │
                                         monotonic revision + global event
                                                       │
detached editorStore ◄─────────────────────────────────┘
        │
        └── Monaco model in a separate webview realm
```

### Frontend state model

`src/state/editorStore.ts` becomes normalized while remaining the single
frontend source of truth:

```ts
export type EditorBufferState = {
  id: string;
  file_path: string | null;
  content: string;
  language: string;
  is_dirty: boolean;
  revision: number;
  sync_status: "local" | "syncing" | "synced" | "conflict" | "error";
  error: string | null;
};

export type EditorPaneLeaf = {
  type: "leaf";
  id: string;
  size: number;
  bufferId: string;
  detachedWindowId: string | null;
  cursor_position: { line: number; column: number };
  scroll_position: number;
};

export type EditorSplitNode = {
  type: "split";
  id: string;
  size: number;
  direction: "horizontal" | "vertical";
  children: EditorPaneNode[];
};

export type EditorWorkspaceState = {
  tabId: string;
  root_path: string | null;
  file_tree: FileNode[];
  expanded_dirs: Set<string>;
  explorer_open: boolean;
  git_status: GitFileStatus[];
  is_git_repo: boolean;
  layout: EditorPaneNode;
  focusedPaneId: string;
  terminal_open: boolean;
};
```

File-backed buffer IDs are deterministic from the normalized file path so the
same file opened in two panes acquires one logical buffer. Untitled buffers use
an opaque UUID. Buffer IDs never appear in a Tauri window label or URL.

### Monaco model ownership

Create a small `monacoModelRegistry`:

- One `ITextModel` per `bufferId` and per webview JavaScript realm.
- Use a stable `monaco.Uri` for identity.
- Reference-count acquisitions from editor instances.
- `EditorPane` switches an existing standalone editor with `editor.setModel`.
- Each editor owns its independent `saveViewState` / `restoreViewState`.
- Same-webview edits flow through the shared model immediately.
- Programmatic remote snapshots use a guarded full-range edit rather than
  unconditional `setValue`, preserving undo history where Monaco permits.
- Dispose a model only after its last view releases it.
- Preserve the existing ordered editor/keybinding/Vim disposal guarantees.

### Cross-window buffer protocol

Rust owns the authoritative revision for every buffer that participates in
detachment:

```ts
export type EditorBufferSnapshot = {
  bufferId: string;
  filePath: string | null;
  content: string;
  language: string;
  dirty: boolean;
  revision: number;
  sourceId: string;
};

export type EditorBufferUpdateResult =
  | { status: "applied"; snapshot: EditorBufferSnapshot }
  | { status: "conflict"; snapshot: EditorBufferSnapshot };
```

Commands:

- `editor_buffer_register(seed)` returns the existing authoritative snapshot or
  creates revision `0`.
- `editor_buffer_get(buffer_id)` returns the current snapshot.
- `editor_buffer_update(buffer_id, base_revision, content, language, dirty,
  source_id)` accepts only the current revision, increments it, and emits
  `editor-buffer-changed`.
- `editor_buffer_mark_saved(buffer_id, revision, source_id)` clears dirty only
  if the revision saved is still current.

Frontend synchronization rules:

- Local typing updates the local Zustand store and shared local Monaco model
  immediately.
- Cross-window publication is coalesced to at most once every 120 ms per buffer.
- Only one update request per buffer may be in flight from a webview.
- Every event and command response is compared by backend revision.
- Older or duplicate snapshots are ignored.
- On conflict, the client adopts the returned revision as its base and retries
  only if it still has newer unsent local content.
- A save that races with a later edit may write the older revision to disk, but
  `mark_saved` will reject the stale revision and the newer buffer remains
  visibly dirty.

This intentionally avoids sending a Tauri event on every keystroke. Tauri's
event API is suitable for small multi-consumer messages, not unbounded
high-throughput streams.

### Detached window lifecycle

Rust adds an `EditorWindowManager` beside the existing browser manager:

```ts
export type DetachedEditorWindowInfo = {
  windowId: string;
  tabId: string;
  paneId: string;
  bufferId: string;
  title: string;
};
```

- Labels are generated only by Rust as `editor-<uuid>`.
- The window loads the internal app URL
  `index.html?view=editor-detached`; no file path or content is placed in the
  URL.
- The detached frontend asks `editor_detached_window_get_current`, whose Rust
  command receives the calling `WebviewWindow` and resolves metadata from its
  label.
- Window build is transactional: registration is rolled back on build failure.
- A close handler unregisters the window and emits
  `editor-detached-window-closed` with the tab and pane IDs.
- Closing an editor tab first closes every detached window owned by that tab,
  then deletes the tab row.
- On layout hydration, detached markers not present in the live window registry
  are cleared so panes recover after a crash/restart.

`src-tauri/capabilities/default.json` must include both `main` and `editor-*`.
Detached windows load only internal app assets; external URLs remain browser
windows and do not receive app IPC.

### Persistence

- Reuse `pane_layouts` with an editor-specific versioned JSON document.
- Persist only layout structure, pane IDs, sizes, file-backed buffer identity,
  and detached markers.
- Do not persist native window existence or unsaved buffer content in Phase 2.
- On restart, file-backed panes rehydrate from disk. Untitled panes rehydrate as
  empty untitled buffers.
- Keep `editor_tab_state` as the compatibility/primary-file record. The focused
  file becomes the primary record when opened or saved.
- No V0084 migration is needed.

## File Responsibilities

### Frontend state and protocol

- Modify `src/state/editorStore.ts`
- Create `src/state/editorStore.test.ts`
- Create `src/components/editor/editorPaneLayout.ts`
- Create `src/components/editor/editorPaneLayout.test.ts`
- Create `src/components/editor/monacoModelRegistry.ts`
- Create `src/components/editor/monacoModelRegistry.test.ts`
- Create `src/components/editor/editorBufferSync.ts`
- Create `src/components/editor/editorBufferSync.test.ts`
- Modify `src/lib/tauri.ts`
- Create `src/lib/editorWindows.test.ts`

### Frontend UI

- Create `src/components/editor/EditorSplitTree.tsx`
- Create `src/components/editor/EditorSplitTree.test.tsx`
- Create `src/components/editor/EditorPane.tsx`
- Create `src/components/editor/EditorPane.test.tsx`
- Create `src/components/editor/DetachedEditorWindow.tsx`
- Create `src/components/editor/DetachedEditorWindow.test.tsx`
- Create `src/components/editor/editor-splits.css`
- Modify `src/components/editor/EditorTab.tsx`
- Modify `src/components/editor/EditorTab.css`
- Modify `src/components/editor/MonacoEditor.tsx`
- Extend `src/components/editor/MonacoEditor.lifecycle.test.ts`
- Modify `src/main.tsx`

### Phase 1 ordering prerequisite

- Create `src/components/editor/zedSnapshotRevision.ts`
- Create `src/components/editor/zedSnapshotRevision.test.ts`
- Modify `src/components/editor/ZedModeProvider.tsx`
- Modify `src/components/editor/ZedModeProvider.test.tsx`

### Rust and Tauri

- Create `src-tauri/src/editor/mod.rs`
- Create `src-tauri/src/editor/buffer_manager.rs`
- Create `src-tauri/src/editor/window_manager.rs`
- Create `src-tauri/src/commands/editor_windows.rs`
- Modify `src-tauri/src/commands/mod.rs`
- Modify `src-tauri/src/lib.rs`
- Modify `src-tauri/src/commands/editor.rs` only where save/tab-close integration
  is required
- Modify `src-tauri/capabilities/default.json`

### Acceptance

- Create `e2e/tests/zed-mode-phase-2.spec.ts`
- Update `Plans/ZED.md` with this plan link and current phase status

## Implementation Tasks

### Task 1: Add ordered Phase 1 snapshots

1. Write pure tests for revision comparison:
   - larger counter wins;
   - an equal counter uses `sourceId` as a deterministic tie-break;
   - equal revisions are duplicates;
   - hydration revision zero cannot overwrite a live revision.
2. Add `{ counter, sourceId }` to complete Zed mode event snapshots.
3. Give each provider realm one stable source UUID.
4. Ignore out-of-order/duplicate events.
5. Preserve the existing listen-before-hydrate race protection.
6. Verify rapid `setVimEnabled` then `setMode` still emits complete snapshots.

Focused verification:

```bash
bunx vitest run \
  src/components/editor/zedSnapshotRevision.test.ts \
  src/components/editor/ZedModeProvider.test.tsx \
  --exclude '**/.worktrees/**' \
  --exclude '**/.claude/worktrees/**'
```

### Task 2: Normalize editor buffers, workspaces, and layout operations

1. Add failing pure store/layout tests before changing `EditorTab`.
2. Implement initialize, split, resize, close, focus, detach-marker, reattach,
   and stale-marker reconciliation operations.
3. Splitting must retain the original pane ID for the original view when
   possible so focus and detached placeholders stay stable.
4. Deduplicate file-backed buffers by normalized file path.
5. Make content writes no-op when text is unchanged.
6. Add versioned layout serialization and tolerant hydration.
7. Use `panes_get_layout` / `panes_save_layout` only for editor tab IDs.
8. Preserve existing terminal `panesStore` behavior and JSON.

Focused verification:

```bash
bunx vitest run \
  src/state/editorStore.test.ts \
  src/components/editor/editorPaneLayout.test.ts \
  src/state/panesStore.test.ts \
  --exclude '**/.worktrees/**' \
  --exclude '**/.claude/worktrees/**'
```

### Task 3: Share Monaco models safely

1. Test acquire/reuse/reference-count/release behavior with a fake Monaco API.
2. Test two editor views acquiring the same buffer receive the same model.
3. Test a different buffer gets a different URI/model.
4. Test model switching saves and restores per-pane view state.
5. Refactor `MonacoEditor` to accept `bufferId` and an explicit model.
6. Keep callbacks in refs so pane/model switches never call stale handlers.
7. Preserve Ask AI, LSP, theme, keybinding, Vim, and ordered disposal behavior.
8. Guard programmatic content application to prevent feedback loops.

Focused verification:

```bash
bunx vitest run \
  src/components/editor/monacoModelRegistry.test.ts \
  src/components/editor/MonacoEditor.lifecycle.test.ts \
  src/components/editor/useVimMode.test.tsx \
  src/components/editor/zedKeybindings.test.ts \
  --exclude '**/.worktrees/**' \
  --exclude '**/.claude/worktrees/**'
```

### Task 4: Render and operate the split tree

1. Build `EditorPane` around one buffer/model and one independent view state.
2. Build recursive `EditorSplitTree` using the established `PaneHandle`
   resize interaction.
3. Add pane-local header controls: focus, split right, split down, detach, and
   close.
4. Refactor `EditorTab` so explorer, toolbar, and terminal remain workspace
   level while editor panes render inside the tree.
5. Route explorer open and toolbar save to the focused pane.
6. Ensure the last attached pane cannot be closed.
7. Add accessible labels, focus indication, keyboard focus traversal, and
   deterministic test IDs.
8. Gate every Phase 2 control and split rendering on `mode === "zed"`.
9. In classic mode render one attached pane through the legacy visual path.

Focused verification:

```bash
bunx vitest run \
  src/components/editor/EditorPane.test.tsx \
  src/components/editor/EditorSplitTree.test.tsx \
  src/components/editor/EditorBreadcrumbs.test.tsx \
  src/components/editor/EditorTerminalPanel.test.tsx \
  src/components/editor/FileExplorer.test.tsx \
  --exclude '**/.worktrees/**' \
  --exclude '**/.claude/worktrees/**'
```

### Task 5: Add the revisioned Rust buffer manager

1. Write manager tests without a Tauri runtime.
2. Register a new seed at revision zero.
3. Return the existing snapshot when the same buffer registers again.
4. Accept an update only when `base_revision` matches.
5. Increment revisions exactly once per accepted update.
6. Return the current snapshot on conflict without mutating it.
7. Mark saved only when the expected revision is still current.
8. Register typed commands and emit only accepted snapshots.
9. Add `editor_buffer_manager` to `AppState`.

Focused verification:

```bash
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo test --manifest-path src-tauri/Cargo.toml editor_buffer -- --nocapture
cargo check --manifest-path src-tauri/Cargo.toml
```

### Task 6: Add the coalesced frontend synchronization client

1. Test one-in-flight and 120 ms coalescing with fake timers.
2. Test stale events are ignored.
3. Test an applied response advances the base revision.
4. Test a conflict retries only when newer local text is still pending.
5. Test teardown cancels timers/listeners and does not publish after unmount.
6. Integrate registration when a file/untitled buffer first becomes detachable.
7. Integrate `mark_saved` after a successful disk write.
8. Surface `sync_status` without blocking local editing.

Focused verification:

```bash
bunx vitest run \
  src/components/editor/editorBufferSync.test.ts \
  src/lib/editorWindows.test.ts \
  --exclude '**/.worktrees/**' \
  --exclude '**/.claude/worktrees/**'
```

### Task 7: Create and supervise detached internal windows

1. Write pure registry tests for register/list/get/unregister/by-tab behavior.
2. Add `editor_detach_pane`, `editor_detached_window_get_current`,
   `editor_detached_window_list`, `editor_detached_window_focus`, and
   `editor_detached_window_close` commands.
3. Reject detach while persisted editor mode is classic.
4. Build an internal `WebviewWindow` with a Rust-generated `editor-*` label.
5. Roll back registry state if window creation fails.
6. On close, unregister and emit the close payload.
7. Close all tab-owned detached windows before `tab_close_editor` removes the
   database row.
8. Add `editor-*` to the app capability without broadening external browser
   window access.

Focused verification:

```bash
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo test --manifest-path src-tauri/Cargo.toml editor_window -- --nocapture
cargo check --manifest-path src-tauri/Cargo.toml
```

### Task 8: Build the detached-window frontend

1. Route `?view=editor-detached` in `src/main.tsx` while keeping both entry
   paths under `ZedModeProvider`.
2. Hydrate metadata from the calling window label, then hydrate its buffer.
3. Render exactly one `EditorPane` without explorer or terminal.
4. Wire Save, Focus Source, Bring Back, and Close behavior.
5. Listen for buffer revisions before applying hydration so a live update cannot
   be overwritten by a late initial response.
6. Close cleanly when mode changes to classic.
7. Render a recoverable error state if metadata no longer exists.

Focused verification:

```bash
bunx vitest run \
  src/components/editor/DetachedEditorWindow.test.tsx \
  src/components/editor/ZedModeProvider.test.tsx \
  --exclude '**/.worktrees/**' \
  --exclude '**/.claude/worktrees/**'
```

### Task 9: Integrate lifecycle and compatibility behavior

1. Reconcile stale detached markers on workspace hydration.
2. Reattach placeholders on the close event.
3. Prevent a close event from resurrecting a workspace whose tab was deleted.
4. Preserve dirty state and latest revision through detach/reattach.
5. Verify split close never disposes a shared model still used by another pane.
6. Verify classic mode has no split/detach buttons and one visible Monaco.
7. Verify returning to Zed Mode restores the latent split tree.
8. Verify terminal split shortcuts and terminal pane persistence are unchanged.

### Task 10: Acceptance and live verification

Add `e2e/tests/zed-mode-phase-2.spec.ts` for the single-window path:

- enable Zed Mode;
- create an editor tab;
- split right and then down;
- type in one same-buffer view and observe the other;
- focus another pane and open another file only there;
- resize and close a pane;
- switch to classic and confirm one editor/no Phase 2 controls;
- switch back and confirm the split tree returns;
- restore classic mode in `finally`.

Run:

```bash
bunx vitest run \
  --exclude '**/.worktrees/**' \
  --exclude '**/.claude/worktrees/**'
bun run build:relaxed
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo test --manifest-path src-tauri/Cargo.toml --lib
cargo check --manifest-path src-tauri/Cargo.toml
```

Then live-verify in the Tauri app:

1. Same buffer in two side-by-side panes updates immediately.
2. Cursors, scroll positions, and Vim modes remain independent.
3. Different files can occupy different panes.
4. Save from each pane writes only that pane's file.
5. Detach opens a native TerminAI editor window.
6. Main and detached views converge after typing in either window.
7. Rapid focus/type switching never rolls content back to an older revision.
8. Closing detached reattaches at the original position.
9. Closing the source tab closes its detached windows.
10. Restart after force-closing the app recovers stale detached placeholders.
11. Classic mode returns to one editor and closes detached windows.
12. Re-enabling Zed restores the saved split layout.

The current Playwright/Tauri multi-window harness may not expose secondary
windows reliably. If it cannot, record the exact harness limitation and perform
the detached-window portion as an explicit live matrix rather than claiming
automated coverage.

## Verification Gates

Phase 2 is complete only when:

- All new focused frontend and Rust tests pass.
- The full frontend suite passes without new failures.
- Relaxed production build passes.
- Rust library tests and `cargo check` pass.
- Any pre-existing strict TypeScript, doctest, formatting, or macOS driver
  failures are reproduced on the Phase 2 base and documented separately.
- No generated Graphify output, build output, database, or temporary fixture is
  committed.
- Classic Monaco remains behaviorally equivalent to Phase 1 classic mode.
- The live detached-window matrix is completed with real window, edit, save,
  close, reattach, and restart evidence.

## Risks and Mitigations

### Stale cross-window snapshots

Mitigation: listen before hydrate, backend monotonic revisions, one in-flight
update, coalescing, stale-event rejection, and conflict retry tests.

### Undo/cursor corruption from controlled values

Mitigation: shared Monaco models within a webview, independent view state, guarded
programmatic edits, and model reference-count tests.

### Window registry leaks

Mitigation: transactional registration, Tauri close handlers, tab-close cleanup,
and stale-marker reconciliation after restart.

### Classic-mode regression

Mitigation: strict Zed gating, latent rather than destructive split collapse,
and acceptance that toggles Zed -> classic -> Zed.

### Terminal split regression

Mitigation: do not reuse PTY leaf types or modify terminal layout JSON; reuse
only the visual resize interaction and run the existing `panesStore` tests.

### Large-buffer event cost

Mitigation: local shared models, 120 ms coalescing, one in-flight snapshot,
revision deduplication, and no event-per-keystroke loop.

## Definition of Done

The operator can enable Zed Mode, split the editor in either direction, edit the
same or different files in independent panes, detach any pane into a native
TerminAI window, continue editing and saving without stale content rollback,
close or reattach the window, and return to classic Monaco with no Phase 2
behavior left active.

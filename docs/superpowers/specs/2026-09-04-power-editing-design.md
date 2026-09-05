# Power Editing Design

## Goal

Add a small Notepad++-inspired power-editing layer to the existing TerminAI Monaco editor. The first slice makes already-supported Monaco editing primitives discoverable and adds bookmarks, without replacing Monaco or changing the Tauri/sidecar architecture.

## Facts established from the repository

- `package.json` pins `monaco-editor` to `0.52.2`.
- `src/components/editor/MonacoEditor.tsx` already enables folding, formatting on paste/type, suggestions, line numbers, whitespace rendering, and model-backed editing.
- The installed Monaco 0.52.2 sources contain actions for multi-cursor editing, line copy/move/delete, duplicate/sort/remove-duplicate lines, indentation, case transforms, trailing-whitespace trimming, and folding.
- Monaco exposes the `columnSelection` editor option in the installed version.
- TerminAI currently registers only Ask AI actions in the editor-specific action-registration block. Save is registered separately with `addCommand`.
- `src/state/editorStore.ts` and `src/components/editor/editorPaneLayout.ts` already own buffer identity, pane view state, and persistence of pane layout.
- `src/components/editor/DetachedEditorWindow.tsx` creates an independent editor webview and synchronizes buffer content through `EditorBufferSyncClient`.
- Existing tests cover editor lifecycle, model ownership, pane layout, editor settings, detached windows, and buffer synchronization.

## Scope

1. Register a tested, labeled action catalog that delegates to Monaco's built-in commands.
2. Expose column selection as an editor setting using Monaco's existing `columnSelection` option.
3. Add in-session bookmarks with toggle, next, previous, and clear-all actions.
4. Keep the feature available in both attached and detached Monaco editors.
5. Add focused unit/integration coverage and update the user-facing shortcut/help reference without inventing undocumented shortcuts.

## Deliberate non-goals

- No editor-engine replacement, new editing dependency, or package-lock change.
- No Rust command, database migration, sidecar, LSP, Git, terminal, or notebook changes.
- No workspace-wide Find in Files; the existing single-editor Find & Replace remains unchanged.
- No macro recorder, plugin system, autosave/recovery, or cross-restart bookmark persistence in this slice.
- No cross-webview bookmark synchronization. Attached and detached editors may maintain separate in-session bookmark state until a later persistence design is approved.

## Design

`powerEditingActions.ts` will contain a small immutable catalog and a registration function. Each action has a TerminAI action id, a user-facing label, and a verified Monaco command id. Registration uses `editor.addAction`; execution delegates with `editor.trigger`, so line and selection semantics remain Monaco's responsibility. The catalog will not assign new keyboard shortcuts; users retain Monaco's version-specific defaults and can invoke the actions from the editor context menu.

Bookmarks will use a small pure line-set helper plus a controller attached to each Monaco instance. The controller stores sorted one-based line numbers by buffer id for the lifetime of that editor webview, switches its active buffer when the existing Monaco pane model switches, applies Monaco glyph-margin decorations, and exposes the four bookmark actions. It will be disposed with the existing editor registration lifecycle. Bookmark state will not be added to the authoritative content-sync protocol or persisted layout JSON in this slice.

The existing `glyphMargin: mode === "zed"` setting will become `glyphMargin: true` for power-editing-capable editors so bookmark markers render consistently in both modes. The existing Zed debug decorations continue to use that margin. All changes remain inside the editor frontend.

## Acceptance criteria

- All catalog command ids are present in the pinned Monaco 0.52.2 dependency before implementation.
- Context-menu actions invoke Monaco's built-in behavior for multi-cursor, line operations, indentation, case transforms, whitespace cleanup, sorting, and folding.
- Column selection can be enabled and disabled from Editor Settings and reaches Monaco through `updateOptions`.
- Bookmark toggle is idempotent, next/previous wrap around, clear-all removes all markers, and invalid line numbers are rejected by pure logic.
- Bookmark actions work in attached and detached editors without leaking decorations or registrations after disposal.
- Existing editor, detached-window, theme, LSP, Git, and sidecar behavior remains unchanged.
- Focused Vitest tests, the existing full frontend suite, `bun run build`, and the project's `./run.sh` sidecar health checks pass.

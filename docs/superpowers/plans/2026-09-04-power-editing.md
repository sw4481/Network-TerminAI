# Power Editing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a minimal Notepad++-inspired power-editing layer to TerminAI's existing Monaco editor.

**Architecture:** Reuse Monaco 0.52.2's built-in editing commands and add only a thin, tested action-registration layer. Add bookmarks as editor-webview runtime state with Monaco glyph-margin decorations; do not expand the Rust protocol, sidecar, database schema, or layout persistence in this slice.

**Tech Stack:** React, TypeScript, Monaco Editor 0.52.2, Zustand, Vitest, Tauri.

**Spec:** `docs/superpowers/specs/2026-09-04-power-editing-design.md`

## Global Constraints

- Do not add an npm dependency or change `package.json` / lockfiles.
- Do not modify Rust, Python sidecar, database migrations, LSP, Git, terminal, notebook, or AI behavior.
- Do not reimplement editing semantics that Monaco already provides.
- Do not assign undocumented or conflicting new keyboard shortcuts; use Monaco defaults and editor context-menu actions.
- Keep bookmark state in the current webview only; do not alter authoritative buffer synchronization or persisted layout JSON.
- Preserve unrelated dirty files, including `scripts/__pycache__/` and `scripts/tests/__pycache__/`.
- Before claiming completion, run focused tests, the full frontend test/build checks, `./run.sh`, and the sidecar health gates required by `AGENTS.md`.

## Verified Baseline

- Editor entry point: `src/components/editor/MonacoEditor.tsx`.
- Editor settings: `src/hooks/useEditorSettings.ts` and `src/components/editor/EditorSettings.tsx`.
- Attached editor composition: `src/components/editor/EditorPane.tsx`, `EditorSplitTree.tsx`, and `EditorTab.tsx`.
- Detached editor composition: `src/components/editor/DetachedEditorWindow.tsx`.
- Existing editor registration lifecycle: the `editorDisposables` array and `createEditorDisposalOwnership` in `MonacoEditor.tsx`.
- Existing tests: `src/components/editor/MonacoEditor.appearance.test.tsx`, `MonacoEditor.lifecycle.test.ts`, `editorPaneLayout.test.ts`, `src/state/editorStore.test.ts`, and `DetachedEditorWindow.test.tsx`.
- Verified Monaco command ids in the installed dependency: `editor.action.insertCursorAtEndOfEachLineSelected`, `editor.action.addCursorsToTop`, `editor.action.addCursorsToBottom`, `editor.action.copyLinesUpAction`, `editor.action.copyLinesDownAction`, `editor.action.moveLinesUpAction`, `editor.action.moveLinesDownAction`, `editor.action.deleteLines`, `editor.action.duplicateSelection`, `editor.action.joinLines`, `editor.action.indentLines`, `editor.action.outdentLines`, `editor.action.reindentlines`, `editor.action.sortLinesAscending`, `editor.action.sortLinesDescending`, `editor.action.removeDuplicateLines`, `editor.action.trimTrailingWhitespace`, `editor.action.transformToUppercase`, `editor.action.transformToLowercase`, `editor.fold`, `editor.unfold`, `editor.foldAll`, and `editor.unfoldAll`.

### Task 1: Add the verified Monaco power-action catalog

**Files:**
- Create: `src/components/editor/powerEditingActions.ts`
- Create: `src/components/editor/powerEditingActions.test.ts`

**Interfaces:**
- Produces `POWER_EDITING_ACTIONS: readonly PowerEditingAction[]`.
- Produces `registerPowerEditingActions(editor): Monaco.IDisposable`.
- `PowerEditingAction` is `{ id: string; label: string; commandId: string; order: number }`.

- [ ] **Step 1: Reconfirm the dependency facts before writing the catalog.**

Run:

```bash
rg -n -o "editor\\.(action\\.)?[A-Za-z0-9]+" \
  node_modules/monaco-editor/esm/vs/editor \
  --glob '*.js' \
  | rg "insertCursorAtEndOfEachLineSelected|addCursorsToTop|addCursorsToBottom|copyLines|moveLines|deleteLines|duplicateSelection|joinLines|indentLines|outdentLines|reindent|sortLines|removeDuplicateLines|trimTrailingWhitespace|transformTo(Upper|Lower)case|editor\\.(fold|unfold)"
```

Expected: every command id listed in `Verified Baseline` is present. If a command is absent, remove only that catalog entry and record the installed command as the fact used by the implementation; do not guess a replacement id.

- [ ] **Step 2: Write the failing catalog and registration tests.**

Test the exact contract with a small fake editor:

```ts
it("contains only verified Monaco command ids", () => {
  expect(POWER_EDITING_ACTIONS.map((action) => action.commandId)).toEqual([
    "editor.action.insertCursorAtEndOfEachLineSelected",
    "editor.action.addCursorsToTop",
    "editor.action.addCursorsToBottom",
    "editor.action.copyLinesUpAction",
    "editor.action.copyLinesDownAction",
    "editor.action.moveLinesUpAction",
    "editor.action.moveLinesDownAction",
    "editor.action.deleteLines",
    "editor.action.duplicateSelection",
    "editor.action.joinLines",
    "editor.action.indentLines",
    "editor.action.outdentLines",
    "editor.action.reindentselectedlines",
    "editor.action.sortLinesAscending",
    "editor.action.sortLinesDescending",
    "editor.action.removeDuplicateLines",
    "editor.action.trimTrailingWhitespace",
    "editor.action.transformToUppercase",
    "editor.action.transformToLowercase",
    "editor.fold",
    "editor.unfold",
    "editor.foldAll",
    "editor.unfoldAll",
  ]);
});

it("registers labeled actions that delegate to Monaco", () => {
  const addAction = vi.fn((descriptor) => ({ dispose: vi.fn(), descriptor }));
  const trigger = vi.fn();
  const editor = { addAction, trigger } as unknown as Monaco.editor.IStandaloneCodeEditor;

  const registration = registerPowerEditingActions(editor);
  const descriptor = addAction.mock.calls[0][0] as any;
  descriptor.run(editor);

  expect(descriptor.contextMenuGroupId).toBe("2_powerEditing");
  expect(trigger).toHaveBeenCalledWith("power-editing", descriptor.commandId, undefined);
  registration.dispose();
  expect(addAction.mock.results[0].value.dispose).toHaveBeenCalledOnce();
});
```

Expected before implementation: FAIL because the module and registration function do not exist.

- [ ] **Step 3: Implement the immutable catalog and minimal registration loop.**

Use this shape and no additional abstraction:

```ts
import type * as Monaco from "monaco-editor";

export type PowerEditingAction = {
  id: string;
  label: string;
  commandId: string;
  order: number;
};

export const POWER_EDITING_ACTIONS: readonly PowerEditingAction[] = [
  { id: "multicursor-lines", label: "Add Cursors to Selected Lines", commandId: "editor.action.insertCursorAtEndOfEachLineSelected", order: 1 },
  { id: "multicursor-top", label: "Add Cursor Above", commandId: "editor.action.addCursorsToTop", order: 2 },
  { id: "multicursor-bottom", label: "Add Cursor Below", commandId: "editor.action.addCursorsToBottom", order: 3 },
  { id: "copy-lines-up", label: "Copy Lines Up", commandId: "editor.action.copyLinesUpAction", order: 10 },
  { id: "copy-lines-down", label: "Copy Lines Down", commandId: "editor.action.copyLinesDownAction", order: 11 },
  { id: "move-lines-up", label: "Move Lines Up", commandId: "editor.action.moveLinesUpAction", order: 12 },
  { id: "move-lines-down", label: "Move Lines Down", commandId: "editor.action.moveLinesDownAction", order: 13 },
  { id: "delete-lines", label: "Delete Lines", commandId: "editor.action.deleteLines", order: 14 },
  { id: "duplicate-selection", label: "Duplicate Selection", commandId: "editor.action.duplicateSelection", order: 15 },
  { id: "join-lines", label: "Join Lines", commandId: "editor.action.joinLines", order: 16 },
  { id: "indent-lines", label: "Indent Lines", commandId: "editor.action.indentLines", order: 20 },
  { id: "outdent-lines", label: "Outdent Lines", commandId: "editor.action.outdentLines", order: 21 },
  { id: "reindent-selection", label: "Reindent Selected Lines", commandId: "editor.action.reindentselectedlines", order: 22 },
  { id: "sort-ascending", label: "Sort Lines Ascending", commandId: "editor.action.sortLinesAscending", order: 30 },
  { id: "sort-descending", label: "Sort Lines Descending", commandId: "editor.action.sortLinesDescending", order: 31 },
  { id: "remove-duplicates", label: "Remove Duplicate Lines", commandId: "editor.action.removeDuplicateLines", order: 32 },
  { id: "trim-whitespace", label: "Trim Trailing Whitespace", commandId: "editor.action.trimTrailingWhitespace", order: 33 },
  { id: "uppercase", label: "Transform to Uppercase", commandId: "editor.action.transformToUppercase", order: 40 },
  { id: "lowercase", label: "Transform to Lowercase", commandId: "editor.action.transformToLowercase", order: 41 },
  { id: "fold", label: "Fold", commandId: "editor.fold", order: 50 },
  { id: "unfold", label: "Unfold", commandId: "editor.unfold", order: 51 },
  { id: "fold-all", label: "Fold All", commandId: "editor.foldAll", order: 52 },
  { id: "unfold-all", label: "Unfold All", commandId: "editor.unfoldAll", order: 53 },
];

export function registerPowerEditingActions(
  editor: Monaco.editor.IStandaloneCodeEditor,
): Monaco.IDisposable {
  const registrations = POWER_EDITING_ACTIONS.map((action) =>
    editor.addAction({
      id: `ccie.editor.powerEditing.${action.id}`,
      label: action.label,
      contextMenuGroupId: "2_powerEditing",
      contextMenuOrder: action.order,
      run: (target) => target.trigger("power-editing", action.commandId, undefined),
    }),
  );
  return { dispose: () => registrations.forEach((registration) => registration.dispose()) };
}
```

- [ ] **Step 4: Run the focused test.**

Run: `bunx vitest run src/components/editor/powerEditingActions.test.ts`

Expected: PASS, with no Monaco runtime startup required.

- [ ] **Step 5: Commit the isolated catalog.**

```bash
git add src/components/editor/powerEditingActions.ts src/components/editor/powerEditingActions.test.ts
git commit -m "feat(editor): expose Monaco power editing actions"
```

### Task 2: Integrate the action catalog and column selection setting

**Files:**
- Modify: `src/components/editor/MonacoEditor.tsx`
- Modify: `src/components/editor/EditorSettings.tsx`
- Create: `src/components/editor/MonacoEditor.powerEditing.test.tsx`
- Create: `src/components/editor/EditorSettings.test.tsx`
- Test: `src/components/editor/MonacoEditor.powerEditing.test.tsx`

**Interfaces:**
- Consumes `registerPowerEditingActions(editor)` from Task 1.
- Extends `EditorSettings` with `columnSelection: boolean`.
- Preserves `useEditorSettings()` local-storage behavior and existing default values.

- [ ] **Step 1: Add failing settings assertions.**

Add tests that assert the default and the actual Monaco creation options:

```ts
expect(DEFAULT_EDITOR_SETTINGS.columnSelection).toBe(false);
expect(monaco.editor.create).toHaveBeenCalledWith(
  expect.anything(),
  expect.objectContaining({ columnSelection: false }),
);
```

For the rendered settings panel, click the `Column Selection` checkbox, save, and assert the callback receives `{ ...settings, columnSelection: true }`.

Expected before implementation: TypeScript/test failure because `columnSelection` is not part of the current settings type or editor options.

- [ ] **Step 2: Register power actions in the existing Monaco lifecycle.**

In the existing `useEffect` that creates the editor, immediately after the Ask AI registrations, add:

```ts
editorDisposables.push(registerPowerEditingActions(editor));
```

Do not create a second editor effect and do not add a second disposal mechanism. The existing `editorDisposables` ownership path must dispose these actions.

- [ ] **Step 3: Pass the column-selection setting to Monaco.**

Add the field to `EditorSettings` and `DEFAULT_EDITOR_SETTINGS`, then include it in both the initial `monaco.editor.create` options and the existing `editor.updateOptions` effect:

```ts
columnSelection: settings.columnSelection,
```

Do not change `tabSize`, `wordWrap`, minimap, line numbers, whitespace, themes, or mode behavior.

- [ ] **Step 4: Add one checkbox to the existing editor settings panel.**

Use the existing checkbox pattern and the exact label `Column Selection`:

```tsx
<label>
  <input
    type="checkbox"
    checked={local.columnSelection}
    onChange={(event) => update("columnSelection", event.target.checked)}
  />
  Column Selection
</label>
```

- [ ] **Step 5: Run focused settings and editor tests.**

Run:

```bash
bunx vitest run src/components/editor/powerEditingActions.test.ts src/components/editor/MonacoEditor.powerEditing.test.tsx src/components/editor/EditorSettings.test.tsx
```

Expected: PASS with coverage for the new checkbox and the actual Monaco option.

- [ ] **Step 6: Commit the integration.**

```bash
git add src/components/editor/MonacoEditor.tsx src/components/editor/EditorSettings.tsx src/components/editor/MonacoEditor.powerEditing.test.tsx src/components/editor/EditorSettings.test.tsx
git commit -m "feat(editor): enable column selection"
```

### Task 3: Add pure bookmark line-state logic

**Files:**
- Create: `src/components/editor/bookmarks.ts`
- Create: `src/components/editor/bookmarks.test.ts`

**Interfaces:**
- `normalizeBookmarkLines(lines: readonly number[], lineCount: number): number[]`
- `toggleBookmarkLine(lines: readonly number[], line: number, lineCount: number): number[]`
- `nextBookmarkLine(lines: readonly number[], currentLine: number): number | null`
- `previousBookmarkLine(lines: readonly number[], currentLine: number): number | null`

- [ ] **Step 1: Write failing pure-logic tests.**

Cover these exact cases:

```ts
expect(normalizeBookmarkLines([4, 1, 4, 0, -2, 9], 5)).toEqual([1, 4]);
expect(toggleBookmarkLine([1, 4], 4, 5)).toEqual([1]);
expect(toggleBookmarkLine([1], 3, 5)).toEqual([1, 3]);
expect(nextBookmarkLine([2, 5, 9], 5)).toBe(9);
expect(nextBookmarkLine([2, 5, 9], 9)).toBe(2);
expect(previousBookmarkLine([2, 5, 9], 2)).toBe(9);
expect(previousBookmarkLine([2, 5, 9], 5)).toBe(2);
expect(nextBookmarkLine([], 4)).toBeNull();
```

Expected before implementation: FAIL because the module does not exist.

- [ ] **Step 2: Implement only sorted, one-based line-set operations.**

Reject non-integer lines, lines below 1, and lines greater than `lineCount`. Return new arrays; never mutate the caller's array. Deduplicate and sort ascending in `normalizeBookmarkLines`.

- [ ] **Step 3: Run the pure tests.**

Run: `bunx vitest run src/components/editor/bookmarks.test.ts`

Expected: PASS.

- [ ] **Step 4: Commit the pure bookmark logic.**

```bash
git add src/components/editor/bookmarks.ts src/components/editor/bookmarks.test.ts
git commit -m "feat(editor): add bookmark line-state helpers"
```

### Task 4: Add the Monaco bookmark controller and decorations

**Files:**
- Create: `src/components/editor/bookmarkController.ts`
- Create: `src/components/editor/bookmarkController.test.ts`
- Modify: `src/components/editor/MonacoEditor.tsx`
- Modify: `src/components/editor/MonacoEditor.css`

**Interfaces:**
- Produces `createBookmarkController(editor, monaco, bufferId): BookmarkController`.
- `BookmarkController` exposes `setBuffer(bufferId): void`, `dispose(): void`, `getLines(): readonly number[]`, `toggleCurrentLine(): void`, `next(): void`, `previous(): void`, and `clear(): void`.
- Consumes the pure functions from Task 3 and Monaco's `deltaDecorations`, `getPosition`, `getModel`, `setPosition`, and `revealLineInCenter` APIs.

- [ ] **Step 1: Write failing controller tests with a fake editor/model.**

Assert that:

```ts
it("toggles the current one-based line and renders one glyph decoration", () => {
  const controller = createBookmarkController(editorAtLine(4), monaco, "file:/repo/a.ts");
  controller.toggleCurrentLine();
  expect(controller.getLines()).toEqual([4]);
  expect(editor.deltaDecorations).toHaveBeenCalledWith([], [
    expect.objectContaining({
      range: expect.objectContaining({ startLineNumber: 4, endLineNumber: 4 }),
      options: expect.objectContaining({ glyphMarginClassName: "ccie-editor-bookmark-glyph" }),
    }),
  ]);
});

it("wraps navigation and disposes the current decorations", () => {
  // Seed lines 2 and 5, navigate from line 5 to line 2, then dispose.
  expect(editor.setPosition).toHaveBeenCalledWith({ lineNumber: 2, column: 1 });
  controller.dispose();
  expect(editor.deltaDecorations).toHaveBeenLastCalledWith(expect.any(Array), []);
});
```

Expected before implementation: FAIL because the controller does not exist.

- [ ] **Step 2: Implement runtime-local bookmark state keyed by buffer id.**

Use a `Map<string, number[]>` owned by the controller for the current webview only. `setBuffer(bufferId)` must remove the previous buffer's decoration ids, switch the active key, and render that buffer's saved-in-webview lines on the editor's current model. Read the current model line count before every mutation, normalize state, replace decorations through `deltaDecorations`, and use one decoration id list for the active buffer. Do not write to Zustand, Tauri, SQLite, or `EditorBufferSyncClient`.

- [ ] **Step 3: Register four bookmark actions through the controller.**

Use `editor.addAction` with these labels and action ids:

```ts
Toggle Bookmark       -> ccie.editor.bookmark.toggle
Next Bookmark         -> ccie.editor.bookmark.next
Previous Bookmark     -> ccie.editor.bookmark.previous
Clear All Bookmarks   -> ccie.editor.bookmark.clear
```

Use the same `contextMenuGroupId: "2_powerEditing"`. Do not assign shortcuts. Each action must call only the corresponding controller method.

- [ ] **Step 4: Make bookmark markers render in both editor modes.**

Change the existing editor creation and read-only update options so the glyph margin is always enabled for the power-editing-capable Monaco editor:

```ts
glyphMargin: true,
```

Do not leave a later `glyphMargin: mode === "zed"` update that turns the margin off. The existing Zed debug decorations continue to use the same margin. Add the smallest CSS rule that makes the glyph visible using existing theme variables:

```css
.ccie-editor-bookmark-glyph {
  background: var(--status-info);
  width: 8px;
  height: 8px;
  margin: 5px 2px 0;
  border-radius: 50%;
}
```

If the existing theme contract does not define `--status-info`, use the already-defined semantic status variable found by `rg -n "status-info|--status" src/theme src/**/*.css`; do not introduce a literal color.

- [ ] **Step 5: Install and dispose the controller through the existing Monaco ownership path.**

In the same effect that creates the editor, after the model/editor is available:

```ts
const bookmarks = createBookmarkController(editor, monaco, bufferIdRef.current);
editorDisposables.push({ dispose: bookmarks.dispose });
```

Keep the controller in a ref and call `bookmarks.setBuffer(activeBufferId)` in the existing model-switch effect after `paneModelControllerRef.current?.switchTo(...)`. Do not store controller state in React state. This avoids re-rendering on every bookmark toggle and ensures detached windows receive the same behavior through their existing `EditorPane`/`MonacoEditor` path.

- [ ] **Step 6: Run focused controller and lifecycle tests.**

Run: `bunx vitest run src/components/editor/bookmarks.test.ts src/components/editor/bookmarkController.test.ts src/components/editor/MonacoEditor.powerEditing.test.tsx src/components/editor/MonacoEditor.lifecycle.test.ts`

Expected: PASS, including disposal without leaked actions or decorations.

- [ ] **Step 7: Commit the bookmark controller.**

```bash
git add src/components/editor/bookmarks.ts src/components/editor/bookmarks.test.ts src/components/editor/bookmarkController.ts src/components/editor/bookmarkController.test.ts src/components/editor/MonacoEditor.tsx src/components/editor/MonacoEditor.css
git commit -m "feat(editor): add runtime bookmark actions"
```

### Task 5: Document discoverability without inventing shortcuts

**Files:**
- Modify: `src/components/help/content/shortcuts.ts`
- Modify: `src/components/help/HelpModal.test.tsx`

**Interfaces:**
- Consumes the existing `SHORTCUTS_MD` string.
- Produces a short `Editor Power Editing` section that describes context-menu actions and Monaco's command palette entry point without claiming custom keybindings.

- [ ] **Step 1: Add a failing content assertion to `src/components/help/HelpModal.test.tsx`.**

Import `SHORTCUTS_MD` and assert that it contains the exact heading `## Editor Power Editing`, `F1`, `Toggle Bookmark`, `Next Bookmark`, and `Column Selection`.

- [ ] **Step 2: Add the minimal help section.**

Use factual copy:

```md
## Editor Power Editing

Inside an editor, use the context menu for multi-cursor, line operations,
indentation, case transforms, folding, and bookmarks. Press `F1` inside the
Monaco editor to search the available editor commands. Enable `Column
Selection` in Editor Settings for rectangular mouse/keyboard selection.
```

Do not list default Monaco key combinations unless they are verified against the pinned Monaco version and platform behavior.

- [ ] **Step 3: Run the help test.**

Run: `bunx vitest run src/components/help/HelpModal.test.tsx`

Expected: PASS.

- [ ] **Step 4: Commit discoverability copy.**

```bash
git add src/components/help/content/shortcuts.ts src/components/help/HelpModal.test.tsx
git commit -m "docs(editor): document power editing actions"
```

### Task 6: Verify the complete editor and release path

**Files:**
- No source changes expected.
- Inspect: all files changed by Tasks 1–5 and `git status --short`.

- [ ] **Step 1: Run focused editor tests.**

```bash
bunx vitest run \
  src/components/editor/powerEditingActions.test.ts \
  src/components/editor/MonacoEditor.powerEditing.test.tsx \
  src/components/editor/bookmarks.test.ts \
  src/components/editor/bookmarkController.test.ts \
  src/components/editor/MonacoEditor.lifecycle.test.ts \
  src/components/editor/DetachedEditorWindow.test.tsx \
  src/components/editor/EditorSplitTree.test.tsx \
  src/state/editorStore.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run repository checks.**

```bash
bun run test
bun run build
git diff --check
```

Expected: PASS with no structural-color or theme-contrast regressions.

- [ ] **Step 3: Launch through the required development path.**

Run: `./run.sh`

Reuse an existing healthy instance if port 1420 is already occupied; do not start a second copy.

- [ ] **Step 4: Verify the sidecar release invariant.**

Confirm all of the following from actual process/log/runtime state:

1. `target/debug/TerminAI` is running.
2. A child `python -m ccie_sidecar` process is running from `sidecar/.venv`.
3. The sidecar warmup ping succeeds.
4. `sidecar_status.last_seen` receives fresh heartbeat timestamps.
5. The footer chip leaves `starting` and displays the sidecar version.

The power-editing slice does not touch the sidecar, but the project guardrail requires this invariant before completion.

- [ ] **Step 5: Manually verify the user-visible editor behavior.**

In an editor file containing at least five lines:

1. Open the context menu and invoke Add Cursors to Selected Lines.
2. Copy, move, delete, indent, outdent, sort, deduplicate, and case-transform selected lines; confirm Monaco performs the edit and the buffer becomes dirty.
3. Fold and unfold a supported structured file.
4. Enable Column Selection in Editor Settings and confirm the Monaco editor's rectangular selection behavior changes.
5. Toggle bookmarks on two lines, navigate next/previous with wraparound, and clear all.
6. Detach the pane and confirm the same actions are available in the detached window.
7. Close the file with bookmarks present and confirm no disposal error, crash, or stale marker remains.

- [ ] **Step 6: Inspect scope and generated artifacts before handoff.**

Run: `git status --short --branch`

Expected: only the intended power-editing commits/files are present; preserve unrelated generated `__pycache__` files and do not stage them.

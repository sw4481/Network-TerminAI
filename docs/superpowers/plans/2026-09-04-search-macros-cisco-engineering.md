# Search Power, Editor Macros, and Cisco Engineering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add workspace Find in Files, runtime-local Monaco edit macros, and a guarded editor-selection-to-connected-Cisco-terminal workflow without duplicating TerminAI capabilities.

**Architecture:** Keep current-file FindReplace, terminal search, workflows, and device tooling unchanged. Add one workspace-scoped Tauri search command, one small Monaco edit-macro controller attached to the existing content-change/disposal seam, and one frontend Cisco handoff that calls the existing terminal-connection, guardrail, approval, and ptyWrite APIs.

**Tech Stack:** React, TypeScript, Monaco Editor 0.52.2, Zustand, Tauri 2, Rust std::fs, the existing regex crate, Vitest, and Cargo tests.

**Spec:** docs/superpowers/specs/2026-09-04-search-macros-cisco-engineering-design.md

## Global Constraints

- Do not modify current-file FindReplace behavior.
- Do not modify src-tauri/src/search.rs; it is application FTS, not workspace search.
- Do not add an npm or Rust dependency; use existing regex and std::fs.
- Do not add persistence, database migrations, sidecar code, protocol code, or credential handling.
- Do not change Monaco power-editing actions/bookmarks; integrate beside their existing registration.
- Search is read-only and workspace-root scoped.
- Macro state is memory-only per Monaco webview and records edits, not navigation or command execution.
- Cisco sends use only existing connected Cisco targets, existing guardrails, existing approval UI, and existing ptyWrite.
- The selected Cisco payload is written verbatim; do not add a newline or rewrite prompts.
- Preserve unrelated dirty files, including existing untracked planning and cache artifacts.
- Before claiming completion, run focused tests, the full frontend suite, Cargo tests, bun run build, ./run.sh, and the sidecar health checks required by AGENTS.md.

## Verified baseline

Graphify and direct source inspection verified these seams:

- MonacoEditor.tsx owns Monaco creation, the model-content callback, the editorDisposables list, and existing power-editing/bookmark registration.
- Monaco is pinned to 0.52.2.
- FindReplace.tsx already supplies current-file literal/regex search, match-case, whole-word, match count, next/previous, replace-one, and replace-all.
- EditorTab.tsx owns the selected workspace root, focused editor reference, editor toolbar, file opening, and current Find & Replace overlay.
- EditorPane.tsx and EditorSplitTree.tsx route editor refs to EditorTab.tsx.
- DetachedEditorWindow.tsx uses the same Monaco editor path in a separate webview and synchronizes through EditorBufferSyncClient.
- editorStore.ts owns buffer identity, workspace layout, dirty state, and the focused pane.
- src-tauri/src/commands/editor.rs owns editor path validation, ignored-entry filtering, directory listing, and editor file operations.
- src/lib/tauri.ts exposes typed editor commands and ptyWrite.
- terminalConnectionStore.ts contains terminal id, backend PTY id, display name, vendor, platform, and lifecycle.
- terminalRegistry.ts owns terminal lifecycle and stable-id to PTY mapping; workflowDispatcher.ts already writes workflow commands through ptyWrite.
- guardrails.ts exposes classification and audit recording; guardrailsStore.ts and BlastRadiusHost.tsx provide the shared approval queue and tier UI.
- recordingStore.ts and the asciinema backend record terminal sessions, not editor macros.

## File map

Create:

- src/components/editor/editorMacro.ts
- src/components/editor/editorMacro.test.ts
- src/components/editor/WorkspaceFind.tsx
- src/components/editor/WorkspaceFind.css
- src/components/editor/WorkspaceFind.test.tsx
- src/components/editor/ciscoSelectionBridge.ts
- src/components/editor/ciscoSelectionBridge.test.ts
- src/components/editor/SendSelectionToCisco.tsx
- src/components/editor/SendSelectionToCisco.css
- src/components/editor/SendSelectionToCisco.test.tsx

Modify:

- src-tauri/src/commands/editor.rs: add one read-only editor_find_in_files command and focused Rust tests.
- src-tauri/src/lib.rs: register that command.
- src/lib/tauri.ts: add the result type and typed bridge.
- src/components/editor/MonacoEditor.tsx: attach the macro controller to the existing content-change and disposal lifecycle.
- src/components/editor/EditorTab.tsx: add workspace-search and Cisco handoff entry points using the existing focused editor.
- src/components/editor/EditorTab.css only if existing toolbar styles cannot support the two controls.

Do not modify FindReplace.tsx, src-tauri/src/search.rs, terminalSearch.ts,
terminalRegistry.ts, workflowDispatcher.ts, recordingStore.ts, NETCONF/PyATS
code, or sidecar code.

## Task 1: Add the read-only workspace search command

**Files:**

- Modify: src-tauri/src/commands/editor.rs
- Modify: src-tauri/src/lib.rs
- Modify: src/lib/tauri.ts
- Test: focused tests in src-tauri/src/commands/editor.rs

**Interfaces:**

- Tauri command name: editor_find_in_files.
- Request: workspace_root: String, query: String, regex: bool, match_case: bool, whole_word: bool, file_pattern: Option<String>, max_results: usize.
- Result: file_path: String, line: usize, column: usize, preview: String.
- TypeScript bridge: editorFindInFiles(request): Promise<EditorSearchMatch[]>;

- [ ] Step 1: Write failing Rust tests.

Add tests using TempDir:

    #[test]
    fn find_in_files_returns_sorted_literal_matches_with_one_based_positions() {
        // Create two UTF-8 files in reverse creation order, place matches on
        // different lines, call the command, and assert path/line/column/
        // preview order.
    }

    #[test]
    fn find_in_files_applies_regex_case_and_literal_word_filters() {
        // Create matching and non-matching names. Assert regex, case, and
        // literal whole-word options change the result set as specified.
    }

    #[test]
    fn find_in_files_rejects_workspace_escape_and_skips_ignored_entries() {
        // Assert a root escape is rejected and an ignored directory is absent.
    }

Expected before implementation: the tests fail because the command and result
type do not exist.

- [ ] Step 2: Implement the smallest command in editor.rs.

Reuse the existing canonical containment helper and ignored-entry helper.
Walk with std::fs::read_dir, recurse only below the validated root, read
UTF-8 files with fs::read_to_string, and skip non-UTF-8 files. Use the
already-declared regex crate only when regex mode is enabled. Reject an empty
query, an invalid expression, regex plus whole_word, and max_results equal to
zero before scanning. The frontend disables regex plus whole-word, but the
command still rejects it at the IPC boundary.

Document and implement only this filename-pattern rule: None or empty matches
all files; otherwise comma-separated items match the filename literally or
with one * wildcard. Do not add a general glob language. Return one-based
line/column positions and a source-line preview. Sort by path, line, and
column before applying max_results. This command never writes files.

- [ ] Step 3: Register the command and typed bridge.

Add commands::editor::editor_find_in_files to the existing invoke_handler list
in src-tauri/src/lib.rs. Add the exact result type and bridge in
src/lib/tauri.ts, converting camelCase request fields to the existing Tauri
snake_case boundary. Do not touch searchAll or the application FTS module.

- [ ] Step 4: Run the focused Rust tests.

    cargo test --manifest-path src-tauri/Cargo.toml editor:: --lib

Expected: the new search tests and existing editor tests pass.

## Task 2: Add the workspace Find in Files UI

**Files:**

- Create: src/components/editor/WorkspaceFind.tsx
- Create: src/components/editor/WorkspaceFind.css
- Create: src/components/editor/WorkspaceFind.test.tsx
- Modify: src/components/editor/EditorTab.tsx
- Modify: src/components/editor/EditorTab.css only if required

**Interfaces:**

- WorkspaceFind props: rootPath: string | null, onClose: () => void,
  onOpenResult: (filePath: string, position: { line: number; column: number }) => Promise<boolean> | boolean.
- It consumes editorFindInFiles and emits only the existing EditorTab file-open route.

- [ ] Step 1: Write failing UI tests.

Cover the following exact behavior:

    it("requires a workspace before searching", () => {
        // Render with no rootPath; assert the submit control is disabled and
        // the workspace-required message is visible.
    });

    it("submits options and renders clickable results", async () => {
        // Mock editorFindInFiles, enter query/options/pattern, submit, assert
        // the exact request, then click a result and assert its path and
        // one-based position reach onOpenResult.
    });

    it("clears stale results when the search fails", async () => {
        // Resolve one search, reject the next, assert the error is visible and
        // old results are no longer rendered.
    });

Expected before implementation: the tests fail because WorkspaceFind and its
EditorTab entry point do not exist.

- [ ] Step 2: Implement a controlled search panel.

Keep query and options local to the component. Submit explicitly rather than
scanning on every keystroke. Use the fixed max_results value 5000. Render
path, line, column, and preview in keyboard-activatable buttons. On selection
call onOpenResult with the result path and the returned one-based position.
There are no replacement controls. Disable the whole-word checkbox while
regex mode is selected and show that the combination is unavailable in this
slice.

- [ ] Step 3: Add a distinct EditorTab toolbar entry point.

Add a Workspace Search button beside the current Find & Replace button. It
toggles WorkspaceFind and does not change Cmd+Shift+F; that shortcut continues
to open FindReplace. Wire result selection to the existing openFileAtPane
function and current focused/attached pane routing. Do not add search state to
editorStore or layout persistence.

- [ ] Step 4: Run focused frontend tests.

    bunx vitest run src/components/editor/WorkspaceFind.test.tsx src/components/editor/FindReplace.test.tsx

Expected: workspace tests pass and current-file search remains green.

## Task 3: Implement the runtime-local editor macro controller

**Files:**

- Create: src/components/editor/editorMacro.ts
- Create: src/components/editor/editorMacro.test.ts
- Modify: src/components/editor/MonacoEditor.tsx
- Modify: src/components/editor/MonacoEditor.powerEditing.test.tsx

**Interfaces:**

- MacroPosition has lineNumber and column numeric fields.
- MacroEdit has a plain Monaco range, text, and optional forceMoveMarkers.
- EditorMacroController exposes start, stop, clear, recordChanges,
  replay, isRecording, hasMacro, and dispose.
- createEditorMacroController(editor) creates controller-local state and
  registers native Monaco context-menu actions for Start/Stop Macro Recording,
  Replay Last Macro, and Clear Macro.

- [ ] Step 1: Write failing controller tests.

Use a fake editor with executeEdits and addAction spies:

    it("records ordered model changes and replays them", () => {
        // Start, record two changes, stop, replay. Assert one executeEdits
        // call with the same ordered ranges/text and source editor-macro.
    });

    it("does not append replayed changes and clear removes the macro", () => {
        // Record one edit, replay, then assert no second copy was captured;
        // clear and assert hasMacro is false.
    });

    it("disposes every macro action exactly once", () => {
        // Assert each addAction registration is disposed once.
    });

Expected before implementation: the tests fail because the module does not
exist.

- [ ] Step 2: Implement plain edit capture and replay.

Copy only the public change fields needed for replay into plain MacroEdit
values; do not retain Monaco model or event objects. Preserve event order and
the change order supplied by Monaco. Guard replay with an internal replaying
flag and call editor.executeEdits("editor-macro", edits). Replay is a no-op
when no completed macro exists.

Starting a new recording clears its in-progress sequence. Keep the last
completed macro until stop succeeds. A replayed edit must never append to the
recording because the controller is not recording during replay and the
replaying flag is an additional guard.

- [ ] Step 3: Attach the controller to MonacoEditor’s existing lifecycle.

Create the controller beside the existing power-editing and bookmark
registrations, push its dispose handle into editorDisposables, and change the
existing model-content callback to accept the event:

    const changeDisposable = editor.onDidChangeModelContent((event) => {
        const lease = modelLeaseRef.current;
        if (!lease || registry.isApplyingContent(lease.bufferId)) return;
        macroController.recordChanges(event.changes);
        onChangeRef.current(editor.getValue());
    });

Keep the existing registry.isApplyingContent guard before recording. This is
the verified seam that excludes external buffer application without adding a
second model listener.

- [ ] Step 4: Add lifecycle assertions and run focused tests.

Extend MonacoEditor.powerEditing.test.tsx to assert controller creation,
action registration on the same editor, disposal through existing ownership
cleanup, and no recordChanges call for an external model update.

    bunx vitest run src/components/editor/editorMacro.test.ts src/components/editor/MonacoEditor.powerEditing.test.tsx

Expected: all macro tests pass. DetachedEditorWindow uses the same
MonacoEditor path, so no detached implementation is added.

## Task 4: Add the tested Cisco selection coordinator

**Files:**

- Create: src/components/editor/ciscoSelectionBridge.ts
- Create: src/components/editor/ciscoSelectionBridge.test.ts

**Interfaces:**

- CiscoSelectionTarget has terminalId, backendPtyId, displayName, vendor
  fixed to cisco, and platform.
- listConnectedCiscoTargets(state) returns only connected Cisco entries with
  a non-empty backend PTY id, sorted by displayName.
- sendSelectionToCisco(args) returns sent or cancelled and receives selection,
  target, sessionId, and injected classify, record, write, approve, and
  current-target dependencies for deterministic tests.

- [ ] Step 1: Write failing coordinator tests.

Cover:

    it("keeps only connected Cisco targets with real PTY ids", () => {
        // Supply Cisco connected, Cisco disconnected, Juniper connected, and
        // Cisco-connected-without-PTY entries. Assert only the allowed entry.
    });

    it("classifies every non-empty line before the first write", async () => {
        // Supply two lines and spies. Assert both classifications complete
        // before write and write receives the original bytes unchanged.
    });

    it("cancels with zero writes when approval is denied", async () => {
        // Return T0 for one line and T1 for another; resolve approval as
        // cancel; assert ptyWrite was never called.
    });

    it("rejects a target that becomes disconnected before writing", async () => {
        // Change the injected target lookup after approval; assert zero writes.
    });

Expected before implementation: the tests fail because the bridge module does
not exist.

- [ ] Step 2: Implement target filtering and the two-phase send.

Read only the existing terminalConnectionStore metadata fields. Split the
selection only for classification with line endings removed from each
classifier input; retain the original selection string for the eventual write.
Ignore empty lines for classification. An all-empty selection returns
cancelled without a write.

Classify all non-empty lines before enqueueing approval or calling ptyWrite.
For every non-T0 result, await the existing
useGuardrailsStore.getState().enqueueAndAwait with PendingDecision fields:
unique pendingId, tier, command, reasoning, vendor, platform, sessionId, and
ruleId. Stop on the first cancel. Do not write during classification or
approval.

After all approvals succeed, re-read the target and require the same backend
PTY id, connected lifecycle, and Cisco vendor. Record T0 auto-approved
decisions through the existing recordDecision API, then write
new TextEncoder().encode(selection) once. Any classification, target recheck,
approval, or audit failure returns cancelled and produces zero writes.

Keep this coordinator in the frontend. Do not touch workflowDispatcher,
terminalRegistry, guardrails.rs, or the PTY backend.

- [ ] Step 3: Run focused coordinator tests.

    bunx vitest run src/components/editor/ciscoSelectionBridge.test.ts

Expected: all zero-write safety tests pass.

## Task 5: Add the minimal editor entry point for the Cisco workflow

**Files:**

- Create: src/components/editor/SendSelectionToCisco.tsx
- Create: src/components/editor/SendSelectionToCisco.css
- Create: src/components/editor/SendSelectionToCisco.test.tsx
- Modify: src/components/editor/EditorTab.tsx
- Modify: src/components/editor/EditorTab.css only if required

**Interfaces:**

- SendSelectionToCisco props are editor:
  Monaco.editor.IStandaloneCodeEditor | null, sessionId: string, and
  onClose: () => void.
- It consumes the connection store and ciscoSelectionBridge; it does not
  create a terminal or a device session.

- [ ] Step 1: Write failing UI tests.

Cover:

    it("shows only connected Cisco targets and requires selection", () => {
        // Mock connected/disconnected Cisco and connected non-Cisco entries.
        // Assert only the allowed target is selectable and Send is disabled
        // without an editor selection.
    });

    it("passes the exact editor selection and target to the bridge", async () => {
        // Mock getSelection, getModel, getValueInRange, and the bridge. Click
        // Send and assert original selected text and target metadata.
    });

    it("does not claim success for no-target or canceled results", () => {
        // Assert an actionable status and no Sent message for either outcome.
    });

Expected before implementation: the tests fail because the component does not
exist.

- [ ] Step 2: Implement the target picker and exact-selection read.

Read the current selection from the focused editor only:

    const selection = editor?.getSelection();
    const model = editor?.getModel();
    const text = selection && model ? model.getValueInRange(selection) : "";

Do not use editor.getValue, clipboard state, or terminal selection. Render
actual displayName and platform values from terminalConnectionStore. Disable
Send when the editor is unavailable, selected text is empty, or no connected
Cisco target exists. Include the explicit verbatim-payload/trailing-newline
note.

- [ ] Step 3: Mount one distinct EditorTab toolbar button.

Add a Cisco send button next to, but separate from, current Find & Replace.
It opens the target picker, passes focusedEditor and tab.id, and leaves current
FindReplace and all existing shortcuts unchanged. Close the picker after
sent/canceled/error and show only the component’s local status.

This first Cisco surface is intentionally attached EditorTab UI. Detached
editors receive macro actions through MonacoEditor; a second detached target
picker is outside this minimal slice and is not inferred from shared buffer
state.

- [ ] Step 4: Run focused UI tests.

    bunx vitest run src/components/editor/SendSelectionToCisco.test.tsx

Expected: the UI tests pass and no terminal, workflow, topology, or NETCONF
component tests require modification.

## Task 6: Full verification and surgical review

**Files:**

- Modify only files listed in Tasks 1–5.
- Do not stage or delete unrelated files.

- [ ] Step 1: Run focused regression coverage.

    bunx vitest run src/components/editor/FindReplace.test.tsx src/components/editor/WorkspaceFind.test.tsx src/components/editor/editorMacro.test.ts src/components/editor/ciscoSelectionBridge.test.ts src/components/editor/SendSelectionToCisco.test.tsx
    cargo test --manifest-path src-tauri/Cargo.toml editor:: --lib

Expected: all focused tests pass.

- [ ] Step 2: Run the existing frontend suite and build.

    bunx vitest run
    bun run build

Expected: no regressions in editor, terminal, workflows, topology,
structured-output, recording, or detached-window tests.

- [ ] Step 3: Run repository validation through the project launcher.

    ./run.sh

Verify the AGENTS.md release invariant: target/debug/TerminAI is running, a
child python -m ccie_sidecar process is running from sidecar/.venv, the
sidecar warmup ping succeeds, sidecar_status.last_seen receives a fresh
heartbeat, and the footer chip leaves starting and shows the sidecar version.
Preserve sidecar/.venv and application data.

- [ ] Step 4: Perform the surgical diff review.

    git diff --check
    git diff --stat
    git status --short --branch

Confirm every changed line maps to one of the three requested missing
capabilities. Confirm src-tauri/src/search.rs, FindReplace.tsx,
terminalSearch.ts, terminalRegistry.ts, workflowDispatcher.ts,
recordingStore.ts, NETCONF/PyATS code, and sidecar code are unchanged.

- [ ] Step 5: Manual acceptance in the running application.

1. Workspace search from an opened workspace returns deterministic clickable
   file/line results while Cmd+Shift+F still opens current-file Find & Replace.
2. Macro actions record two edits, replay them, and clear them in the attached
   editor; repeat action discovery in a detached editor.
3. With connected Cisco and non-Cisco targets, select two command lines,
   choose Cisco, approve requested tiers, and confirm the PTY receives exactly
   the selected bytes. Include a trailing newline when execution is intended.
4. Disconnect or cancel approval before send and confirm zero PTY writes.

No source implementation should be started until this plan is approved.

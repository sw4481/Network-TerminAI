# Search Power, Editor Macros, and Cisco Selection Bridge Design

## Goal

Add the missing Notepad++-style editor workflows that complement TerminAI's
existing features:

1. workspace-scoped Find in Files;
2. runtime-local editor edit macros; and
3. a narrow Cisco-engineering workflow that sends selected editor text to an
   already-connected Cisco terminal through the existing safety path.

The implementation must reuse existing editor, terminal, guardrail, and
workspace seams. It must not re-create terminal search, command workflows,
device protocols, topology tooling, or terminal recording.

## Fact baseline

The following facts were verified in the current repository and Graphify
graph before this design was written:

- MonacoEditor.tsx owns the Monaco instance, model-content callback, editor
  registration/disposal list, and the existing power-editing/bookmark
  registrations.
- Monaco is pinned to 0.52.2.
- FindReplace.tsx already implements current-file literal/regex search,
  match-case, whole-word, match count, next/previous, replace-one, and
  replace-all.
- EditorTab.tsx already owns the workspace root, focused editor reference,
  editor toolbar, file opening, and the current Find & Replace overlay.
- EditorPane.tsx and EditorSplitTree.tsx route editor refs to EditorTab.tsx.
- DetachedEditorWindow.tsx reuses the editor pane/Monaco path in a separate
  webview and synchronizes shared buffer content with
  EditorBufferSyncClient.
- editorStore.ts owns buffer identity, workspace layout, dirty state, and
  the focused pane.
- src-tauri/src/commands/editor.rs already has recursive-path containment
  helpers for editor file operations, directory listing, ignored-entry
  filtering, and UTF-8 file reading/writing.
- src/lib/tauri.ts already exposes typed editor commands and ptyWrite.
- terminalConnectionStore.ts already records terminal id, backend PTY id,
  display name, vendor, platform, and lifecycle.
- terminalRegistry.ts maps stable terminal ids to backend PTY ids and already
  owns PTY lifecycle; workflowDispatcher.ts already writes workflow commands
  through ptyWrite.
- guardrails.ts exposes command classification and audit recording;
  guardrailsStore.ts and BlastRadiusHost.tsx already provide the shared
  approval queue and tier-specific approval UI.
- src-tauri/src/search.rs is an existing SQLite/FTS search implementation for
  application data, not editor workspace files.
- recordingStore.ts and the recording/asciinema backend record terminal
  sessions. They are not editor macro infrastructure.

Graphify connected these seams through FindReplace, MonacoEditor, editorStore,
EditorTab, DetachedEditorWindow, terminalRegistry, ptyWrite, guardrails, and
workflow nodes. Graphify is an architecture map, not runtime proof.

## Scope

### Workspace Find in Files

Add a read-only search command scoped to the editor's selected workspace root.
The first version supports literal search, regular expressions, match-case,
whole-word for literal search, a simple filename pattern, deterministic
file/result ordering, line/column/short-line previews, and clicking a result
to open the existing buffer at that location. Regex plus whole-word is
rejected in this slice because the existing Rust regex dependency does not
provide the zero-width look-around needed to add word boundaries without
changing the expression's match range; the UI disables that combination.

The existing FindReplace component remains the current-file search surface.
Workspace search does not perform multi-file replacement.

### Runtime-local editor macros

Record and replay Monaco model edits in the current editor webview:
start/stop recording, replay the last recorded edit sequence, and clear it.
Recording uses the existing public onDidChangeModelContent event and replay
uses Monaco executeEdits. External buffer synchronization is not recorded.

The macro does not claim to capture navigation, selection movement, command
execution, or arbitrary keystrokes because the current public Monaco seam does
not expose a standalone command-execution event. Controls are editor-instance
actions, so attached and detached Monaco editors get the same controls.
Macro state is memory-only per webview.

### Cisco engineering selection bridge

Add one editor action: send selected text to a currently connected Cisco
terminal. The first version lists only terminalConnectionStore entries whose
vendor is Cisco and lifecycle is connected, shows display name/platform,
uses the stored backend PTY id, classifies every non-empty selected line with
the existing guardrail classifier before any write, routes non-T0 lines
through the existing approval queue, records T0 auto-approval only after
every required approval succeeds, aborts on classification failure or
canceled approval, and writes the selected UTF-8 bytes verbatim through
ptyWrite.

Verbatim means no prompt stripping, whitespace trimming, command rewriting, or
implicit newline. The UI tells the operator that a trailing newline is needed
when the device should execute the final line. This is an editor-to-existing-
terminal handoff, not a new Cisco executor.

## Deliberate exclusions and overlap decisions

Do not modify or duplicate current-file FindReplace.tsx, terminal scrollback
search, application/database FTS in src-tauri/src/search.rs, Monaco
power-editing actions or bookmarks, editor buffer synchronization, pane layout
persistence, terminalRegistry lifecycle, workflowDispatcher workflow
execution, terminal Ask AI/topology/structured actions, NETCONF, PyATS, SSH
connection creation, parsers, syntax highlighting, or terminal asciinema
recording.

Do not add macro persistence, cross-restart recovery, cross-webview
synchronization, multi-file replacement, or macro navigation recording.

## Safety and failure policy

- Workspace search accepts the workspace root from EditorTab and rejects any
  candidate that escapes the existing canonical containment boundary.
- Search is read-only, skips existing ignored directories, and rejects an
  invalid regular expression before scanning.
- Cisco selection does not default to a device when no connected Cisco target
  exists.
- All selected lines are classified before ptyWrite is called.
- A classification error, missing target, stale/disconnected target, or
  canceled approval produces zero PTY writes.
- The target is rechecked immediately before writing; a changed lifecycle
  aborts the send.
- No new credential, session, database, or sidecar state is introduced.

## Acceptance criteria

- Workspace search stays inside the selected root and returns stable results
  for literal, regex, case, word, and filename-pattern options.
- Existing current-file FindReplace behavior remains unchanged.
- Macro tests prove ordered capture, replay, clear, external-sync exclusion,
  and disposal. Macro actions work in attached and detached editors without
  persistence claims.
- Cisco tests prove connected-Cisco filtering, exact byte preservation,
  all-lines-classified-before-write, approval cancellation with zero writes,
  and stale-target rejection.
- Existing frontend tests, Rust tests, frontend build, and the required
  TerminAI sidecar health checks remain release gates.

# Embed opencode in a VSCode-like editor pane

## Context

The user wants a VSCode-like experience inside CCIE Terminal: open a code editor, browse/edit files, and run **opencode** (the open-source AI coding agent CLI, `github.com/anomalyco/opencode`) in a terminal docked *within* that editor — like VSCode's integrated terminal.

**Key finding: almost everything already exists.** The app already ships a Monaco-based `EditorTab` (file tree + git + save) *and* a terminal registry that already runs long-lived TUIs (claude, codex) — surviving tab switches, resize, and alt-screen indicator suppression. opencode is a self-contained CLI (`opencode` on `$PATH`) with a TUI, so from the PTY's view it's just another alt-screen TUI like claude/codex. This is **composition, not new subsystems**.

Confirmed with the user:
- **Depth:** run the opencode **TUI in a pane** (MVP). No custom API/SSE UI. (`opencode serve` HTTP API exists — future phase, not now.)
- **Surface:** **extend the existing** `EditorTab`.

## Surgical constraints (per user)
Touch only what's required. Specifically:
- **No changes to `editorStore.ts`.** Panel open/closed is local `useState` in `EditorTab`, exactly like the existing `showFind`/`showSettings` (`EditorTab.tsx:34-35`). "opencode already launched" is a `useRef` inside the new panel component.
- **No Rust, no Tauri commands, no migrations, no new deps.**
- **No resize handle, no install-detection, no restart button** in the MVP (fixed-height panel; can add later).
- Reuse `TerminalSlot` and `terminalRegistry.runWhenReady` as-is.

## Approach

Add one collapsible fixed-height terminal panel at the bottom of `EditorTab`. It hosts a single `TerminalSlot` (existing registry-backed xterm+PTY). On first PTY-ready it auto-runs `opencode` via the registry's existing `runWhenReady`, rooted at the editor's folder.

### 1. New component — `src/components/editor/EditorTerminalPanel.tsx`
- Props: `tabId: string`, `cwd: string | null`, `onClose: () => void`.
- Stable terminalId: `` `editor-term-${tabId}` `` (distinct from terminal-tab ids → registry keeps one persistent PTY per editor tab).
- `const launched = useRef(false)`.
- Renders `<TerminalSlot terminalId={id} shell="/bin/zsh" cwd={cwd ?? ""} skipTabRegistration onRegistered={handleReady} />`.
  - `skipTabRegistration` (existing `TerminalSlot` prop) keeps this PTY out of the TabBar/tabs store.
  - Shell string: mirror `App.tsx:81` `defaultShell()` (returns `/bin/zsh`); pass empty `shell_cmd`-style default — the registry/backend appends `-il`.
- `handleReady`: `if (!launched.current) { launched.current = true; terminalRegistry.runWhenReady(id, "opencode"); }` (`runWhenReady` parks the cmd until the PTY is live — `terminalRegistry.ts:58`).
- Minimal header: a label "opencode" + a ✕ button → `onClose`.
- On unmount, call `terminalRegistry.dispose(id)` **only if** verification shows a `skipTabRegistration` PTY isn't otherwise cleaned up (confirm during impl; don't add speculatively).

### 2. Wire into `src/components/editor/EditorTab.tsx` (minimal edits)
- One local state: `const [showTerminal, setShowTerminal] = useState(false);` (beside line 34-35).
- One keybinding branch in the existing keydown handler (lines 124-150): `Cmd/Ctrl+Shift+O` → `setShowTerminal(v => !v)`. (Reconfirm `Cmd+Shift+O` is free vs `src-tauri/src/lib.rs` accelerators; editor already uses ⇧F/⇧E/`,`.)
- One toolbar button beside the others (~line 208) → `setShowTerminal(v => !v)`, `title="opencode terminal (Cmd+Shift+O)"`.
- Render, after `.editor-main` closes (line 257) and before the error banner: `{showTerminal && <EditorTerminalPanel tabId={tab.id} cwd={state.root_path} onClose={() => setShowTerminal(false)} />}`. (`state.root_path` already falls back to `$HOME` via lines 54-62.)

### 3. `src/components/editor/EditorTab.css`
- `.editor-tab` is already `flex-direction: column` with `.editor-main { flex: 1 }`, so a fixed-height panel slots naturally between `.editor-main` and the status bar.
- Add `.editor-terminal-panel` (fixed height ~280px, `flex` column, `border-top: 1px solid #3e3e42`, bg `#1e1e1e`), a small `.editor-terminal-header`, and a `flex: 1` slot area so the `.terminal-slot` fills it.

## Files
- **Add** `src/components/editor/EditorTerminalPanel.tsx`
- **Edit** `src/components/editor/EditorTab.tsx` (1 state var, 1 keybinding branch, 1 button, 1 render line)
- **Edit** `src/components/editor/EditorTab.css` (panel classes)
- Reuse unchanged: `TerminalSlot.tsx`, `terminalRegistry.ts`.

## Out of scope (future)
- `opencode serve` headless HTTP API + native React chat UI.
- "Open Folder" picker feeding `root_path` (pre-existing gap; opencode is more useful pointed at a real project than `$HOME`) — good fast-follow, not required.
- `CCIE_PANE_ID`/hook wiring for opencode status reporting.

## Verification (end-to-end, live app)
1. `npm run tauri dev` (registry/PTY only work in the running app).
2. Open/create an editor tab → file tree + Monaco still work (no regression).
3. `Cmd+Shift+O` and the toolbar button → bottom panel opens, shell spawns in the editor's folder, `opencode` auto-launches once (not twice).
4. opencode TUI is interactive (arrows, `Tab`, typing) and the "running" indicator does **not** stick (alt-screen path, `command_parser.rs`).
5. Switch top-level tabs and back → opencode session persists (registry keeps PTY/xterm alive).
6. Confirm **no stray terminal tab** in the TabBar (`skipTabRegistration`).
7. Close editor tab → verify PTY cleanup (decides whether the `dispose` call in step 1 is needed).
8. Add a focused vitest for the panel's launch-once ref logic if practical (`--exclude '**/.worktrees/**'`); otherwise rely on the live pass above.

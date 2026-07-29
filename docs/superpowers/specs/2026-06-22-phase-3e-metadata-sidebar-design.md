# Phase 3E: Metadata Sidebar — Design

> **Status:** Design approved 2026-06-22. Next step: implementation plan via `writing-plans`.
> **Part of:** Phase 3 Browser Windows & Pane Context (sub-phase 3E of the design at `docs/superpowers/specs/2026-06-19-phase-3-browser-windows-design.md`).

## Goal

A floating, draggable HUD card showing live context for the currently-focused
terminal pane: **git branch/status**, **listening ports**, and **SSH/device
context**. Metadata is gathered lazily — only when the card is open and a
trigger fires — so it costs nothing when idle or closed.

> **Naming note:** the parent spec calls this sub-phase "Metadata Sidebar." This
> design realizes it as a **floating HUD card** (draggable, toggleable, no
> backdrop) rather than a docked sidebar, per operator preference. "Sidebar" and
> "card" refer to the same feature throughout.

## Spike-Grounded Facts (verified 2026-06-22)

These facts were confirmed by reading the code, not assumed:

- **Pane focus** lives in `src/state/panesStore.ts` as `focusedPaneId`.
- Each pane node carries a **`terminalId`** — the key into the backend `ptys`
  HashMap. Root pane's `terminalId == tabId`; split panes get their own
  spawned id. (`panesStore.ts:14`, `resolveRecordingTerminalId` at `:66`.)
- **Per-pane cwd** is tracked via OSC 7 in `paneActivityStore` (`getActivity(paneId).cwd`).
- **`ptys` HashMap is keyed by `terminal_id`**, NOT `pane_id`
  (`src-tauri/src/commands/mod.rs:526`).
- **`PtyHandle` does NOT currently capture the process pid.** `portable_pty`'s
  `child.process_id()` is available at spawn (`src-tauri/src/pty.rs:249`) but is
  discarded. Capturing it is a prerequisite for the ports + ssh-fallback
  gatherers.
- **No existing way to know a pane's SSH target.** Must be derived (see SSH gatherer).
- `git2` is already a dependency (`src-tauri/src/commands/git.rs`).
- **⌘⇧L is free.** Taken `⌘⇧`: B,C,D,E,F,G,I,J,K,M,N,P,R,S,T,V,W.

## Architecture

```
Focused pane (panesStore.focusedPaneId)
   │  resolve pane → terminalId (PTY key) + cwd (paneActivityStore) + tabId
   ▼
get_pane_metadata(terminal_id, cwd, tab_id)   ← single aggregate Tauri command
   │  runs 3 gatherers concurrently (tokio::join!), each independently fallible
   ├─ git:   git2 on cwd → { branch, dirty, ahead, behind, changed_count }
   ├─ ports: pid (from PtyHandle) → child subtree → lsof → [{ port, proc_name }]
   └─ ssh:   chain binding (tab→chain→last hop) ELSE foreground-proc parse
   ▼
PaneMetadata { git: Option, ports: Vec, ssh: Option, gathered_at }
   ▼
MetadataCard.tsx (floating, draggable HUD) ← metadataStore (open, position, data, loading)
```

**Why one aggregate command (not three):** the card displays all three sections
as a single snapshot taken at one moment. One round-trip, one loading state, and
partial-failure tolerance (a git failure never blanks ports/ssh) fit the UI
better than three independently-orchestrated calls. Matches the spec's named
`get_pane_metadata(pane_id)` interface.

**Why a new `metadata/` module (not extending `commands/git.rs`):** `git.rs` is
file-diff-oriented (status/diff per file). These gatherers are
pane-context-oriented and share a process-tree helper. A focused module with one
purpose beats scattering pane logic across existing files.

## Enabling Backend Changes (do not exist yet)

1. **Capture the shell pid** into `PtyHandle` at spawn (`pty.rs:249`,
   `child.process_id()` → new `pid: Option<u32>` field + accessor). Currently discarded.
2. The command resolves the PTY by **`terminal_id`** (the existing `ptys` key the
   frontend already tracks per pane) to reach that pid.

## Data Model & Command Contract

```rust
#[tauri::command]
pub async fn get_pane_metadata(
    state: State<'_, AppState>,
    terminal_id: String,        // PTY HashMap key (pane's terminalId)
    cwd: String,                // live cwd from paneActivityStore
    tab_id: String,             // for SSH chain-binding lookup
) -> Result<PaneMetadata, String>
```

```rust
pub struct PaneMetadata {
    pub git: Option<GitInfo>,        // None = not a git repo (or git failed)
    pub ports: Vec<PortInfo>,        // empty = none found (or lookup failed)
    pub ssh: Option<SshInfo>,        // None = not an SSH session
    pub gathered_at: i64,            // unix secs, for "as of HH:MM:SS" label
}

pub struct GitInfo {
    pub branch: String,              // "main" or "(detached @ 5ee4e69)"
    pub dirty: bool,                 // uncommitted changes present
    pub changed_count: u32,          // # changed/untracked files (excl. ignored)
    pub ahead: u32,                  // commits ahead of upstream (0 if no upstream)
    pub behind: u32,                 // commits behind upstream (0 if no upstream)
}

pub struct PortInfo {
    pub port: u16,                   // listening port, e.g. 8000
    pub proc_name: String,           // e.g. "python3", "node"
}

pub struct SshInfo {
    pub host: String,                // "192.168.1.1" or "core-sw-01"
    pub user: Option<String>,        // "admin"
    pub port: Option<u16>,           // 22
    pub source: SshSource,           // Chain | Process — provenance badge
}

pub enum SshSource { Chain, Process }  // serde rename_all = "lowercase"
```

**Error philosophy:** the command returns `Err` ONLY for a malformed request
(e.g. unknown `terminal_id`). git/ports/ssh each catch their own errors and
degrade to `None`/empty, logging a warning. No gatherer can fail another, so the
card always shows something and the user can see which sections are available.

**SSH provenance:** `source` drives a small badge (`via chain` = authoritative,
`via process` = best-effort argv parse) so the user knows how trustworthy the
host is.

**Frontend wrapper** (`src/lib/metadata.ts`, mirrors existing pattern):
```typescript
export const getPaneMetadata = (terminalId: string, cwd: string, tabId: string) =>
  invoke<PaneMetadata>('get_pane_metadata', { terminalId, cwd, tabId });
```

## Backend Gatherers (`src-tauri/src/metadata/`)

The command runs all three concurrently via `tokio::join!` and assembles the result.

### Gatherer 1 — Git (`metadata/git.rs`)
- `git2::Repository::discover(cwd)` → `Err` ⇒ return `None` (not-a-repo is the
  common case, not a failure).
- Branch from `repo.head()`; detached HEAD ⇒ `(detached @ <short-sha>)`.
- `dirty` + `changed_count` from `repo.statuses()` (exclude ignored).
- `ahead`/`behind` via `repo.graph_ahead_behind(local, upstream)`; default `0/0`
  when there is no upstream.

### Gatherer 2 — Listening ports (`metadata/ports.rs`)
- Resolve `terminal_id` → `PtyHandle` → stored shell pid (new field).
- Collect the pid's descendants (shared proc helper), then run
  `lsof -nP -p <csv-pids> -iTCP -sTCP:LISTEN -FpPcn` (machine-parseable `-F`
  field output — no column scraping).
- Parse into `[{ port, proc_name }]`, deduped by port.
- macOS-first (matches spec posture). Any failure ⇒ empty vec.
- Only invoked on an explicit gather (card open + trigger) — never on a timer.

### Gatherer 3 — SSH context (`metadata/ssh.rs`) — chain-first, process-fallback
1. **Chain binding (authoritative):** `tab_id` → bound session chain → last
   hop's `target_ref` → resolve via existing SSH-connection lookup →
   `{host, user, port}`, `source = Chain`.
2. **Process fallback (best-effort):** no chain ⇒ walk the pid's descendants for
   an `ssh`/`telnet` process; parse its argv for `user@host`, `-p`/`-l`, bare
   host ⇒ `source = Process`.
3. Neither ⇒ `None`.

### Shared helper — process tree (`metadata/proc.rs`)
- `child_pids(root_pid) -> Vec<u32>` via `pgrep -P`, walked breadth-first
  (macOS/Unix). Cycle-guarded. Used by both ports and ssh-fallback. Unit-tested
  with a mockable process source.

## Frontend

### Store — `src/state/metadataStore.ts` (Zustand)
```typescript
interface MetadataStore {
  open: boolean;
  data: PaneMetadata | null;
  loading: boolean;
  error: string | null;
  position: { x: number; y: number };   // session-only; resets to default corner
  toggle: () => void;
  setPosition: (x: number, y: number) => void;
  refresh: () => Promise<void>;          // resolves focused pane → calls command
}
```
- **No persistence.** `position` and `open` are in-memory only; the card returns
  to its default corner (top-right, inset from edges) each launch.

### Component — `src/components/MetadataCard.tsx` (+ `.css`)
- Renders `null` when `!open` (established pattern).
- Floating fixed-position card (~280px wide), dragged by its header via
  `pointermove` while a drag flag is set; updates `position`. **No backdrop** —
  it's a HUD, the terminal stays interactive.
- **Three sections**, each with a graceful empty/absent state:
  - **Git:** `⎇ main` + dirty dot + `3 changed` + `↑1 ↓0`; "Not a git repo" when `git === null`.
  - **Ports:** list of `:8000 python3`; "No listening ports" when empty.
  - **SSH:** `admin@192.168.1.1:22` + provenance badge; "Not an SSH session" when `null`.
- **Header:** title, manual refresh button (↻, spins while `loading`), an
  "as of HH:MM:SS" timestamp from `gathered_at`, close (×).

### Refresh triggers (lazy, no timer)
1. On `toggle()` → open: `refresh()`.
2. While open, when `panesStore.focusedPaneId` changes: `refresh()` (a
   `useEffect` on `focusedPaneId`, guarded by `open`).
3. Manual refresh button.
- `refresh()` reads `focusedPaneId` → resolves the pane's `terminalId`
  (panesStore helper) + `cwd` (paneActivityStore) + `tabId`, then calls
  `getPaneMetadata`. No focused pane ⇒ neutral "No focused pane" state.

### Toggle wiring (mirrors existing surfaces)
- JS shortcut: `useKeyboardShortcut('l', () => toggle(), { cmd: true, shift: true })` → **⌘⇧L**.
- Tauri menu item: "Toggle Metadata Card", accelerator `CmdOrCtrl+Shift+L`.
- Mounted unconditionally in `App.tsx` like `StateDrawer`/`DriftSidebar`.

## Testing & Verification

### Rust unit tests (`metadata/` module)
- **git:** temp repo → assert branch; dirty file → `dirty && changed_count == 1`;
  non-repo dir → `None`.
- **proc:** `child_pids` against an injected fake parent→child map → BFS walk +
  no infinite loop on cycles.
- **ssh:** argv parser core — `["ssh","admin@192.168.1.1","-p","2222"]`,
  `["ssh","host"]`, `["ssh","-l","user","h"]`, non-ssh argv → correct
  `SshInfo`/`None`.
- **ports:** parse a captured `lsof -F` fixture → `[{port, proc_name}]`, deduped.

### Frontend tests (vitest)
- **metadataStore:** `toggle` flips `open` + triggers refresh; `refresh` with no
  focused pane → neutral state; partial data (git present, ssh null) stores cleanly.
- **MetadataCard:** renders all three sections from mock data; renders each
  empty/absent state; refresh button calls `refresh`; not rendered when `!open`.

### Live end-to-end (run for real, report actual output)
1. `cd` into this repo in a pane → ⌘⇧L → git shows `main` + correct clean/dirty.
2. `python3 -m http.server 8000` in a pane → refresh → ports shows `:8000 python3`.
3. Pane SSH'd via a chain → ssh shows host + `via chain`; ad-hoc `ssh user@host`
   → host + `via process`.
4. Drag the card → moves and stays; toggle off/on → returns to default corner.
5. Switch focused pane while open → card updates to new pane's context.

### Baselines
`cargo build` clean; `npm test` green; `npx tsc --noEmit` not above existing baseline.

## Out of Scope (YAGNI)
- Windows/Linux port+proc support (macOS-first)
- Position / open-state persistence
- Metadata caching
- Process list (beyond what ports/ssh need internally)
- Auto-refresh timer / event-push model

## Key Design Decisions
- **One aggregate command** with partial-failure tolerance over three separate calls.
- **Chain-first, process-fallback** SSH detection, with provenance badge.
- **Lazy gather** (open + focus-change + manual), no timer — honors the spec's
  "lazy metadata" principle.
- **Floating HUD card**, draggable, toggle on/off, no persistence — per operator preference.
- **No new SQLite migration** — all state is ephemeral/in-memory. Next free
  migration remains V0055.

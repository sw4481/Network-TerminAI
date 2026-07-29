# Warp-style Claude Code Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add four Warp "Universal Agent Support" features to CCIE Terminal — OS notification when Claude needs input, a per-pane Claude statusLine, an auto-detecting agent toolbelt, and a rich-input composer — by reusing the existing lifecycle-hook / pane-activity pipeline.

**Architecture:** Phases 1 & 4 are pure frontend (TypeScript/React). Phase 2 extends the existing Rust `claude_hooks` writer. Phase 3 adds one new `PtyHandle` method (foreground-process name via `MasterPty::process_group_leader`), one background poll task, one Tauri event + command, and a React toolbelt. Components communicate through existing stores (`paneActivityStore`), existing Tauri events (`pane_activity_updated`), one new Tauri event (`pane_foreground_agent`), and one new browser `CustomEvent` (`ccie:open-rich-input`).

**Tech Stack:** Rust (Tauri 2, `portable-pty` 0.9, `libc` 0.2, `serde_json`, `tracing`), TypeScript, React, Zustand, Vitest, `cargo nextest`.

## Global Constraints

- **Surgical Changes** — every changed line must trace directly to this plan. Do not refactor, reformat, or "improve" adjacent code. Match the surrounding style exactly.
- **Simplicity First** — minimum code that satisfies the success criteria. No speculative flags, abstractions, or config.
- **OOP** — new logic units are classes with a single responsibility (per project `CLAUDE.md`).
- **Platform** — macOS only (matches the app's environment). Phase 3 process resolution uses macOS `libc::proc_pidpath`.
- **No new DB migration** — no phase touches the schema.
- **Frontend tests** run with: `npx vitest run --exclude '**/.worktrees/**' <path>` (the `.worktrees` exclude is mandatory — see project memory).
- **Rust tests** run with: `cargo nextest run -p ccie-terminal-lib <filter>` from `src-tauri/`.
- **Agent CLI names** — the canonical set is `["claude", "codex"]`, matched by final path segment (mirror `pane_context::manager::is_agent_command`). Do not invent other names.
- **Event contract for rich input** (used by Phases 3 & 4): a `window` `CustomEvent` named `ccie:open-rich-input` with `detail: { paneId: string | null }`. `paneId` is the backend PTY tab id to write to, or `null` to mean "use the focused pane". This is the ONLY coupling between the toolbelt and the composer.
- **Notification title/body copy** (Phase 1), verbatim: title `"Claude needs your input"`, body `` `${agentLabel} is waiting in ${tabTitle}` `` where `agentLabel` is `"Claude"` for `agentType` starting `claude`, else `"Codex"`.

---

## File Structure

**Phase 1 (notifications):**
- Create: `src/lib/agentNotifications.ts` — `AgentNotifier` class: edge-detects `needs_attention`, fires `Notification`.
- Create: `src/lib/agentNotifications.test.ts` — unit tests for edge detection.
- Modify: `src/App.tsx` — mount the notifier in one `useEffect`.

**Phase 2 (statusLine):**
- Modify: `src-tauri/src/claude_hooks.rs` — add `statusline_script()`, write the script in `install()`, add `statusLine` key in the settings builder, add tests.

**Phase 3 (toolbelt + detection):**
- Modify: `src-tauri/src/pty.rs` — add `PtyHandle::foreground_process_name()`.
- Create: `src-tauri/src/pane_context/foreground.rs` — `foreground_agent_for(name: &str) -> Option<String>` classifier (pure, testable).
- Modify: `src-tauri/src/pane_context/mod.rs` — declare the new module.
- Modify: `src-tauri/src/commands/pane_activity.rs` — add `get_pane_foreground_agent` command.
- Modify: `src-tauri/src/lib.rs` — register the command; spawn the poll task at boot.
- Create: `src/lib/foregroundAgent.ts` — types + `listenForegroundAgent` + `getPaneForegroundAgent` invoke wrapper.
- Create: `src/state/foregroundAgentStore.ts` — Zustand map `paneId → agent`.
- Create: `src/components/AgentToolbelt.tsx` — the overlay (status chip + Compose + Focus).
- Create: `src/components/AgentToolbelt.css` — styles.
- Modify: `src/App.tsx` — subscribe the store; mount `<AgentToolbelt />`.

**Phase 4 (rich input):**
- Create: `src/components/RichInputModal.tsx` — modal textarea → `ptyWrite`.
- Create: `src/components/RichInputModal.css` — styles.
- Create: `src/components/RichInputModal.test.tsx` — send/cancel behavior.
- Modify: `src-tauri/src/lib.rs` — menu item `rich_input` + emit arm.
- Modify: `src/App.tsx` — mount `<RichInputModal />`; `listen('menu:rich_input')`.
- Modify: `src/components/CommandPalette.tsx` — add a `STATIC_ACTIONS` entry + dispatch arm.

---

## Phase 1 — Notify when Claude needs input

### Task 1: `AgentNotifier` class + edge-detection tests

**Files:**
- Create: `src/lib/agentNotifications.ts`
- Test: `src/lib/agentNotifications.test.ts`

**Interfaces:**
- Consumes: `PaneActivity`, `NotificationState` from `src/lib/paneActivity.ts` (existing:
  `NotificationState = 'idle' | 'running' | 'needs_attention'`;
  `PaneActivity { paneId, tabId, activeCommand, cwd, lastFocusTime, notificationState, updatedAt }`).
- Produces: `class AgentNotifier` with:
  - `constructor(deps: AgentNotifierDeps)`
  - `handle(activity: PaneActivity): void` — pure-ish; calls `deps.notify(...)` only on the edge into `needs_attention`.
  - `start(): Promise<() => void>` — subscribes to `listenPaneActivityUpdated`, returns an unlisten.
  - `type AgentNotifierDeps = { notify: (paneId: string, title: string, body: string) => void; resolveTabTitle: (tabId: string) => string; agentLabel: (paneId: string) => string }`

- [ ] **Step 1: Write the failing test**

Create `src/lib/agentNotifications.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { AgentNotifier } from './agentNotifications';
import type { PaneActivity, NotificationState } from './paneActivity';

function activity(paneId: string, state: NotificationState): PaneActivity {
  return {
    paneId,
    tabId: 'tab-' + paneId,
    activeCommand: null,
    cwd: '/tmp',
    lastFocusTime: null,
    notificationState: state,
    updatedAt: 0,
  };
}

function makeNotifier() {
  const notify = vi.fn();
  const n = new AgentNotifier({
    notify,
    resolveTabTitle: () => 'Tab 1',
    agentLabel: () => 'Claude',
  });
  return { n, notify };
}

describe('AgentNotifier', () => {
  it('fires on the edge into needs_attention', () => {
    const { n, notify } = makeNotifier();
    n.handle(activity('p1', 'running'));
    n.handle(activity('p1', 'needs_attention'));
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(
      'p1',
      'Claude needs your input',
      'Claude is waiting in Tab 1',
    );
  });

  it('does not re-fire while staying in needs_attention', () => {
    const { n, notify } = makeNotifier();
    n.handle(activity('p1', 'needs_attention'));
    n.handle(activity('p1', 'needs_attention'));
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('fires again after leaving and re-entering needs_attention', () => {
    const { n, notify } = makeNotifier();
    n.handle(activity('p1', 'needs_attention'));
    n.handle(activity('p1', 'running'));
    n.handle(activity('p1', 'needs_attention'));
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it('tracks panes independently', () => {
    const { n, notify } = makeNotifier();
    n.handle(activity('p1', 'needs_attention'));
    n.handle(activity('p2', 'needs_attention'));
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it('first-ever observation of needs_attention fires (no prior state)', () => {
    const { n, notify } = makeNotifier();
    n.handle(activity('p9', 'needs_attention'));
    expect(notify).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --exclude '**/.worktrees/**' src/lib/agentNotifications.test.ts`
Expected: FAIL — `Failed to resolve import "./agentNotifications"` / `AgentNotifier is not defined`.

- [ ] **Step 3: Write minimal implementation**

Create `src/lib/agentNotifications.ts`:

```ts
import type { PaneActivity } from './paneActivity';
import { listenPaneActivityUpdated } from './paneActivity';

export type AgentNotifierDeps = {
  /** Fire an OS notification for a pane. */
  notify: (paneId: string, title: string, body: string) => void;
  /** Human title of the tab a pane belongs to. */
  resolveTabTitle: (tabId: string) => string;
  /** "Claude" or "Codex" for a pane's agent. */
  agentLabel: (paneId: string) => string;
};

/**
 * Edge-detects the transition INTO `needs_attention` per pane and fires exactly
 * one OS notification on that edge. Mirrors heartbeatStore's Notification usage.
 * Holds last-seen state per pane so a pane sitting in `needs_attention` (repeated
 * updates) never re-notifies.
 */
export class AgentNotifier {
  private lastState = new Map<string, PaneActivity['notificationState']>();

  constructor(private readonly deps: AgentNotifierDeps) {}

  handle(activity: PaneActivity): void {
    const prev = this.lastState.get(activity.paneId);
    const next = activity.notificationState;
    this.lastState.set(activity.paneId, next);
    if (next === 'needs_attention' && prev !== 'needs_attention') {
      const label = this.deps.agentLabel(activity.paneId);
      const title = 'Claude needs your input';
      const body = `${label} is waiting in ${this.deps.resolveTabTitle(activity.tabId)}`;
      this.deps.notify(activity.paneId, title, body);
    }
  }

  async start(): Promise<() => void> {
    return listenPaneActivityUpdated((a) => this.handle(a));
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run --exclude '**/.worktrees/**' src/lib/agentNotifications.test.ts`
Expected: PASS — 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/agentNotifications.ts src/lib/agentNotifications.test.ts
git commit -m "feat(agents): AgentNotifier edge-detects needs_attention"
```

### Task 2: Mount the notifier in App.tsx

**Files:**
- Modify: `src/App.tsx` (add one `useEffect` next to the existing pane-activity subscription at `:689-704`; notification permission is already requested at `:710-712`).

**Interfaces:**
- Consumes: `AgentNotifier` (Task 1); `usePaneActivityStore` (existing); `useTabs` store (existing, used at `App.tsx:727` — `useTabs.getState().tabs`); `usePaneActivityStore.getState().getAgentSession(paneId)` (existing `AgentSession { agentType }`).
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Add the import**

At the top of `src/App.tsx`, alongside the other `./lib` imports, add:

```ts
import { AgentNotifier } from "./lib/agentNotifications";
```

- [ ] **Step 2: Add the mount effect**

Immediately AFTER the existing pane-activity subscription effect (the block ending at `src/App.tsx:704`, `}, []);`), insert:

```tsx
  // Warp-style: fire an OS notification when an in-pane agent (claude/codex)
  // transitions into needs_attention. Reuses the Web Notification API exactly
  // like heartbeatStore. Permission is requested by the heartbeat effect below.
  useEffect(() => {
    const notifier = new AgentNotifier({
      notify: (paneId, title, body) => {
        if (!('Notification' in window) || Notification.permission !== 'granted') return;
        const n = new Notification(title, { body, tag: `pane-${paneId}` });
        n.onclick = () => {
          const activity = usePaneActivityStore.getState().getActivity(paneId);
          if (activity) useTabs.getState().setActive(activity.tabId);
          window.focus();
        };
      },
      resolveTabTitle: (tabId) =>
        useTabs.getState().tabs.find((t) => t.id === tabId)?.title ?? 'a terminal',
      agentLabel: (paneId) => {
        const session = usePaneActivityStore.getState().getAgentSession(paneId);
        return session?.agentType?.startsWith('claude') ? 'Claude' : 'Codex';
      },
    });

    let cleanup: (() => void) | undefined;
    notifier.start().then((fn) => {
      cleanup = fn;
    });
    return () => {
      if (cleanup) cleanup();
    };
  }, []);
```

> NOTE: confirm the tab title field name. If `Tab` uses `name` instead of `title`, use `t.name`. Check the `useTabs` store type before editing; use whichever field the store actually exposes (grep `useTabs` / the tab type in `src/state/`).

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no new errors referencing `App.tsx` or `agentNotifications`.

- [ ] **Step 4: Manual verification (drive the real flow)**

Per project rule "verify before claiming done":
1. Start the dev app.
2. Grant notification permission when prompted.
3. In a terminal pane, run `claude`, submit a prompt, and let it reach a permission/idle prompt (Notification hook → `waiting`). Confirm exactly one OS notification titled "Claude needs your input" appears.
4. Click it — the owning tab activates.
5. Leave it waiting; confirm no repeat notifications.

- [ ] **Step 5: Commit**

```bash
git add src/App.tsx
git commit -m "feat(agents): notify on agent needs_attention (Phase 1)"
```

---

## Phase 2 — Per-pane statusLine in app-managed Claude config

### Task 3: Write statusline.sh + add `statusLine` to settings

**Files:**
- Modify: `src-tauri/src/claude_hooks.rs` (builder at `:41-64`, `install()` at `:70-79`, tests at `:81-113`).

**Interfaces:**
- Consumes: `config_dir()` (existing), `build_hooks_settings(port, token)` (existing).
- Produces: `statusline_script() -> &'static str` (pure, testable); `install()` unchanged signature but now also writes `statusline.sh`; the settings JSON now contains a top-level `statusLine` object.

- [ ] **Step 1: Write the failing tests**

In `src-tauri/src/claude_hooks.rs`, inside `mod tests`, add:

```rust
    #[test]
    fn settings_include_statusline_command() {
        let v = build_hooks_settings(54321, "tok");
        let sl = v.get("statusLine").expect("statusLine present");
        assert_eq!(sl["type"].as_str().unwrap(), "command");
        let cmd = sl["command"].as_str().unwrap();
        assert!(cmd.ends_with("statusline.sh"), "points at the script: {cmd}");
        assert!(cmd.contains("claude-config"), "lives in the app config dir: {cmd}");
    }

    #[test]
    fn statusline_script_reads_model_and_pane() {
        let s = statusline_script();
        assert!(s.starts_with("#!/bin/bash"), "is a bash script");
        assert!(s.contains(".model.display_name"), "extracts the model name");
        assert!(s.contains("CCIE_PANE_ID"), "surfaces the pane id");
    }
```

- [ ] **Step 2: Run tests to verify they fail**

Run (from `src-tauri/`): `cargo nextest run -p ccie-terminal-lib claude_hooks`
Expected: FAIL — `statusLine` missing; `statusline_script` not found.

- [ ] **Step 3: Add the script constant**

In `src-tauri/src/claude_hooks.rs`, ABOVE `build_hooks_settings` (after `config_dir`), add:

```rust
/// The `statusLine` script installed into the app-managed Claude config dir.
/// Claude Code pipes a JSON status object on stdin; we print
/// `[model] 📁 dir | Branch: x` (adapted from Warp's example) and append the
/// pane id so multi-pane sessions are distinguishable. `jq` ships on macOS via
/// Xcode CLT / Homebrew; if absent the model falls back to "Claude".
pub fn statusline_script() -> &'static str {
    r#"#!/bin/bash
input=$(cat)
if command -v jq >/dev/null 2>&1; then
  MODEL=$(echo "$input" | jq -r '.model.display_name // "Claude"')
  CURRENT_DIR=$(echo "$input" | jq -r '.workspace.current_dir // "~"')
else
  MODEL="Claude"
  CURRENT_DIR="$PWD"
fi
DIR_NAME="${CURRENT_DIR##*/}"
GIT_BRANCH=""
if git rev-parse --git-dir >/dev/null 2>&1; then
  BRANCH=$(git branch --show-current 2>/dev/null)
  [ -n "$BRANCH" ] && GIT_BRANCH=" | Branch: $BRANCH"
fi
PANE=""
[ -n "$CCIE_PANE_ID" ] && PANE=" | pane ${CCIE_PANE_ID:0:8}"
echo "[$MODEL] 📁 $DIR_NAME$GIT_BRANCH$PANE"
"#
}
```

- [ ] **Step 4: Add `statusLine` to the settings builder**

In `build_hooks_settings`, replace the returned `json!` object (currently `:56-63`) so it also emits `statusLine`. Change:

```rust
    serde_json::json!({
        "hooks": {
            "UserPromptSubmit": [ cmd("working") ],
            "PreToolUse":       [ cmd("working") ],
            "Stop":             [ cmd("idle") ],
            "Notification":     [ cmd("waiting") ],
        }
    })
```

to:

```rust
    let script_path = config_dir()
        .map(|d| d.join("statusline.sh").to_string_lossy().into_owned())
        .unwrap_or_else(|_| "statusline.sh".to_string());

    serde_json::json!({
        "hooks": {
            "UserPromptSubmit": [ cmd("working") ],
            "PreToolUse":       [ cmd("working") ],
            "Stop":             [ cmd("idle") ],
            "Notification":     [ cmd("waiting") ],
        },
        "statusLine": {
            "type": "command",
            "command": script_path,
        }
    })
```

- [ ] **Step 5: Write the script in `install()` and mark it executable**

In `install()`, AFTER the `std::fs::write(&path, ...)` for `settings.json` (`:75-76`) and BEFORE the `tracing::info!` line, insert:

```rust
    // Also write the statusLine script the settings.json points at, and make
    // it executable so Claude Code can run it.
    let script_path = dir.join("statusline.sh");
    std::fs::write(&script_path, statusline_script()).context("write statusline.sh")?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = std::fs::metadata(&script_path)
            .context("stat statusline.sh")?
            .permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&script_path, perms).context("chmod statusline.sh")?;
    }
```

- [ ] **Step 6: Run tests to verify they pass**

Run (from `src-tauri/`): `cargo nextest run -p ccie-terminal-lib claude_hooks`
Expected: PASS — the 3 pre-existing tests plus the 2 new ones.

- [ ] **Step 7: Manual verification**

1. Rebuild + launch the app (`cargo build` then run) so `install()` re-runs at boot.
2. Confirm the files exist:
   `ls -l "$HOME/Library/Application Support/ccie-terminal/claude-config/"` shows `settings.json` and an executable `statusline.sh`.
3. Smoke the script: `echo '{"model":{"display_name":"Opus"},"workspace":{"current_dir":"/x/y"}}' | "$HOME/Library/Application Support/ccie-terminal/claude-config/statusline.sh"` prints `[Opus] 📁 y ...`.
4. Launch `claude` in a pane; confirm the statusline row renders.

- [ ] **Step 8: Commit**

```bash
git add src-tauri/src/claude_hooks.rs
git commit -m "feat(agents): app-managed Claude statusLine (Phase 2)"
```

---

## Phase 3 — Agent toolbelt with foreground-process detection

### Task 4: `PtyHandle::foreground_process_name()` + classifier

**Files:**
- Modify: `src-tauri/src/pty.rs` (impl block for `PtyHandle`, near the existing `pid()` at `:124-128`).
- Create: `src-tauri/src/pane_context/foreground.rs`
- Modify: `src-tauri/src/pane_context/mod.rs` (add `pub mod foreground;`)

**Interfaces:**
- Consumes: `MasterPty::process_group_leader() -> Option<libc::pid_t>` (provided by `portable-pty` 0.9); `libc` (already a dep).
- Produces:
  - `pub fn foreground_process_name(&self) -> Option<String>` on `PtyHandle` — basename of the foreground process-group leader, or `None`.
  - `pub fn foreground_agent_for(name: &str) -> Option<String>` in `pane_context::foreground` — returns `Some("claude")` / `Some("codex")` for a matching process name, else `None`.

- [ ] **Step 1: Write the failing classifier test**

Create `src-tauri/src/pane_context/foreground.rs`:

```rust
//! Classify a foreground process name into an agent CLI id (or nothing).
//!
//! Phase 3 (Warp-style toolbelt): the PTY poll resolves the foreground
//! process-group leader's basename; this maps it to `claude`/`codex`. Kept
//! separate from `is_agent_command` (which parses a shell command line) so the
//! process-name path is independently testable.

/// The agent CLIs the toolbelt recognizes. Mirrors `manager::AGENT_CLIS`.
const AGENT_PROCESS_NAMES: &[&str] = &["claude", "codex"];

/// Map a raw process name (basename) to its agent id, if it is one.
pub fn foreground_agent_for(name: &str) -> Option<String> {
    let n = name.trim();
    AGENT_PROCESS_NAMES
        .iter()
        .find(|a| **a == n)
        .map(|a| a.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_known_agents() {
        assert_eq!(foreground_agent_for("claude").as_deref(), Some("claude"));
        assert_eq!(foreground_agent_for("codex").as_deref(), Some("codex"));
    }

    #[test]
    fn ignores_shell_and_others() {
        assert_eq!(foreground_agent_for("zsh"), None);
        assert_eq!(foreground_agent_for("vim"), None);
        assert_eq!(foreground_agent_for(""), None);
    }

    #[test]
    fn trims_whitespace() {
        assert_eq!(foreground_agent_for(" claude\n").as_deref(), Some("claude"));
    }
}
```

- [ ] **Step 2: Declare the module**

In `src-tauri/src/pane_context/mod.rs`, add alongside the other `pub mod` declarations:

```rust
pub mod foreground;
```

- [ ] **Step 3: Run the classifier test to verify it fails then passes**

Run (from `src-tauri/`): `cargo nextest run -p ccie-terminal-lib foreground`
Expected: initially FAIL if module not yet wired; after Steps 1-2, PASS — 3 tests.

- [ ] **Step 4: Add `foreground_process_name` to `PtyHandle`**

In `src-tauri/src/pty.rs`, inside the FIRST `impl PtyHandle` block (the one containing `pid()`, `:124-144`), after `pub fn pid(&self)` (`:126-128`), add:

```rust
    /// Basename of the current foreground process-group leader in this PTY,
    /// e.g. "claude" when the user is running Claude Code, "zsh" at the prompt.
    /// Used by the agent-toolbelt poll to detect an in-pane agent BEFORE it
    /// fires any lifecycle hook. Returns `None` if the platform can't report
    /// the leader or its name.
    #[cfg(target_os = "macos")]
    pub fn foreground_process_name(&self) -> Option<String> {
        let pgid = self.master.lock().process_group_leader()?;
        proc_name_macos(pgid)
    }

    #[cfg(not(target_os = "macos"))]
    pub fn foreground_process_name(&self) -> Option<String> {
        None
    }
```

Then, at the END of `pty.rs` (module scope, after the last `impl`/before `#[cfg(test)]`), add the macOS name resolver:

```rust
/// Resolve a pid to its executable basename via macOS `proc_pidpath`.
#[cfg(target_os = "macos")]
fn proc_name_macos(pid: libc::pid_t) -> Option<String> {
    const PROC_PIDPATHINFO_MAXSIZE: usize = 4096;
    let mut buf = [0u8; PROC_PIDPATHINFO_MAXSIZE];
    // SAFETY: buf is valid for `buf.len()` bytes; proc_pidpath writes at most
    // that many and returns the number written (<=0 on failure).
    let n = unsafe {
        libc::proc_pidpath(
            pid,
            buf.as_mut_ptr() as *mut libc::c_void,
            buf.len() as u32,
        )
    };
    if n <= 0 {
        return None;
    }
    let path = String::from_utf8_lossy(&buf[..n as usize]).into_owned();
    path.rsplit('/').next().map(|s| s.to_string())
}
```

> NOTE: `libc::proc_pidpath` is declared in the `libc` crate for `target_os = "macos"`. If the build reports it missing, add `libproc = "0.14"` to `src-tauri/Cargo.toml` and call `libproc::proc_pid::pidpath(pid)` instead — but try `libc` first (no new dep).

- [ ] **Step 5: Build to verify it compiles**

Run (from `src-tauri/`): `cargo build`
Expected: compiles. If `proc_pidpath` is unresolved, apply the `libproc` fallback from the NOTE and rebuild.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/pty.rs src-tauri/src/pane_context/foreground.rs src-tauri/src/pane_context/mod.rs
git commit -m "feat(agents): PtyHandle foreground-process detection (Phase 3)"
```

### Task 5: Poll task + `pane_foreground_agent` event + command

**Files:**
- Modify: `src-tauri/src/commands/pane_activity.rs` (add the command).
- Modify: `src-tauri/src/lib.rs` (register command at the `pane_activity::*` block `:701-706`; spawn the poll task in `setup`, near the boot tasks around `:1176`).

**Interfaces:**
- Consumes: `AppState.ptys: Arc<Mutex<HashMap<String, PtyHandle>>>`; `PtyHandle::foreground_process_name()` (Task 4); `pane_context::foreground::foreground_agent_for` (Task 4); `tauri::Emitter`.
- Produces:
  - Tauri command `get_pane_foreground_agent(pane_id: String) -> Result<Option<String>, String>`.
  - Tauri event `pane_foreground_agent` with payload `{ paneId: String, agent: Option<String> }` (serde `camelCase`), emitted only when a pane's agent value changes.

- [ ] **Step 1: Add the command**

Open `src-tauri/src/commands/pane_activity.rs`. At the end of the file add:

```rust
/// Current foreground agent CLI (`"claude"`/`"codex"`) running in a pane's PTY,
/// or `None`. Used by the frontend to hydrate the agent toolbelt on mount
/// (the live signal comes from the `pane_foreground_agent` event).
#[tauri::command]
pub fn get_pane_foreground_agent(
    state: tauri::State<'_, super::AppState>,
    pane_id: String,
) -> Result<Option<String>, String> {
    let ptys = state.ptys.lock();
    let Some(h) = ptys.get(&pane_id) else {
        return Ok(None);
    };
    let name = h.foreground_process_name();
    Ok(name.and_then(|n| crate::pane_context::foreground::foreground_agent_for(&n)))
}
```

> Check the existing `use` lines at the top of `pane_activity.rs`; if `super::AppState` isn't the right path (some files `use crate::commands::AppState`), match whatever the other commands in this file use.

- [ ] **Step 2: Register the command**

In `src-tauri/src/lib.rs`, in the `generate_handler!` list next to the other pane-activity commands (`:701-706`), add:

```rust
            commands::pane_activity::get_pane_foreground_agent,
```

- [ ] **Step 3: Spawn the poll task at boot**

In `src-tauri/src/lib.rs`, inside the `setup` closure, AFTER the browser-control-server block that ends at `:1175` (`}` closing that scoped block), insert a new scoped block:

```rust
            // Warp-style agent toolbelt: poll each live PTY's foreground process
            // every ~1.5s and emit `pane_foreground_agent` when a pane starts or
            // stops running claude/codex. Cheap: one process_group_leader syscall
            // per open PTY; only emits on change.
            {
                use tauri::{Emitter, Manager};
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    use std::collections::HashMap;
                    let mut last: HashMap<String, Option<String>> = HashMap::new();
                    let mut ticker =
                        tokio::time::interval(std::time::Duration::from_millis(1500));
                    loop {
                        ticker.tick().await;
                        let state = handle.state::<commands::AppState>();
                        // Snapshot (pane_id, agent) under the lock, then release
                        // it before emitting so we never hold it across await.
                        let current: Vec<(String, Option<String>)> = {
                            let ptys = state.ptys.lock();
                            ptys.iter()
                                .map(|(id, h)| {
                                    let agent = h
                                        .foreground_process_name()
                                        .and_then(|n| {
                                            crate::pane_context::foreground::foreground_agent_for(&n)
                                        });
                                    (id.clone(), agent)
                                })
                                .collect()
                        };

                        let mut seen = std::collections::HashSet::new();
                        for (pane_id, agent) in current {
                            seen.insert(pane_id.clone());
                            if last.get(&pane_id) != Some(&agent) {
                                last.insert(pane_id.clone(), agent.clone());
                                let _ = handle.emit(
                                    "pane_foreground_agent",
                                    serde_json::json!({ "paneId": pane_id, "agent": agent }),
                                );
                            }
                        }
                        // Forget panes whose PTY is gone so a reused id re-emits.
                        last.retain(|id, _| seen.contains(id));
                    }
                });
            }
```

- [ ] **Step 4: Build to verify it compiles**

Run (from `src-tauri/`): `cargo build`
Expected: compiles cleanly. Fix any import path mismatch (`AppState`, `Emitter`, `Manager`).

- [ ] **Step 5: Manual verification (backend signal)**

1. Launch the app.
2. Open a terminal pane; at the shell prompt the toolbelt should NOT appear yet (verified in Task 6). For now, confirm via logs: run `claude` and watch for `pane_foreground_agent` emit in `tracing` output (add a temporary `tracing::debug!` if needed, then remove it before commit).

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/commands/pane_activity.rs src-tauri/src/lib.rs
git commit -m "feat(agents): poll + emit pane_foreground_agent (Phase 3)"
```

### Task 6: Frontend foreground store + `AgentToolbelt` component

**Files:**
- Create: `src/lib/foregroundAgent.ts`
- Create: `src/state/foregroundAgentStore.ts`
- Create: `src/components/AgentToolbelt.tsx`
- Create: `src/components/AgentToolbelt.css`
- Modify: `src/App.tsx` (subscribe the store; mount `<AgentToolbelt />` next to `<MetadataCard />` at `:1364`).

**Interfaces:**
- Consumes: `listen` from `@tauri-apps/api/event`; `invoke` from `@tauri-apps/api/core`; `usePaneActivityStore` (existing); `usePanesStore` (`focusedPaneId`, `resolveRecordingTerminalId`); `ptyTabIdFor` from `src/lib/terminalRegistry`; the `ccie:open-rich-input` CustomEvent contract (Global Constraints).
- Produces:
  - `foregroundAgent.ts`: `type ForegroundAgentEvent = { paneId: string; agent: string | null }`; `listenForegroundAgent(cb)`; `getPaneForegroundAgent(paneId): Promise<string | null>`.
  - `foregroundAgentStore.ts`: `useForegroundAgentStore` with `{ byPane: Map<string,string>; set(paneId, agent|null); get(paneId): string|undefined; subscribeToEvents(): Promise<()=>void> }`.
  - `AgentToolbelt.tsx`: default-exported `<AgentToolbelt />`.

- [ ] **Step 1: Create the lib bindings**

Create `src/lib/foregroundAgent.ts`:

```ts
import { invoke } from '@tauri-apps/api/core';
import { listen, UnlistenFn } from '@tauri-apps/api/event';

export interface ForegroundAgentEvent {
  paneId: string;
  agent: string | null;
}

export function listenForegroundAgent(
  callback: (e: ForegroundAgentEvent) => void,
): Promise<UnlistenFn> {
  return listen<ForegroundAgentEvent>('pane_foreground_agent', (event) => {
    callback(event.payload);
  });
}

export async function getPaneForegroundAgent(paneId: string): Promise<string | null> {
  return invoke('get_pane_foreground_agent', { paneId });
}
```

- [ ] **Step 2: Create the store**

Create `src/state/foregroundAgentStore.ts`:

```ts
import { create } from 'zustand';
import { listenForegroundAgent } from '../lib/foregroundAgent';

interface ForegroundAgentState {
  byPane: Map<string, string>; // paneId (PTY id) -> agent id
  set: (paneId: string, agent: string | null) => void;
  get: (paneId: string) => string | undefined;
  subscribeToEvents: () => Promise<() => void>;
}

export const useForegroundAgentStore = create<ForegroundAgentState>((set, get) => ({
  byPane: new Map(),
  set: (paneId, agent) => {
    set((state) => {
      const next = new Map(state.byPane);
      if (agent) next.set(paneId, agent);
      else next.delete(paneId);
      return { byPane: next };
    });
  },
  get: (paneId) => get().byPane.get(paneId),
  subscribeToEvents: async () => {
    return listenForegroundAgent((e) => get().set(e.paneId, e.agent));
  },
}));
```

- [ ] **Step 3: Create the toolbelt component**

Create `src/components/AgentToolbelt.tsx`:

```tsx
import { useEffect, useState } from 'react';
import { useForegroundAgentStore } from '../state/foregroundAgentStore';
import { usePaneActivityStore } from '../state/paneActivityStore';
import { usePanesStore } from '../state/panesStore';
import { ptyTabIdFor } from '../lib/terminalRegistry';
import { setPaneFocus } from '../lib/paneActivity';
import './AgentToolbelt.css';

/**
 * Warp-style toolbelt: appears over the focused pane when its foreground
 * process is an agent CLI (claude/codex). Shows live working/waiting/idle from
 * paneActivityStore, plus Compose (opens the rich-input modal targeting this
 * pane) and Focus (re-asserts backend focus).
 */
export default function AgentToolbelt() {
  const focusedPaneId = usePanesStore((s) => s.focusedPaneId);
  const activeTabId = usePanesStore((s) => s.focusedPaneId); // focus follows pane
  const byPane = useForegroundAgentStore((s) => s.byPane);
  const activities = usePaneActivityStore((s) => s.activities);
  const [ptyId, setPtyId] = useState<string | null>(null);

  // Resolve the focused pane → its PTY id (backend keys everything by PTY id).
  useEffect(() => {
    if (!focusedPaneId) {
      setPtyId(null);
      return;
    }
    const terminalId = usePanesStore.getState().resolveRecordingTerminalId(focusedPaneId);
    setPtyId(ptyTabIdFor(terminalId) ?? terminalId);
  }, [focusedPaneId, activeTabId]);

  if (!ptyId) return null;
  const agent = byPane.get(ptyId);
  if (!agent) return null;

  const state = activities.get(ptyId)?.notificationState ?? 'idle';
  const label = agent === 'claude' ? 'Claude' : 'Codex';
  const stateLabel =
    state === 'needs_attention' ? 'waiting' : state === 'running' ? 'working' : 'idle';

  return (
    <div className="agent-toolbelt" role="toolbar" aria-label={`${label} controls`}>
      <span className={`agent-toolbelt-dot agent-toolbelt-dot--${state}`} />
      <span className="agent-toolbelt-label">
        {label} · {stateLabel}
      </span>
      <button
        type="button"
        className="agent-toolbelt-btn"
        onClick={() =>
          window.dispatchEvent(
            new CustomEvent('ccie:open-rich-input', { detail: { paneId: ptyId } }),
          )
        }
      >
        Compose
      </button>
      <button
        type="button"
        className="agent-toolbelt-btn"
        onClick={() => void setPaneFocus(ptyId).catch(() => {})}
      >
        Focus
      </button>
    </div>
  );
}
```

> Verify `usePanesStore` exposes `resolveRecordingTerminalId` and `focusedPaneId` (both used at `App.tsx:752` and `:128`). If focus and active-tab are separate concepts in the store, drop the redundant `activeTabId` line and depend only on `focusedPaneId`.

- [ ] **Step 4: Create the styles**

Create `src/components/AgentToolbelt.css`:

```css
.agent-toolbelt {
  position: fixed;
  bottom: 40px; /* clears the status footer */
  right: 16px;
  z-index: 50;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border-radius: 8px;
  background: var(--panel-bg, rgba(28, 28, 32, 0.95));
  border: 1px solid var(--border, rgba(255, 255, 255, 0.12));
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.3);
  font-size: 12px;
  color: var(--text, #e6e6e6);
}
.agent-toolbelt-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #888;
}
.agent-toolbelt-dot--running {
  background: #e0a83e;
  animation: agent-toolbelt-pulse 1.2s ease-in-out infinite;
}
.agent-toolbelt-dot--needs_attention {
  background: #e05656;
}
@keyframes agent-toolbelt-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.35; }
}
.agent-toolbelt-label {
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.agent-toolbelt-btn {
  background: transparent;
  border: 1px solid var(--border, rgba(255, 255, 255, 0.2));
  border-radius: 6px;
  color: inherit;
  padding: 3px 8px;
  cursor: pointer;
}
.agent-toolbelt-btn:hover {
  background: var(--hover, rgba(255, 255, 255, 0.08));
}
```

> Match existing overlay conventions: check `MetadataCard`/`App.css` for the actual CSS variable names (`--panel-bg`, `--border`, etc.). Use the ones already in the codebase rather than inventing new tokens.

- [ ] **Step 5: Subscribe the store + mount the component in App.tsx**

In `src/App.tsx`:

(a) Add the import near the other component imports:

```ts
import AgentToolbelt from "./components/AgentToolbelt";
import { useForegroundAgentStore } from "./state/foregroundAgentStore";
```

(b) Add a subscription effect immediately after the Phase 1 notifier effect (Task 2):

```tsx
  // Warp-style: track which panes are running an agent CLI for the toolbelt.
  useEffect(() => {
    let cleanup: (() => void) | undefined;
    useForegroundAgentStore
      .getState()
      .subscribeToEvents()
      .then((fn) => {
        cleanup = fn;
      });
    return () => {
      if (cleanup) cleanup();
    };
  }, []);
```

(c) Mount the component next to `<MetadataCard />` (`:1364`):

```tsx
      <AgentToolbelt />
```

- [ ] **Step 6: Typecheck**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no new errors.

- [ ] **Step 7: Manual verification (drive the real flow)**

1. Launch the app.
2. Focus a pane at the shell prompt → no toolbelt.
3. Run `claude` in that pane → within ~2s a toolbelt appears bottom-right showing `Claude · idle/working`.
4. Submit a prompt → dot goes amber (working); at a permission prompt → red (waiting).
5. Exit `claude` back to the shell → toolbelt disappears within ~2s.
6. Click **Focus** → no error. (Compose is verified in Phase 4.)

- [ ] **Step 8: Commit**

```bash
git add src/lib/foregroundAgent.ts src/state/foregroundAgentStore.ts src/components/AgentToolbelt.tsx src/components/AgentToolbelt.css src/App.tsx
git commit -m "feat(agents): auto-detecting agent toolbelt (Phase 3)"
```

---

## Phase 4 — Rich input composer

### Task 7: `RichInputModal` component + tests

**Files:**
- Create: `src/components/RichInputModal.tsx`
- Create: `src/components/RichInputModal.css`
- Test: `src/components/RichInputModal.test.tsx`

**Interfaces:**
- Consumes: `ptyWrite(tabId, data: Uint8Array)` from `src/lib/tauri.ts` (existing: `ptyWrite = (tabId, data) => invoke('pty_write', { tabId, data: Array.from(data) })`); `usePanesStore` (`focusedPaneId`, `resolveRecordingTerminalId`); `ptyTabIdFor`; the `ccie:open-rich-input` CustomEvent contract.
- Produces: default-exported `<RichInputModal />`. Self-contained: listens for `ccie:open-rich-input`, resolves the target PTY id, renders a modal, writes `text + "\n"` on send.

- [ ] **Step 1: Write the failing test**

Create `src/components/RichInputModal.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import RichInputModal from './RichInputModal';

const ptyWrite = vi.fn();
vi.mock('../lib/tauri', () => ({
  ptyWrite: (tabId: string, data: Uint8Array) => ptyWrite(tabId, data),
}));
vi.mock('../state/panesStore', () => ({
  usePanesStore: Object.assign(() => null, {
    getState: () => ({
      focusedPaneId: 'pane-focused',
      resolveRecordingTerminalId: (id: string) => id,
    }),
  }),
}));
vi.mock('../lib/terminalRegistry', () => ({
  ptyTabIdFor: (id: string) => id,
}));

function openWith(paneId: string | null) {
  window.dispatchEvent(new CustomEvent('ccie:open-rich-input', { detail: { paneId } }));
}

describe('RichInputModal', () => {
  beforeEach(() => ptyWrite.mockClear());

  it('is hidden until the open event fires', () => {
    render(<RichInputModal />);
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('writes text + newline to the target pane on send', async () => {
    render(<RichInputModal />);
    openWith('pane-A');
    const box = await screen.findByRole('textbox');
    fireEvent.change(box, { target: { value: 'show version' } });
    fireEvent.click(screen.getByText('Send'));
    await waitFor(() => expect(ptyWrite).toHaveBeenCalledTimes(1));
    const [tabId, data] = ptyWrite.mock.calls[0];
    expect(tabId).toBe('pane-A');
    expect(new TextDecoder().decode(data as Uint8Array)).toBe('show version\n');
  });

  it('falls back to the focused pane when paneId is null', async () => {
    render(<RichInputModal />);
    openWith(null);
    const box = await screen.findByRole('textbox');
    fireEvent.change(box, { target: { value: 'hi' } });
    fireEvent.click(screen.getByText('Send'));
    await waitFor(() => expect(ptyWrite).toHaveBeenCalledTimes(1));
    expect(ptyWrite.mock.calls[0][0]).toBe('pane-focused');
  });

  it('cancel closes without writing', async () => {
    render(<RichInputModal />);
    openWith('pane-A');
    await screen.findByRole('textbox');
    fireEvent.click(screen.getByText('Cancel'));
    await waitFor(() => expect(screen.queryByRole('textbox')).toBeNull());
    expect(ptyWrite).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --exclude '**/.worktrees/**' src/components/RichInputModal.test.tsx`
Expected: FAIL — cannot resolve `./RichInputModal`.

- [ ] **Step 3: Write the component**

Create `src/components/RichInputModal.tsx`:

```tsx
import { useEffect, useRef, useState } from 'react';
import { ptyWrite } from '../lib/tauri';
import { usePanesStore } from '../state/panesStore';
import { ptyTabIdFor } from '../lib/terminalRegistry';
import './RichInputModal.css';

/**
 * Warp-style rich input composer. Opened by the `ccie:open-rich-input` event
 * (from the toolbelt's Compose button, the menu accelerator, or the palette).
 * A multi-line textarea; on Send it writes the text plus a trailing newline to
 * the target pane's PTY, then closes. ⌘↵ sends, Esc cancels.
 */
export default function RichInputModal() {
  const [open, setOpen] = useState(false);
  const [targetPane, setTargetPane] = useState<string | null>(null);
  const [text, setText] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const onOpen = (e: Event) => {
      const detail = (e as CustomEvent).detail as { paneId: string | null } | undefined;
      let paneId = detail?.paneId ?? null;
      if (!paneId) {
        const focused = usePanesStore.getState().focusedPaneId;
        if (focused) {
          const terminalId = usePanesStore.getState().resolveRecordingTerminalId(focused);
          paneId = ptyTabIdFor(terminalId) ?? terminalId;
        }
      }
      setTargetPane(paneId);
      setText('');
      setOpen(true);
    };
    window.addEventListener('ccie:open-rich-input', onOpen);
    return () => window.removeEventListener('ccie:open-rich-input', onOpen);
  }, []);

  useEffect(() => {
    if (open) ref.current?.focus();
  }, [open]);

  if (!open) return null;

  const close = () => {
    setOpen(false);
    setText('');
  };

  const send = () => {
    if (targetPane && text.length > 0) {
      void ptyWrite(targetPane, new TextEncoder().encode(text + '\n')).catch(() => {});
    }
    close();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      send();
    }
  };

  return (
    <div className="rich-input-overlay" onMouseDown={close}>
      <div className="rich-input-modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="rich-input-header">Compose input</div>
        <textarea
          ref={ref}
          className="rich-input-textarea"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          rows={6}
          placeholder="Type multi-line input; ⌘↵ to send, Esc to cancel"
        />
        <div className="rich-input-footer">
          <button type="button" className="rich-input-btn" onClick={close}>
            Cancel
          </button>
          <button type="button" className="rich-input-btn rich-input-btn--primary" onClick={send}>
            Send
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Create the styles**

Create `src/components/RichInputModal.css`:

```css
.rich-input-overlay {
  position: fixed;
  inset: 0;
  z-index: 200;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.4);
}
.rich-input-modal {
  width: min(640px, 90vw);
  background: var(--panel-bg, #1c1c20);
  border: 1px solid var(--border, rgba(255, 255, 255, 0.12));
  border-radius: 10px;
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.4);
  color: var(--text, #e6e6e6);
  padding: 14px;
}
.rich-input-header {
  font-size: 13px;
  font-weight: 600;
  margin-bottom: 8px;
}
.rich-input-textarea {
  width: 100%;
  resize: vertical;
  font-family: var(--mono, ui-monospace, monospace);
  font-size: 13px;
  background: var(--input-bg, #101014);
  color: inherit;
  border: 1px solid var(--border, rgba(255, 255, 255, 0.15));
  border-radius: 6px;
  padding: 8px;
  box-sizing: border-box;
}
.rich-input-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 10px;
}
.rich-input-btn {
  background: transparent;
  border: 1px solid var(--border, rgba(255, 255, 255, 0.2));
  border-radius: 6px;
  color: inherit;
  padding: 5px 12px;
  cursor: pointer;
}
.rich-input-btn--primary {
  background: var(--accent, #3b6fe0);
  border-color: transparent;
  color: #fff;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run --exclude '**/.worktrees/**' src/components/RichInputModal.test.tsx`
Expected: PASS — 4 tests.

> If `@testing-library/react` is not installed, check `package.json`. The project already uses vitest; if RTL is absent, adapt the test to the project's existing component-test pattern (grep `render(` in `src/**/*.test.tsx` for the harness already in use, e.g. IacStudioTab.test.tsx) rather than adding a dependency.

- [ ] **Step 6: Commit**

```bash
git add src/components/RichInputModal.tsx src/components/RichInputModal.css src/components/RichInputModal.test.tsx
git commit -m "feat(agents): rich-input composer modal (Phase 4)"
```

### Task 8: Wire the composer — mount, menu accelerator, palette

**Files:**
- Modify: `src/App.tsx` (mount `<RichInputModal />`; `listen('menu:rich_input')`).
- Modify: `src-tauri/src/lib.rs` (menu item + submenu placement + emit arm).
- Modify: `src/components/CommandPalette.tsx` (`STATIC_ACTIONS` entry + dispatch arm).

**Interfaces:**
- Consumes: `RichInputModal` (Task 7); the `ccie:open-rich-input` contract; existing menu/emit/listen pattern (`pane_metadata_toggle` at `lib.rs:851`, `:1061`, `App.tsx:370`).
- Produces: nothing consumed downstream.

- [ ] **Step 1: Mount the modal in App.tsx**

Add the import near other component imports:

```ts
import RichInputModal from "./components/RichInputModal";
```

Mount it next to `<AgentToolbelt />` (Task 6c):

```tsx
      <RichInputModal />
```

- [ ] **Step 2: Add the menu listener in App.tsx**

Alongside the other `listen('menu:...')` handlers (e.g. after `menu:pane_metadata_toggle` at `:370-376`), add:

```tsx
    unlistens.push(listen('menu:rich_input', () => {
      window.dispatchEvent(
        new CustomEvent('ccie:open-rich-input', { detail: { paneId: null } }),
      );
    }));
```

- [ ] **Step 3: Add the menu item + emit arm in lib.rs**

In `src-tauri/src/lib.rs`, extend the existing **Pane** submenu (`:851-852`). Replace:

```rust
            let pane_metadata_toggle = MenuItem::with_id(app, "pane_metadata_toggle", "Toggle Metadata Card", true, Some("CmdOrCtrl+Shift+L"))?;
            let pane_menu = Submenu::with_items(app, "Pane", true, &[&pane_metadata_toggle])?;
```

with:

```rust
            let pane_metadata_toggle = MenuItem::with_id(app, "pane_metadata_toggle", "Toggle Metadata Card", true, Some("CmdOrCtrl+Shift+L"))?;
            let rich_input = MenuItem::with_id(app, "rich_input", "Compose Input…", true, Some("CmdOrCtrl+Shift+Enter"))?;
            let pane_menu = Submenu::with_items(app, "Pane", true, &[&pane_metadata_toggle, &rich_input])?;
```

Then add the emit arm next to `"pane_metadata_toggle"` (`:1061`):

```rust
                    "rich_input" => { window.emit("menu:rich_input", ()).ok(); }
```

> Verify `CmdOrCtrl+Shift+Enter` is a valid Tauri accelerator and unused. The scan of existing `Shift` accelerators (W, M, I, L, C, 1, 2, F, D, G, B, K, S, E, V) shows no `Enter`/`Return` binding. If Tauri rejects `Enter`, use `CmdOrCtrl+Shift+J` (freed when chains were removed) and update the menu label/help accordingly.

- [ ] **Step 4: Add the palette entry + dispatch in CommandPalette.tsx**

In `src/components/CommandPalette.tsx`, add to `STATIC_ACTIONS` (`:34-45`):

```ts
  {
    kind: "command",
    target_id: "agents:compose-input",
    title: "Compose Input to Agent",
    subtitle: "Open a multi-line composer and send it to the focused pane",
    score: 0,
    recency_boost: 0,
    frequency_boost: 0,
    meta: {},
  },
```

Then in `dispatchAction`'s `case "command":` (`:162`), add the branch BEFORE the generic fallthrough (mirroring the `iac:get-started-pipelines` branch at `:163`):

```ts
          if (hit.target_id === "agents:compose-input") {
            window.dispatchEvent(
              new CustomEvent("ccie:open-rich-input", { detail: { paneId: null } }),
            );
            break;
          }
```

- [ ] **Step 5: Build + typecheck**

Run (from `src-tauri/`): `cargo build`
Run: `npx tsc --noEmit -p tsconfig.json`
Expected: both clean.

- [ ] **Step 6: Manual verification (drive the real flow)**

1. Launch the app.
2. Trigger the accelerator (⌘⇧Enter) → the composer opens.
3. Type multi-line text, press ⌘↵ → the text (plus newline) appears in the focused pane's terminal input.
4. Reopen, press Esc → closes, nothing written.
5. Open the palette (⌘K), pick "Compose Input to Agent" → composer opens.
6. Run `claude` in a pane, click the toolbelt's **Compose** → composer opens targeting that pane; send → text lands in that pane.

- [ ] **Step 7: Commit**

```bash
git add src/App.tsx src-tauri/src/lib.rs src/components/CommandPalette.tsx
git commit -m "feat(agents): wire rich-input via menu + palette + toolbelt (Phase 4)"
```

---

## Self-Review

**Spec coverage:**
- Phase 1 (notify on needs_attention) → Tasks 1-2. ✓
- Phase 2 (statusLine in app-managed config) → Task 3. ✓
- Phase 3 (toolbelt + PID/foreground detection) → Tasks 4-6. ✓ (Detection uses `MasterPty::process_group_leader` + `proc_pidpath` — an improvement over the spec's `tcgetpgrp`/raw-fd approach; more surgical, no `pty.rs` spawn changes.)
- Phase 4 (rich input composer) → Tasks 7-8. ✓
- Out of scope: inline code review — absent, as required. ✓

**Placeholder scan:** No TBD/TODO; every code step shows complete code; NOTE blocks flag real verification points (tab-title field name, `proc_pidpath` availability, CSS var names, RTL availability, accelerator validity), each with a concrete fallback — not deferred work.

**Type consistency:**
- `NotificationState` values `'idle' | 'running' | 'needs_attention'` used consistently (Task 1 tests, AgentToolbelt).
- Event `pane_foreground_agent` payload `{ paneId, agent }` matches `ForegroundAgentEvent` (Task 5 emit ↔ Task 6 lib).
- `ccie:open-rich-input` `detail: { paneId: string | null }` consistent across Tasks 6, 7, 8.
- `ptyWrite(tabId, data: Uint8Array)` matches `src/lib/tauri.ts:105`.
- `foreground_agent_for` name identical in Tasks 4, 5.
- `get_pane_foreground_agent` command name identical in Tasks 5, 6.

**Scope:** One coherent feature set, four phases, each independently shippable and verifiable. No decomposition needed.

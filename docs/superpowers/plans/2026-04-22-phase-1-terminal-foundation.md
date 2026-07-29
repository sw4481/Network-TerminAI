# Phase 1: Terminal Foundation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a usable multi-tab terminal. Each tab spawns a local shell via `portable-pty`, xterm.js renders it, output is grouped into Warp-style command blocks (OSC 133), tabs + scrollback persist across app restarts.

**Architecture:** Rust owns PTY processes (1 per tab) via `portable-pty`; PTY bytes stream to the frontend over Tauri Channels; xterm.js renders them; a Rust-side parser detects OSC 133 sequences to emit `command_start` / `command_end` events that the UI overlays as command blocks. SQLite persists tab metadata + scrollback (bounded).

**Tech Stack:** Tauri v2, Rust (`portable-pty`, `tokio`, `rusqlite`, `refinery`), React + TypeScript, xterm.js + xterm-addon-fit + xterm-addon-web-links.

**Project root:** `/Users/shaunwhi/CCIE Terminal`. Branch: `main`. Base: `phase-0` tag (`f0a4025`).

---

## Scope

**In V1 of Phase 1:**
- Local shell only (`$SHELL` from env; macOS/Linux: `/bin/zsh` fallback, Windows: `powershell.exe`).
- Multi-tab UI: add/close/rename.
- xterm.js with proper resize → PTY resize.
- Warp-style **command blocks** via OSC 133 shell integration.
- Tab state + scrollback (bounded, ring-buffer) persist across restart via SQLite.
- Copy / select-all / clear-screen keyboard shortcuts.

**Deferred (explicitly noted in code):**
- **Prompt-regex fallback** for command blocks (Cisco IOS `Router#` detection) → TODO comment in `command_parser.rs`; tracked for Phase 1.5 or Phase 2. Until then, SSH sessions render as one continuous block.
- Search within a tab's scrollback → Phase 6.
- Tab reordering via drag-and-drop → nice-to-have, punt.
- Split panes → post-V1.

---

## File structure added by this phase

```
CCIE Terminal/
├── src-tauri/
│   ├── Cargo.toml                    # + portable-pty, tokio, uuid, chrono
│   ├── migrations/
│   │   └── V0002__tabs_and_blocks.sql   # tab + command_block tables
│   ├── src/
│   │   ├── lib.rs                    # register pty, session, commands modules
│   │   ├── pty.rs                    # PTY session manager (one session per tab)
│   │   ├── session.rs                # SQLite store: tabs, blocks, scrollback
│   │   ├── command_parser.rs         # OSC 133 state machine
│   │   ├── shell_integration.rs      # ships the zsh/bash init file & installs on first launch
│   │   └── commands.rs               # + pty_spawn, pty_write, pty_resize, pty_kill, list_tabs, close_tab
│   └── tests/
│       ├── pty_test.rs
│       ├── command_parser_test.rs
│       └── session_test.rs           # (extends Phase 0 db_test patterns)
├── sidecar/                          # untouched
├── src/
│   ├── App.tsx                       # becomes the tabbed terminal shell
│   ├── App.css                       # terminal chrome styling
│   ├── components/
│   │   ├── TabBar.tsx
│   │   ├── Terminal.tsx
│   │   └── CommandBlock.tsx
│   ├── hooks/
│   │   └── usePty.ts                 # subscribes to PTY channel, forwards keystrokes
│   ├── lib/
│   │   ├── tauri.ts                  # + pty_* wrappers (keeps Phase 0 ping wrappers)
│   │   └── types.ts                  # shared types (Tab, CommandBlock, PtyEvent)
│   └── state/
│       └── tabsStore.ts              # Zustand store for tabs[] + activeTabId
├── shell-integration/
│   ├── ccie-terminal.zsh             # OSC 133 emitting zsh hook
│   └── ccie-terminal.bash            # OSC 133 emitting bash hook
└── package.json                      # + zustand, @xterm/xterm, @xterm/addon-fit, @xterm/addon-web-links
```

**Responsibility boundaries:**
- `pty.rs` knows about `portable-pty::PtySystem` — nothing else does.
- `command_parser.rs` is pure: in = bytes, out = `ParseEvent` stream. No IO.
- `session.rs` owns SQL — every other module asks it for state.
- `commands.rs` is the Tauri-boundary adapter; it should stay short.
- Frontend: `usePty` is the single subscribe point. `TabBar` / `Terminal` / `CommandBlock` are presentation.

---

## Task 1: Add Rust deps + Phase 1 migration

**Files:**
- Modify: `src-tauri/Cargo.toml`
- Create: `src-tauri/migrations/V0002__tabs_and_blocks.sql`

- [ ] **Step 1: Add deps**

Append to `src-tauri/Cargo.toml` under `[dependencies]`:

```toml
portable-pty = "0.9"
tokio = { version = "1", features = ["rt-multi-thread", "macros", "sync", "io-util"] }
uuid = { version = "1", features = ["v4", "serde"] }
chrono = { version = "0.4", features = ["serde"] }
parking_lot = "0.12"
```

- [ ] **Step 2: Create migration `src-tauri/migrations/V0002__tabs_and_blocks.sql`**

```sql
-- Tabs persisted across app restarts.
CREATE TABLE IF NOT EXISTS tabs (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  shell_cmd TEXT NOT NULL,
  cwd TEXT NOT NULL,
  -- profile_id reserved for Phase 2 (AI profiles); NULL in Phase 1.
  profile_id TEXT,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  closed_at INTEGER
);

-- One row per command/output pair identified by OSC 133.
CREATE TABLE IF NOT EXISTS command_blocks (
  id TEXT PRIMARY KEY,
  tab_id TEXT NOT NULL REFERENCES tabs(id) ON DELETE CASCADE,
  cmd TEXT NOT NULL,
  output BLOB NOT NULL,
  exit_code INTEGER,
  started_at INTEGER NOT NULL,
  ended_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_blocks_tab ON command_blocks(tab_id, started_at);

-- Raw scrollback ring buffer per tab (bounded).
-- Phase 1 stores bytes rather than UTF-8 to survive binary output from tools like `curl | gzip`.
CREATE TABLE IF NOT EXISTS scrollback (
  tab_id TEXT NOT NULL REFERENCES tabs(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  chunk BLOB NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  PRIMARY KEY (tab_id, seq)
);
```

- [ ] **Step 3: Verify migrations still compile**

```bash
cd "/Users/shaunwhi/CCIE Terminal/src-tauri"
source "$HOME/.cargo/env"
cargo build
```

Expected: `portable-pty` + `tokio` compile (first time takes ~1-2 min).

- [ ] **Step 4: Run existing tests (no regression)**

```bash
cargo test
```

Expected: 3 existing tests still pass.

- [ ] **Step 5: Commit**

```bash
cd "/Users/shaunwhi/CCIE Terminal"
git add -A
git commit -m "chore(deps): add portable-pty, tokio, uuid, chrono for Phase 1"
```

---

## Task 2: OSC 133 command-parser (TDD)

The parser is pure (bytes in, events out). This is the heart of the command-block feature and the easiest thing to unit-test in isolation.

**Background:** OSC 133 is the [Final Term / iTerm2 / WezTerm / Warp shell-integration spec](https://gitlab.freedesktop.org/Per_Bothner/specifications/-/blob/master/proposals/semantic-prompts.md). Four sequences matter:
- `\x1b]133;A\x07` — prompt start
- `\x1b]133;B\x07` — prompt end (= command about to be entered)
- `\x1b]133;C\x07` — command executed (= output follows)
- `\x1b]133;D;<exit>\x07` — command ended (optional exit code)

Between B and C we capture the command line. Between C and D we capture output.

**Files:**
- Create: `src-tauri/src/command_parser.rs`
- Create: `src-tauri/tests/command_parser_test.rs`
- Modify: `src-tauri/src/lib.rs` (add `pub mod command_parser;`)

- [ ] **Step 1: Write the failing test**

Create `src-tauri/tests/command_parser_test.rs`:

```rust
use ccie_terminal_lib::command_parser::{ParseEvent, Parser};

fn osc133(code: char, payload: Option<&str>) -> String {
    match payload {
        Some(p) => format!("\x1b]133;{};{}\x07", code, p),
        None => format!("\x1b]133;{}\x07", code),
    }
}

#[test]
fn emits_no_events_for_plain_bytes() {
    let mut p = Parser::new();
    let events = p.feed(b"hello world\n");
    assert!(
        !events.iter().any(|e| matches!(e, ParseEvent::CommandStart { .. } | ParseEvent::CommandEnd { .. })),
        "got: {events:?}"
    );
    // Plain bytes still flow through as passthrough.
    let bytes: Vec<u8> = events.iter().flat_map(|e| match e {
        ParseEvent::Output(b) => b.clone(),
        _ => Vec::new(),
    }).collect();
    assert_eq!(bytes, b"hello world\n");
}

#[test]
fn detects_full_command_lifecycle() {
    let mut p = Parser::new();
    let mut events = Vec::new();

    let s = format!("{}{}{}{}",
        osc133('A', None),          // prompt start (ignored by us)
        osc133('B', None),          // prompt end (command coming)
        "ls -la\n",                  // the command
        osc133('C', None),          // command executed (output follows)
    );
    events.extend(p.feed(s.as_bytes()));
    events.extend(p.feed(b"total 48\n"));
    events.extend(p.feed(osc133('D', Some("0")).as_bytes()));

    let names: Vec<&str> = events.iter().map(|e| match e {
        ParseEvent::CommandStart { .. } => "start",
        ParseEvent::CommandEnd { .. } => "end",
        ParseEvent::Output(_) => "out",
    }).collect();

    assert!(names.contains(&"start"), "expected start: {names:?}");
    assert!(names.contains(&"end"), "expected end: {names:?}");
    // Command text captured
    let start = events.iter().find_map(|e| match e {
        ParseEvent::CommandStart { cmd, .. } => Some(cmd.clone()),
        _ => None,
    }).unwrap();
    assert_eq!(start.trim(), "ls -la");

    // Exit code captured
    let end_exit = events.iter().find_map(|e| match e {
        ParseEvent::CommandEnd { exit_code, .. } => Some(*exit_code),
        _ => None,
    }).unwrap();
    assert_eq!(end_exit, Some(0));
}

#[test]
fn handles_split_osc_across_chunks() {
    let mut p = Parser::new();
    // Split right in the middle of the OSC 133 C sequence
    let first = format!("{}{}echo hi\n\x1b]133", osc133('A', None), osc133('B', None));
    let second = ";C\x07output\n";

    let mut events = Vec::new();
    events.extend(p.feed(first.as_bytes()));
    events.extend(p.feed(second.as_bytes()));

    assert!(events.iter().any(|e| matches!(e, ParseEvent::CommandStart { .. })));
}

#[test]
fn handles_missing_exit_code() {
    let mut p = Parser::new();
    let s = format!("{}{}pwd\n{}{}", osc133('A', None), osc133('B', None), osc133('C', None), osc133('D', None));
    let events = p.feed(s.as_bytes());
    let end_exit = events.iter().find_map(|e| match e {
        ParseEvent::CommandEnd { exit_code, .. } => Some(*exit_code),
        _ => None,
    }).unwrap();
    assert_eq!(end_exit, None);
}

#[test]
fn ignores_unrelated_osc_escapes() {
    let mut p = Parser::new();
    // OSC 0 (set window title) — should pass through unchanged, no lifecycle events.
    let events = p.feed(b"\x1b]0;my title\x07hello\n");
    assert!(!events.iter().any(|e| matches!(e, ParseEvent::CommandStart { .. } | ParseEvent::CommandEnd { .. })));
}
```

- [ ] **Step 2: Run test — MUST fail**

```bash
cd "/Users/shaunwhi/CCIE Terminal/src-tauri"
source "$HOME/.cargo/env"
cargo test --test command_parser_test
```

Expected: unresolved import.

- [ ] **Step 3: Implement `src-tauri/src/command_parser.rs`**

```rust
//! OSC 133 (Final Term / iTerm2 semantic prompts) parser.
//!
//! Consumes raw PTY bytes, emits a stream of events:
//!   - `CommandStart { cmd }` when we see B..C (command text between them)
//!   - `CommandEnd { exit_code }` when we see D;<code>
//!   - `Output(bytes)` for everything else (stripped of OSC 133 sequences)
//!
//! TODO(phase-1.5): prompt-regex fallback for shells without OSC 133
//! (notably SSH into Cisco IOS — Router#, Switch(config)#, etc.).

#[derive(Debug, Clone)]
pub enum ParseEvent {
    Output(Vec<u8>),
    CommandStart { cmd: String },
    CommandEnd { exit_code: Option<i32> },
}

#[derive(Debug)]
enum State {
    Normal,
    /// Saw `\x1b`; may be the start of an OSC.
    Esc,
    /// Saw `\x1b]`; reading until BEL or ST.
    Osc,
}

pub struct Parser {
    state: State,
    /// Buffer for the body of an OSC sequence (between `\x1b]` and `\x07`).
    osc_buf: Vec<u8>,
    /// When we've seen `133;B`, we accumulate bytes here until `133;C`.
    capturing_cmd: bool,
    cmd_buf: Vec<u8>,
    /// Pending plain output bytes (flushed when we emit an event or at end of feed).
    out_buf: Vec<u8>,
}

impl Parser {
    pub fn new() -> Self {
        Self {
            state: State::Normal,
            osc_buf: Vec::new(),
            capturing_cmd: false,
            cmd_buf: Vec::new(),
            out_buf: Vec::new(),
        }
    }

    pub fn feed(&mut self, input: &[u8]) -> Vec<ParseEvent> {
        let mut events = Vec::new();
        for &b in input {
            match self.state {
                State::Normal => match b {
                    0x1b => self.state = State::Esc,
                    _ => self.push_byte(b),
                },
                State::Esc => match b {
                    b']' => {
                        self.state = State::Osc;
                        self.osc_buf.clear();
                    }
                    0x1b => { /* stay in Esc */ }
                    _ => {
                        // Not an OSC; passthrough the original ESC + this byte.
                        self.push_byte(0x1b);
                        self.push_byte(b);
                        self.state = State::Normal;
                    }
                },
                State::Osc => match b {
                    0x07 /* BEL */ => {
                        self.handle_osc(&mut events);
                        self.osc_buf.clear();
                        self.state = State::Normal;
                    }
                    _ => self.osc_buf.push(b),
                },
            }
        }
        self.flush_output(&mut events);
        events
    }

    fn push_byte(&mut self, b: u8) {
        if self.capturing_cmd {
            self.cmd_buf.push(b);
        } else {
            self.out_buf.push(b);
        }
    }

    fn flush_output(&mut self, events: &mut Vec<ParseEvent>) {
        if !self.out_buf.is_empty() {
            let buf = std::mem::take(&mut self.out_buf);
            events.push(ParseEvent::Output(buf));
        }
    }

    fn handle_osc(&mut self, events: &mut Vec<ParseEvent>) {
        let body = std::str::from_utf8(&self.osc_buf).unwrap_or("");
        if let Some(rest) = body.strip_prefix("133;") {
            self.flush_output(events);
            match rest.chars().next() {
                Some('A') => { /* prompt start — ignore */ }
                Some('B') => {
                    self.capturing_cmd = true;
                    self.cmd_buf.clear();
                }
                Some('C') => {
                    if self.capturing_cmd {
                        self.capturing_cmd = false;
                        // Trim trailing newline(s) typed to run the command.
                        let cmd = String::from_utf8_lossy(&self.cmd_buf)
                            .trim_end_matches(&['\n', '\r'][..])
                            .to_string();
                        events.push(ParseEvent::CommandStart { cmd });
                        self.cmd_buf.clear();
                    }
                }
                Some('D') => {
                    let exit_code = rest
                        .split(';')
                        .nth(1)
                        .and_then(|s| s.parse::<i32>().ok());
                    events.push(ParseEvent::CommandEnd { exit_code });
                }
                _ => { /* unknown 133; subcommand — ignore */ }
            }
            return;
        }
        // Unrelated OSC (e.g. OSC 0 window title). We drop it silently —
        // xterm.js will see the escape we *didn't* strip because we consumed it.
        // For Phase 1 this is acceptable; xterm.js tolerates missing title updates.
        // TODO(phase-1): re-emit non-133 OSC so xterm.js can still act on them
        // (e.g. window title, hyperlinks).
    }
}

impl Default for Parser {
    fn default() -> Self {
        Self::new()
    }
}
```

- [ ] **Step 4: Register module**

Add `pub mod command_parser;` to `src-tauri/src/lib.rs` alongside the other `pub mod` declarations.

- [ ] **Step 5: Run test — MUST pass**

```bash
cd "/Users/shaunwhi/CCIE Terminal/src-tauri"
source "$HOME/.cargo/env"
cargo test --test command_parser_test
```

Expected: 5 tests pass.

- [ ] **Step 6: Run full suite (no regressions)**

```bash
cargo test
```

Expected: 8 total (3 Phase 0 + 5 new).

- [ ] **Step 7: Commit**

```bash
cd "/Users/shaunwhi/CCIE Terminal"
git add -A
git commit -m "feat(core): OSC 133 command-parser with TDD"
```

---

## Task 3: PTY session manager (TDD)

Owns one `portable_pty::PtyPair` per tab. Each session has a reader task that funnels bytes through the parser and emits events.

**Files:**
- Create: `src-tauri/src/pty.rs`
- Create: `src-tauri/tests/pty_test.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Write the failing test**

Create `src-tauri/tests/pty_test.rs`:

```rust
use ccie_terminal_lib::pty::{spawn_pty, PtyEvent, PtyOptions};
use std::time::Duration;
use tokio::sync::mpsc;

fn default_shell() -> String {
    if cfg!(windows) {
        "cmd.exe".to_string()
    } else {
        "/bin/sh".to_string()
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn spawn_shell_echo_and_exit() {
    let (tx, mut rx) = mpsc::channel::<PtyEvent>(32);
    let opts = PtyOptions {
        shell: default_shell(),
        args: if cfg!(windows) {
            vec!["/c".into(), "echo hello".into()]
        } else {
            vec!["-c".into(), "echo hello".into()]
        },
        cwd: std::env::temp_dir().to_string_lossy().into_owned(),
        cols: 80,
        rows: 24,
    };

    let handle = spawn_pty(opts, tx).await.expect("spawn_pty");

    // Expect at least one Output event containing "hello", then an Exit event.
    let mut saw_hello = false;
    let mut saw_exit = false;
    while let Ok(Some(ev)) = tokio::time::timeout(Duration::from_secs(5), rx.recv()).await {
        match ev {
            PtyEvent::Output(bytes) => {
                if String::from_utf8_lossy(&bytes).contains("hello") {
                    saw_hello = true;
                }
            }
            PtyEvent::Exit { .. } => {
                saw_exit = true;
                break;
            }
            _ => {}
        }
    }
    assert!(saw_hello, "never saw 'hello' in output");
    assert!(saw_exit, "never saw Exit event");

    drop(handle);
}

#[tokio::test(flavor = "multi_thread")]
async fn resize_does_not_crash() {
    let (tx, _rx) = mpsc::channel::<PtyEvent>(32);
    let opts = PtyOptions {
        shell: default_shell(),
        args: vec![],
        cwd: std::env::temp_dir().to_string_lossy().into_owned(),
        cols: 80,
        rows: 24,
    };
    let handle = spawn_pty(opts, tx).await.expect("spawn_pty");
    handle.resize(120, 40).expect("resize");
    // Give the child a moment, then drop.
    tokio::time::sleep(Duration::from_millis(50)).await;
    drop(handle);
}
```

- [ ] **Step 2: Run test — MUST fail (unresolved import)**

```bash
cd "/Users/shaunwhi/CCIE Terminal/src-tauri"
source "$HOME/.cargo/env"
cargo test --test pty_test
```

- [ ] **Step 3: Implement `src-tauri/src/pty.rs`**

```rust
//! PTY session manager. One `PtyHandle` per tab.
//!
//! Responsibilities:
//!   - Spawn a shell via `portable-pty` (cross-platform, ConPTY on Windows).
//!   - Run a reader task that funnels PTY bytes through `command_parser::Parser`
//!     and forwards events on an `mpsc::Sender<PtyEvent>`.
//!   - Accept write / resize / kill operations from the caller.

use crate::command_parser::{ParseEvent, Parser};
use anyhow::{Context, Result};
use parking_lot::Mutex;
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use std::io::{Read, Write};
use std::sync::Arc;
use tokio::sync::mpsc;

#[derive(Debug, Clone, Deserialize)]
pub struct PtyOptions {
    pub shell: String,
    #[serde(default)]
    pub args: Vec<String>,
    pub cwd: String,
    pub cols: u16,
    pub rows: u16,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum PtyEvent {
    Output { bytes: Vec<u8> },
    CommandStart { cmd: String },
    CommandEnd { exit_code: Option<i32> },
    Exit { code: Option<i32> },
}

pub struct PtyHandle {
    master: Arc<Mutex<Box<dyn MasterPty + Send>>>,
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    // Keep the child alive on the heap so we can kill it later; currently
    // just dropped with the handle.
    _child: Arc<Mutex<Box<dyn portable_pty::Child + Send + Sync>>>,
}

impl PtyHandle {
    pub fn write(&self, bytes: &[u8]) -> Result<()> {
        let mut w = self.writer.lock();
        w.write_all(bytes).context("pty write")?;
        w.flush().context("pty flush")?;
        Ok(())
    }

    pub fn resize(&self, cols: u16, rows: u16) -> Result<()> {
        self.master
            .lock()
            .resize(PtySize {
                cols,
                rows,
                pixel_width: 0,
                pixel_height: 0,
            })
            .context("pty resize")?;
        Ok(())
    }

    pub fn kill(&self) -> Result<()> {
        self._child.lock().kill().context("pty kill")?;
        Ok(())
    }
}

pub async fn spawn_pty(
    opts: PtyOptions,
    tx: mpsc::Sender<PtyEvent>,
) -> Result<PtyHandle> {
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            cols: opts.cols,
            rows: opts.rows,
            pixel_width: 0,
            pixel_height: 0,
        })
        .context("openpty")?;

    let mut cmd = CommandBuilder::new(&opts.shell);
    for a in &opts.args {
        cmd.arg(a);
    }
    cmd.cwd(&opts.cwd);

    let child = pair.slave.spawn_command(cmd).context("spawn shell")?;

    // Drop the slave end in the parent so the PTY closes when the child exits.
    drop(pair.slave);

    let writer = pair.master.take_writer().context("take_writer")?;
    let mut reader = pair.master.try_clone_reader().context("clone_reader")?;

    let master = Arc::new(Mutex::new(pair.master));
    let writer = Arc::new(Mutex::new(writer));
    let child = Arc::new(Mutex::new(child));

    // Reader task: blocking reads in a thread, forward to tokio channel.
    let tx_read = tx.clone();
    std::thread::spawn(move || {
        let mut parser = Parser::new();
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    for ev in parser.feed(&buf[..n]) {
                        let pty_ev = match ev {
                            ParseEvent::Output(bytes) => PtyEvent::Output { bytes },
                            ParseEvent::CommandStart { cmd } => PtyEvent::CommandStart { cmd },
                            ParseEvent::CommandEnd { exit_code } => {
                                PtyEvent::CommandEnd { exit_code }
                            }
                        };
                        if tx_read.blocking_send(pty_ev).is_err() {
                            return;
                        }
                    }
                }
                Err(_) => break,
            }
        }
    });

    // Waiter task: when the child exits, emit a final Exit event.
    let tx_wait = tx.clone();
    let child_wait = child.clone();
    std::thread::spawn(move || {
        let exit = child_wait.lock().wait().ok().and_then(|s| {
            // ExitStatus doesn't have a stable code accessor across platforms;
            // the best we can do portably is success/failure.
            if s.success() {
                Some(0)
            } else {
                Some(1)
            }
        });
        let _ = tx_wait.blocking_send(PtyEvent::Exit { code: exit });
    });

    Ok(PtyHandle {
        master,
        writer,
        _child: child,
    })
}
```

- [ ] **Step 4: Register module**

Add `pub mod pty;` to `src-tauri/src/lib.rs`.

- [ ] **Step 5: Enable async tests**

Add to `src-tauri/Cargo.toml` `[dev-dependencies]`:

```toml
tokio = { version = "1", features = ["rt-multi-thread", "macros", "time", "sync"] }
```

(tokio is already in `[dependencies]` but `[dev-dependencies]` is where the test's `#[tokio::test]` proc macro looks up features like `macros`. It's fine to have it in both.)

- [ ] **Step 6: Run test — MUST pass**

```bash
cargo test --test pty_test -- --nocapture
```

Expected: 2 tests pass. The `echo hello` test spawns a real shell — may take ~200ms.

- [ ] **Step 7: Full suite, check regressions**

```bash
cargo test
```

Expected: 10 total tests pass (3 Phase 0 + 5 parser + 2 pty).

- [ ] **Step 8: Commit**

```bash
cd "/Users/shaunwhi/CCIE Terminal"
git add -A
git commit -m "feat(core): PTY session manager using portable-pty + tokio channels"
```

---

## Task 4: Session store (TDD)

SQLite-backed CRUD for tabs and command_blocks. Thin wrapper; no business logic.

**Files:**
- Create: `src-tauri/src/session.rs`
- Create: `src-tauri/tests/session_test.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Write the failing test**

Create `src-tauri/tests/session_test.rs`:

```rust
use ccie_terminal_lib::{db, session};
use tempfile::TempDir;

fn open_test_db() -> (TempDir, rusqlite::Connection) {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("t.db");
    let conn = db::open_and_migrate(&path).unwrap();
    (dir, conn)
}

#[test]
fn create_list_close_tabs() {
    let (_dir, conn) = open_test_db();

    let t = session::create_tab(&conn, "zsh", "/bin/zsh", "/tmp").unwrap();
    assert_eq!(t.title, "zsh");

    let open = session::list_open_tabs(&conn).unwrap();
    assert_eq!(open.len(), 1);

    session::close_tab(&conn, &t.id).unwrap();
    let open = session::list_open_tabs(&conn).unwrap();
    assert_eq!(open.len(), 0);
}

#[test]
fn append_and_read_scrollback_chunks() {
    let (_dir, conn) = open_test_db();
    let t = session::create_tab(&conn, "zsh", "/bin/zsh", "/tmp").unwrap();

    session::append_scrollback(&conn, &t.id, b"first\n").unwrap();
    session::append_scrollback(&conn, &t.id, b"second\n").unwrap();

    let all = session::read_scrollback(&conn, &t.id).unwrap();
    assert_eq!(all, b"first\nsecond\n");
}

#[test]
fn record_command_block_lifecycle() {
    let (_dir, conn) = open_test_db();
    let t = session::create_tab(&conn, "zsh", "/bin/zsh", "/tmp").unwrap();

    let block_id = session::start_command_block(&conn, &t.id, "ls -la").unwrap();
    session::append_block_output(&conn, &block_id, b"total 0\n").unwrap();
    session::end_command_block(&conn, &block_id, Some(0)).unwrap();

    let blocks = session::list_blocks(&conn, &t.id).unwrap();
    assert_eq!(blocks.len(), 1);
    assert_eq!(blocks[0].cmd, "ls -la");
    assert_eq!(blocks[0].exit_code, Some(0));
    assert_eq!(blocks[0].output, b"total 0\n");
}
```

- [ ] **Step 2: Run — MUST fail**

```bash
cargo test --test session_test
```

- [ ] **Step 3: Implement `src-tauri/src/session.rs`**

```rust
//! SQLite-backed store for tabs, command blocks, and scrollback.
//! Pure data layer — no PTY, no Tauri. Everything is synchronous rusqlite.

use anyhow::{Context, Result};
use rusqlite::{params, Connection};
use serde::Serialize;
use uuid::Uuid;

#[derive(Debug, Clone, Serialize)]
pub struct Tab {
    pub id: String,
    pub title: String,
    pub shell_cmd: String,
    pub cwd: String,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct CommandBlockRow {
    pub id: String,
    pub tab_id: String,
    pub cmd: String,
    pub exit_code: Option<i32>,
    pub started_at: i64,
    pub ended_at: Option<i64>,
    pub output: Vec<u8>,
}

pub fn create_tab(conn: &Connection, title: &str, shell_cmd: &str, cwd: &str) -> Result<Tab> {
    let id = Uuid::new_v4().to_string();
    conn.execute(
        "INSERT INTO tabs (id, title, shell_cmd, cwd) VALUES (?, ?, ?, ?)",
        params![id, title, shell_cmd, cwd],
    )
    .context("insert tab")?;
    let created_at: i64 = conn
        .query_row(
            "SELECT created_at FROM tabs WHERE id = ?",
            params![id],
            |r| r.get(0),
        )
        .context("read created_at")?;
    Ok(Tab {
        id,
        title: title.into(),
        shell_cmd: shell_cmd.into(),
        cwd: cwd.into(),
        created_at,
    })
}

pub fn list_open_tabs(conn: &Connection) -> Result<Vec<Tab>> {
    let mut stmt = conn
        .prepare(
            "SELECT id, title, shell_cmd, cwd, created_at FROM tabs WHERE closed_at IS NULL ORDER BY created_at",
        )
        .context("prepare list_open_tabs")?;
    let rows = stmt
        .query_map([], |r| {
            Ok(Tab {
                id: r.get(0)?,
                title: r.get(1)?,
                shell_cmd: r.get(2)?,
                cwd: r.get(3)?,
                created_at: r.get(4)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

pub fn close_tab(conn: &Connection, id: &str) -> Result<()> {
    conn.execute(
        "UPDATE tabs SET closed_at = strftime('%s','now') WHERE id = ?",
        params![id],
    )
    .context("close tab")?;
    Ok(())
}

/// Append bytes to a tab's scrollback ring buffer.
/// TODO(phase-6): enforce max bytes per tab, drop oldest chunks when exceeded.
pub fn append_scrollback(conn: &Connection, tab_id: &str, chunk: &[u8]) -> Result<()> {
    let next_seq: i64 = conn
        .query_row(
            "SELECT COALESCE(MAX(seq), -1) + 1 FROM scrollback WHERE tab_id = ?",
            params![tab_id],
            |r| r.get(0),
        )
        .context("next seq")?;
    conn.execute(
        "INSERT INTO scrollback (tab_id, seq, chunk) VALUES (?, ?, ?)",
        params![tab_id, next_seq, chunk],
    )
    .context("insert scrollback")?;
    Ok(())
}

pub fn read_scrollback(conn: &Connection, tab_id: &str) -> Result<Vec<u8>> {
    let mut stmt = conn.prepare(
        "SELECT chunk FROM scrollback WHERE tab_id = ? ORDER BY seq",
    )?;
    let mut out = Vec::new();
    let mut rows = stmt.query(params![tab_id])?;
    while let Some(r) = rows.next()? {
        let chunk: Vec<u8> = r.get(0)?;
        out.extend_from_slice(&chunk);
    }
    Ok(out)
}

pub fn start_command_block(conn: &Connection, tab_id: &str, cmd: &str) -> Result<String> {
    let id = Uuid::new_v4().to_string();
    conn.execute(
        "INSERT INTO command_blocks (id, tab_id, cmd, output, started_at) VALUES (?, ?, ?, X'', strftime('%s','now'))",
        params![id, tab_id, cmd],
    )
    .context("insert command_block")?;
    Ok(id)
}

pub fn append_block_output(conn: &Connection, block_id: &str, chunk: &[u8]) -> Result<()> {
    // SQLite has no native "append to blob"; we read-modify-write. That's fine for
    // Phase 1 since blocks are typically small (a command's output). Phase 6 can
    // optimise if needed.
    let mut current: Vec<u8> = conn
        .query_row(
            "SELECT output FROM command_blocks WHERE id = ?",
            params![block_id],
            |r| r.get(0),
        )
        .context("read existing block output")?;
    current.extend_from_slice(chunk);
    conn.execute(
        "UPDATE command_blocks SET output = ? WHERE id = ?",
        params![current, block_id],
    )
    .context("update block output")?;
    Ok(())
}

pub fn end_command_block(conn: &Connection, block_id: &str, exit_code: Option<i32>) -> Result<()> {
    conn.execute(
        "UPDATE command_blocks SET exit_code = ?, ended_at = strftime('%s','now') WHERE id = ?",
        params![exit_code, block_id],
    )
    .context("end command_block")?;
    Ok(())
}

pub fn list_blocks(conn: &Connection, tab_id: &str) -> Result<Vec<CommandBlockRow>> {
    let mut stmt = conn.prepare(
        "SELECT id, tab_id, cmd, exit_code, started_at, ended_at, output FROM command_blocks WHERE tab_id = ? ORDER BY started_at",
    )?;
    let rows = stmt
        .query_map(params![tab_id], |r| {
            Ok(CommandBlockRow {
                id: r.get(0)?,
                tab_id: r.get(1)?,
                cmd: r.get(2)?,
                exit_code: r.get(3)?,
                started_at: r.get(4)?,
                ended_at: r.get(5)?,
                output: r.get(6)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}
```

- [ ] **Step 4: Register module**

Add `pub mod session;` to `src-tauri/src/lib.rs`.

- [ ] **Step 5: Run test — MUST pass**

```bash
cargo test --test session_test
```

Expected: 3 tests pass.

- [ ] **Step 6: Full suite**

```bash
cargo test
```

Expected: 13 total (3 Phase 0 + 5 parser + 2 pty + 3 session).

- [ ] **Step 7: Commit**

```bash
cd "/Users/shaunwhi/CCIE Terminal"
git add -A
git commit -m "feat(core): SQLite session store for tabs, blocks, scrollback"
```

---

## Task 5: Tauri commands + PTY/session state

Glue the pieces together so the frontend can drive PTYs via `invoke`.

**Files:**
- Modify: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/lib.rs`
- Create: `src-tauri/src/shell_integration.rs`
- Create: `shell-integration/ccie-terminal.zsh`
- Create: `shell-integration/ccie-terminal.bash`

**App state design:** We need a `Mutex<HashMap<String, PtyHandle>>` and a single SQLite `Connection`. Store both in a `tauri::State` struct. PTY events stream to the frontend via `tauri::Channel<PtyEvent>` (one per spawn call — returned to the frontend, frontend passes it to Tauri's `invoke` arg).

- [ ] **Step 1: Create shell-integration scripts**

`shell-integration/ccie-terminal.zsh`:

```zsh
# CCIE Terminal shell integration for zsh (OSC 133).
# Sourced from your ~/.zshrc when CCIE_TERMINAL=1.

if [[ -z "$CCIE_TERMINAL" ]]; then
  return
fi

__ccie_prompt_start() { printf '\e]133;A\a'; }
__ccie_prompt_end()   { printf '\e]133;B\a'; }
__ccie_command_start() { printf '\e]133;C\a'; }
__ccie_command_end()   { printf '\e]133;D;%s\a' "${1:-0}"; }

precmd_functions+=(__ccie_prompt_start)
preexec_functions+=(__ccie_command_start)

# Zsh emits C before the command runs; we wrap the prompt with A..B and emit D
# via a trap on the next precmd based on $?.
__ccie_last_exit=0
__ccie_record_exit() { __ccie_last_exit=$?; }
precmd_functions=(__ccie_record_exit __ccie_prompt_start $precmd_functions)

# Emit B right before the user starts typing.
PROMPT="%{$(__ccie_prompt_end)%}$PROMPT"

# On each prompt redraw, emit D for the previous command.
__ccie_emit_d() { __ccie_command_end "$__ccie_last_exit"; }
precmd_functions=(__ccie_emit_d $precmd_functions)
```

`shell-integration/ccie-terminal.bash`:

```bash
# CCIE Terminal shell integration for bash (OSC 133).
# Sourced from your ~/.bashrc when CCIE_TERMINAL=1.

[[ -z "$CCIE_TERMINAL" ]] && return

__ccie_prompt_start()  { printf '\e]133;A\a'; }
__ccie_prompt_end()    { printf '\e]133;B\a'; }
__ccie_command_start() { printf '\e]133;C\a'; }
__ccie_command_end()   { printf '\e]133;D;%s\a' "${1:-0}"; }

PS1="\[$(__ccie_prompt_start)\]$PS1\[$(__ccie_prompt_end)\]"

# DEBUG trap fires right before command execution.
trap '__ccie_command_start' DEBUG
PROMPT_COMMAND='__ccie_command_end $?; '"$PROMPT_COMMAND"
```

- [ ] **Step 2: Create `src-tauri/src/shell_integration.rs`**

```rust
//! Install shell-integration scripts to the user's config dir on first launch
//! and expose the path so we can set CCIE_TERMINAL=1 + source it in new PTYs.

use anyhow::{Context, Result};
use std::path::PathBuf;

const ZSH: &str = include_str!("../../shell-integration/ccie-terminal.zsh");
const BASH: &str = include_str!("../../shell-integration/ccie-terminal.bash");

pub struct IntegrationPaths {
    pub zsh: PathBuf,
    pub bash: PathBuf,
}

pub fn install() -> Result<IntegrationPaths> {
    let dir = dirs::config_dir()
        .context("config_dir")?
        .join("ccie-terminal")
        .join("shell-integration");
    std::fs::create_dir_all(&dir).context("create shell-integration dir")?;
    let zsh = dir.join("ccie-terminal.zsh");
    let bash = dir.join("ccie-terminal.bash");
    std::fs::write(&zsh, ZSH).context("write zsh integration")?;
    std::fs::write(&bash, BASH).context("write bash integration")?;
    Ok(IntegrationPaths { zsh, bash })
}
```

- [ ] **Step 3: Extend `src-tauri/src/commands.rs`**

Append (keeping ping/ping_sidecar as-is):

```rust
use crate::pty::{spawn_pty, PtyEvent, PtyHandle, PtyOptions};
use crate::session;
use crate::shell_integration;
use parking_lot::Mutex;
use std::collections::HashMap;
use std::sync::Arc;
use tauri::{ipc::Channel, State};
use tokio::sync::mpsc;

pub struct AppState {
    pub ptys: Mutex<HashMap<String, PtyHandle>>,
    pub db: Arc<Mutex<rusqlite::Connection>>,
}

impl AppState {
    pub fn new(db: rusqlite::Connection) -> Self {
        Self {
            ptys: Mutex::new(HashMap::new()),
            db: Arc::new(Mutex::new(db)),
        }
    }
}

#[tauri::command]
pub async fn pty_spawn(
    state: State<'_, AppState>,
    shell: String,
    args: Vec<String>,
    cwd: String,
    cols: u16,
    rows: u16,
    on_event: Channel<PtyEvent>,
) -> Result<String, String> {
    // Persist tab metadata.
    let tab = {
        let db = state.db.lock();
        session::create_tab(&db, &shell, &shell, &cwd).map_err(|e| e.to_string())?
    };

    // mpsc → Channel forwarder.
    let (tx, mut rx) = mpsc::channel::<PtyEvent>(256);
    let tab_id = tab.id.clone();
    let db = state.db.clone();

    let handle = spawn_pty(
        PtyOptions { shell, args, cwd, cols, rows },
        tx,
    )
    .await
    .map_err(|e| e.to_string())?;

    state.ptys.lock().insert(tab.id.clone(), handle);

    let emit_tab_id = tab_id.clone();
    tokio::spawn(async move {
        let mut current_block: Option<String> = None;
        while let Some(ev) = rx.recv().await {
            // Persist side-effects on certain events.
            {
                let db = db.lock();
                match &ev {
                    PtyEvent::Output { bytes } => {
                        let _ = session::append_scrollback(&db, &emit_tab_id, bytes);
                        if let Some(bid) = &current_block {
                            let _ = session::append_block_output(&db, bid, bytes);
                        }
                    }
                    PtyEvent::CommandStart { cmd } => {
                        if let Ok(bid) = session::start_command_block(&db, &emit_tab_id, cmd) {
                            current_block = Some(bid);
                        }
                    }
                    PtyEvent::CommandEnd { exit_code } => {
                        if let Some(bid) = current_block.take() {
                            let _ = session::end_command_block(&db, &bid, *exit_code);
                        }
                    }
                    PtyEvent::Exit { .. } => {}
                }
            }
            if on_event.send(ev).is_err() {
                break;
            }
        }
    });

    Ok(tab_id)
}

#[tauri::command]
pub fn pty_write(
    state: State<'_, AppState>,
    tab_id: String,
    data: Vec<u8>,
) -> Result<(), String> {
    let ptys = state.ptys.lock();
    let h = ptys.get(&tab_id).ok_or("tab not found")?;
    h.write(&data).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pty_resize(
    state: State<'_, AppState>,
    tab_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let ptys = state.ptys.lock();
    let h = ptys.get(&tab_id).ok_or("tab not found")?;
    h.resize(cols, rows).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pty_kill(state: State<'_, AppState>, tab_id: String) -> Result<(), String> {
    let h = state.ptys.lock().remove(&tab_id);
    if let Some(h) = h {
        let _ = h.kill();
    }
    let db = state.db.lock();
    session::close_tab(&db, &tab_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn list_tabs(state: State<'_, AppState>) -> Result<Vec<session::Tab>, String> {
    let db = state.db.lock();
    session::list_open_tabs(&db).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn tab_scrollback(state: State<'_, AppState>, tab_id: String) -> Result<Vec<u8>, String> {
    let db = state.db.lock();
    session::read_scrollback(&db, &tab_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn install_shell_integration() -> Result<String, String> {
    let p = shell_integration::install().map_err(|e| e.to_string())?;
    Ok(p.zsh.to_string_lossy().into_owned())
}
```

- [ ] **Step 4: Update `src-tauri/src/lib.rs`**

```rust
pub mod bridge;
pub mod command_parser;
pub mod commands;
pub mod db;
pub mod pty;
pub mod session;
pub mod shell_integration;

use commands::AppState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let db = {
        let path = db::default_db_path().expect("default_db_path");
        db::open_and_migrate(&path).expect("open_and_migrate")
    };
    let state = AppState::new(db);

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(state)
        .invoke_handler(tauri::generate_handler![
            commands::ping_cmd,
            commands::ping_sidecar,
            commands::pty_spawn,
            commands::pty_write,
            commands::pty_resize,
            commands::pty_kill,
            commands::list_tabs,
            commands::tab_scrollback,
            commands::install_shell_integration
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

- [ ] **Step 5: Initialize tokio runtime for Tauri async commands**

Modify `src-tauri/src/main.rs`:

```rust
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    ccie_terminal_lib::run();
}
```

(Nothing to change; Tauri v2 creates its own runtime for async commands. Left intentionally untouched.)

- [ ] **Step 6: Verify build**

```bash
cd "/Users/shaunwhi/CCIE Terminal/src-tauri"
source "$HOME/.cargo/env"
cargo build
cargo test
```

Expected: build succeeds, 13 tests pass (we didn't add new unit tests for the Tauri glue layer — it's covered by the frontend integration).

- [ ] **Step 7: Commit**

```bash
cd "/Users/shaunwhi/CCIE Terminal"
git add -A
git commit -m "feat(core): Tauri commands for pty spawn/write/resize/kill and shell integration install"
```

---

## Task 6: Frontend — xterm.js + tabs + command-block overlay

**Files:**
- Modify: `package.json` (+ `@xterm/xterm`, `@xterm/addon-fit`, `@xterm/addon-web-links`, `zustand`)
- Create: `src/state/tabsStore.ts`
- Create: `src/lib/types.ts`
- Modify: `src/lib/tauri.ts` (add PTY wrappers, keep Phase 0 pings)
- Create: `src/hooks/usePty.ts`
- Create: `src/components/TabBar.tsx`
- Create: `src/components/Terminal.tsx`
- Create: `src/components/CommandBlock.tsx`
- Modify: `src/App.tsx`
- Modify: `src/App.css`

- [ ] **Step 1: Install frontend deps**

```bash
cd "/Users/shaunwhi/CCIE Terminal"
bun add @xterm/xterm @xterm/addon-fit @xterm/addon-web-links zustand
```

- [ ] **Step 2: Create `src/lib/types.ts`**

```ts
export type Tab = {
  id: string;
  title: string;
  shell_cmd: string;
  cwd: string;
  created_at: number;
};

export type PtyEvent =
  | { type: "output"; bytes: number[] }
  | { type: "command_start"; cmd: string }
  | { type: "command_end"; exit_code: number | null }
  | { type: "exit"; code: number | null };

export type CommandBlockState = {
  id: string;
  cmd: string;
  started_at: number;
  ended_at?: number;
  exit_code?: number | null;
};
```

- [ ] **Step 3: Extend `src/lib/tauri.ts`**

Keep the existing `pingCore` / `pingSidecar`. Add:

```ts
import { Channel, invoke } from "@tauri-apps/api/core";
import type { PtyEvent, Tab } from "./types";

export async function ptySpawn(opts: {
  shell: string;
  args: string[];
  cwd: string;
  cols: number;
  rows: number;
  onEvent: (e: PtyEvent) => void;
}): Promise<string> {
  const channel = new Channel<PtyEvent>();
  channel.onmessage = opts.onEvent;
  return invoke<string>("pty_spawn", {
    shell: opts.shell,
    args: opts.args,
    cwd: opts.cwd,
    cols: opts.cols,
    rows: opts.rows,
    onEvent: channel,
  });
}

export const ptyWrite = (tabId: string, data: Uint8Array) =>
  invoke<void>("pty_write", { tabId, data: Array.from(data) });

export const ptyResize = (tabId: string, cols: number, rows: number) =>
  invoke<void>("pty_resize", { tabId, cols, rows });

export const ptyKill = (tabId: string) =>
  invoke<void>("pty_kill", { tabId });

export const listTabs = () => invoke<Tab[]>("list_tabs");

export const tabScrollback = (tabId: string) =>
  invoke<number[]>("tab_scrollback", { tabId });

export const installShellIntegration = () =>
  invoke<string>("install_shell_integration");
```

- [ ] **Step 4: Create `src/state/tabsStore.ts`**

```ts
import { create } from "zustand";
import type { Tab, CommandBlockState } from "../lib/types";

type Store = {
  tabs: Tab[];
  activeTabId: string | null;
  blocks: Record<string, CommandBlockState[]>;
  setTabs: (t: Tab[]) => void;
  addTab: (t: Tab) => void;
  removeTab: (id: string) => void;
  setActive: (id: string | null) => void;
  startBlock: (tabId: string, b: CommandBlockState) => void;
  endBlock: (tabId: string, exit: number | null) => void;
};

export const useTabs = create<Store>((set) => ({
  tabs: [],
  activeTabId: null,
  blocks: {},
  setTabs: (tabs) => set({ tabs, activeTabId: tabs[0]?.id ?? null }),
  addTab: (t) =>
    set((s) => ({ tabs: [...s.tabs, t], activeTabId: t.id })),
  removeTab: (id) =>
    set((s) => {
      const tabs = s.tabs.filter((t) => t.id !== id);
      return { tabs, activeTabId: tabs[0]?.id ?? null };
    }),
  setActive: (id) => set({ activeTabId: id }),
  startBlock: (tabId, b) =>
    set((s) => ({
      blocks: { ...s.blocks, [tabId]: [...(s.blocks[tabId] ?? []), b] },
    })),
  endBlock: (tabId, exit) =>
    set((s) => {
      const arr = [...(s.blocks[tabId] ?? [])];
      const last = arr[arr.length - 1];
      if (last && last.ended_at === undefined) {
        arr[arr.length - 1] = {
          ...last,
          ended_at: Math.floor(Date.now() / 1000),
          exit_code: exit,
        };
      }
      return { blocks: { ...s.blocks, [tabId]: arr } };
    }),
}));
```

- [ ] **Step 5: Create `src/hooks/usePty.ts`**

```ts
import { useEffect, useRef } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { ptySpawn, ptyWrite, ptyResize } from "../lib/tauri";
import { useTabs } from "../state/tabsStore";

import "@xterm/xterm/css/xterm.css";

export type PtyHandle = {
  term: XTerm;
  fit: () => void;
  dispose: () => void;
};

/**
 * Attaches an xterm instance to a DOM element, spawns a PTY in Rust, and
 * bidirectionally wires them. Returns a handle the caller can use to `fit()`
 * on container resize.
 */
export function usePty(
  container: HTMLDivElement | null,
  shell: string,
  cwd: string,
): PtyHandle | null {
  const handleRef = useRef<PtyHandle | null>(null);
  const { addTab, startBlock, endBlock, removeTab } = useTabs();

  useEffect(() => {
    if (!container || handleRef.current) return;
    const term = new XTerm({
      convertEol: true,
      fontFamily: 'Menlo, "SF Mono", Monaco, monospace',
      fontSize: 13,
      theme: {
        background: "#0f1114",
        foreground: "#e6e1cf",
        cursor: "#5ccfe6",
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    term.open(container);
    fit.fit();

    let tabId: string | null = null;
    let disposed = false;

    const onEvent = (e: import("../lib/types").PtyEvent) => {
      if (disposed) return;
      switch (e.type) {
        case "output":
          term.write(new Uint8Array(e.bytes));
          break;
        case "command_start":
          if (tabId) {
            startBlock(tabId, {
              id: crypto.randomUUID(),
              cmd: e.cmd,
              started_at: Math.floor(Date.now() / 1000),
            });
          }
          break;
        case "command_end":
          if (tabId) endBlock(tabId, e.exit_code);
          break;
        case "exit":
          if (tabId) removeTab(tabId);
          break;
      }
    };

    ptySpawn({
      shell,
      args: [],
      cwd,
      cols: term.cols,
      rows: term.rows,
      onEvent,
    }).then((id) => {
      tabId = id;
      addTab({ id, title: shell, shell_cmd: shell, cwd, created_at: Date.now() / 1000 });

      const disposable = term.onData((data) => {
        ptyWrite(id, new TextEncoder().encode(data)).catch(console.error);
      });
      const resizeDisp = term.onResize(({ cols, rows }) => {
        ptyResize(id, cols, rows).catch(console.error);
      });

      handleRef.current = {
        term,
        fit: () => fit.fit(),
        dispose: () => {
          disposed = true;
          disposable.dispose();
          resizeDisp.dispose();
          term.dispose();
        },
      };
    });

    return () => {
      handleRef.current?.dispose();
      handleRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [container, shell, cwd]);

  return handleRef.current;
}
```

- [ ] **Step 6: Create `src/components/Terminal.tsx`**

```tsx
import { useEffect, useRef } from "react";
import { usePty } from "../hooks/usePty";

export function Terminal({ shell, cwd }: { shell: string; cwd: string }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const handle = usePty(ref.current, shell, cwd);

  useEffect(() => {
    if (!handle) return;
    const ro = new ResizeObserver(() => handle.fit());
    if (ref.current) ro.observe(ref.current);
    return () => ro.disconnect();
  }, [handle]);

  return <div ref={ref} className="terminal" />;
}
```

- [ ] **Step 7: Create `src/components/CommandBlock.tsx`**

```tsx
import type { CommandBlockState } from "../lib/types";

export function CommandBlock({ block }: { block: CommandBlockState }) {
  const status =
    block.exit_code === undefined
      ? "running"
      : block.exit_code === 0
      ? "ok"
      : "fail";
  return (
    <div className={`block block-${status}`}>
      <span className="block-cmd">❯ {block.cmd}</span>
      {block.exit_code !== undefined && block.exit_code !== 0 && (
        <span className="block-exit">exit {block.exit_code}</span>
      )}
    </div>
  );
}
```

- [ ] **Step 8: Create `src/components/TabBar.tsx`**

```tsx
import { useTabs } from "../state/tabsStore";
import { ptyKill } from "../lib/tauri";

export function TabBar({ onNew }: { onNew: () => void }) {
  const { tabs, activeTabId, setActive, removeTab } = useTabs();
  return (
    <div className="tabbar">
      {tabs.map((t) => (
        <div
          key={t.id}
          className={`tab ${t.id === activeTabId ? "tab-active" : ""}`}
          onClick={() => setActive(t.id)}
        >
          <span>{t.title}</span>
          <button
            className="tab-close"
            onClick={async (e) => {
              e.stopPropagation();
              await ptyKill(t.id).catch(() => {});
              removeTab(t.id);
            }}
          >
            ×
          </button>
        </div>
      ))}
      <button className="tab-new" onClick={onNew}>+</button>
    </div>
  );
}
```

- [ ] **Step 9: Rewrite `src/App.tsx`**

```tsx
import { useEffect, useState } from "react";
import { TabBar } from "./components/TabBar";
import { Terminal } from "./components/Terminal";
import { CommandBlock } from "./components/CommandBlock";
import { useTabs } from "./state/tabsStore";
import { installShellIntegration } from "./lib/tauri";
import "./App.css";

function defaultShell() {
  // Best-effort default; the Rust layer will use env SHELL when invoked.
  // For Phase 1 we just hardcode sane fallbacks.
  if (navigator.platform.toLowerCase().includes("win")) return "powershell.exe";
  return "/bin/zsh";
}

export default function App() {
  const { tabs, activeTabId } = useTabs();
  const [shellPath, setShellPath] = useState<string>(defaultShell());

  useEffect(() => {
    installShellIntegration().catch(console.error);
  }, []);

  // One terminal per tab; mount only active to keep resource use sane.
  const active = tabs.find((t) => t.id === activeTabId);
  const { blocks } = useTabs();
  const activeBlocks = active ? blocks[active.id] ?? [] : [];

  return (
    <div className="shell">
      <TabBar onNew={() => setShellPath(defaultShell())} />
      <div className="workspace">
        <div className="term-col">
          {active ? (
            <Terminal key={active.id} shell={active.shell_cmd} cwd={active.cwd} />
          ) : (
            <button
              className="empty-new"
              onClick={() => {
                // Trigger a re-render; default shell path stays.
                setShellPath(defaultShell());
              }}
            >
              Open a tab
            </button>
          )}
        </div>
        <aside className="blocks-col">
          <h4>Command blocks</h4>
          {activeBlocks.map((b) => (
            <CommandBlock key={b.id} block={b} />
          ))}
          {activeBlocks.length === 0 && (
            <p className="muted">Run a command to see blocks here.</p>
          )}
        </aside>
      </div>
    </div>
  );
}
```

Note: the empty-state "Open a tab" button doesn't actually spawn a tab in this minimal version. Tabs auto-spawn when the `<Terminal>` mounts. For Phase 1 we'll auto-spawn one on app start by adjusting the empty-state to mount a Terminal directly. See next step.

- [ ] **Step 10: Fix empty-state — always show one terminal by default**

Replace the `active ? ... : ...` block in `App.tsx` with:

```tsx
{active ? (
  <Terminal key={active.id} shell={active.shell_cmd} cwd={active.cwd} />
) : (
  // On first launch, spawn an initial terminal.
  <Terminal
    key="initial"
    shell={shellPath}
    cwd={"/"}
  />
)}
```

- [ ] **Step 11: Update `src/App.css`**

Overwrite:

```css
:root {
  color-scheme: dark;
  font-family: -apple-system, system-ui, sans-serif;
}

html, body, #root {
  margin: 0;
  height: 100%;
  background: #0f1114;
  color: #e6e1cf;
}

.shell {
  display: flex;
  flex-direction: column;
  height: 100vh;
}

.tabbar {
  display: flex;
  gap: 4px;
  padding: 6px 10px 0;
  background: #0a0c0f;
  border-bottom: 1px solid #262a33;
}

.tab {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 12px;
  background: #1a1d23;
  border-radius: 6px 6px 0 0;
  cursor: pointer;
  color: #8a8d94;
}

.tab-active {
  background: #262a33;
  color: #e6e1cf;
}

.tab-close, .tab-new {
  background: transparent;
  border: none;
  color: inherit;
  cursor: pointer;
  font-size: 14px;
}

.workspace {
  display: grid;
  grid-template-columns: 1fr 280px;
  flex: 1;
  overflow: hidden;
}

.term-col {
  padding: 10px;
  min-width: 0;
}

.terminal {
  width: 100%;
  height: 100%;
}

.blocks-col {
  border-left: 1px solid #262a33;
  padding: 12px;
  overflow-y: auto;
  background: #0b0d10;
}

.blocks-col h4 {
  margin: 0 0 10px;
  color: #6c7380;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
}

.block {
  padding: 8px 10px;
  margin-bottom: 6px;
  border-radius: 4px;
  background: #161a20;
  border-left: 3px solid #3e4451;
  font-family: Menlo, monospace;
  font-size: 12px;
}

.block-running { border-left-color: #ffb454; }
.block-ok { border-left-color: #6bd968; }
.block-fail { border-left-color: #f28779; }

.block-cmd { color: #5ccfe6; }
.block-exit { color: #f28779; margin-left: 8px; font-size: 11px; }

.muted { color: #6c7380; font-size: 12px; }
```

- [ ] **Step 12: Verify frontend build**

```bash
cd "/Users/shaunwhi/CCIE Terminal"
bun run build
```

Expected: TSC passes, Vite bundles.

- [ ] **Step 13: Commit**

```bash
git add -A
git commit -m "feat(ui): xterm.js multi-tab terminal with command-block overlay"
```

---

## Task 7: End-to-end smoke test & polish

- [ ] **Step 1: Run full automated suite**

```bash
cd "/Users/shaunwhi/CCIE Terminal/src-tauri"
source "$HOME/.cargo/env"
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test
```

Expected: fmt ok, clippy clean, 13 tests pass.

```bash
cd "/Users/shaunwhi/CCIE Terminal/sidecar"
source .venv/bin/activate
pytest
```

Expected: 4 tests pass.

```bash
cd "/Users/shaunwhi/CCIE Terminal"
bun run build
```

Expected: success.

- [ ] **Step 2: Launch dev app manually (human verification required)**

```bash
cd "/Users/shaunwhi/CCIE Terminal"
CCIE_REPO_ROOT="$PWD" bun tauri dev
```

Check:
- Window opens showing a working shell prompt in the left pane.
- Right pane shows "Command blocks" empty state.
- Type `ls` + Enter — verify output streams in; after the plan prints, a block appears in the right pane with `❯ ls` and a green left-border when exit = 0.
- Type a failing command (e.g. `false`) — the block appears with a red border and `exit 1`.
- Click + in tab bar — new tab opens with its own shell; its blocks are scoped to that tab.
- Close a tab — process ends.
- Quit and relaunch (`bun tauri dev` again) — persisted tabs from `list_tabs` should appear (note: full restore requires loading scrollback into xterm via `tab_scrollback`; this is done on tab-switch for V1).

Known Phase 1 limitations to verify DON'T crash the app:
- SSHing into a device without shell integration → no blocks appear, but the terminal still streams text. Acceptable.
- Very long scrollback → no ring-buffer cap yet; `TODO(phase-6)` comment in `session.rs`.

- [ ] **Step 3: Tag Phase 1**

```bash
cd "/Users/shaunwhi/CCIE Terminal"
git tag -a phase-1 -m "Phase 1: multi-tab terminal with command blocks"
```

- [ ] **Step 4: Done**

Phase 2 (Python sidecar bridge + side-panel AI chat + providers + `.env`) is unblocked.

---

## Phase 1 definition of done

- `bun tauri dev` opens an app with a working multi-tab local shell terminal.
- Running a command with OSC 133 shell integration active produces a command block in the right pane with cmd + exit code + status color.
- New tab → new shell process; closing tab → process ends.
- App restart → open tabs list is restored from SQLite (scrollback shown on tab click).
- `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`, and `cargo test` all green.
- `sidecar/pytest` still green (no regressions).
- `bun run build` succeeds.

## Known debt carried into Phase 2+

- **Prompt-regex fallback for SSH/Cisco** (TODO in `command_parser.rs`).
- **Non-133 OSC passthrough** to xterm.js (TODO in `command_parser.rs::handle_osc`).
- **Scrollback ring-buffer cap** (TODO in `session.rs::append_scrollback`).
- **Scrollback replay on app launch** — tabs are restored but their scrollback isn't auto-loaded into xterm until the user clicks the tab once.
- **Block output append is read-modify-write** — fine for typical output sizes, can be optimised.

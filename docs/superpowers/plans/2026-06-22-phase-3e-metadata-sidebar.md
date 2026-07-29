# Phase 3E: Metadata Sidebar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A floating, draggable HUD card showing live context (git branch/status, listening ports, SSH/device context) for the currently-focused terminal pane, gathered lazily via one aggregate Tauri command.

**Architecture:** A new `src-tauri/src/metadata/` module exposes three independent, partial-failure-tolerant gatherers (git via `git2`, listening ports via `lsof`, SSH context chain-first/process-fallback). One aggregate `get_pane_metadata` command runs them concurrently and returns `PaneMetadata`. The frontend renders a floating HUD card (`MetadataCard.tsx`) driven by a Zustand `metadataStore`, refreshed lazily on open + focus-change + manual button (no timer).

**Tech Stack:** Rust (Tauri 2.10.3, `git2` already a dep, `tokio`, `serde`), `lsof`/`pgrep` (macOS CLIs), React + Zustand + vitest, TypeScript.

## Global Constraints

- **No new Rust or npm dependencies.** `git2`, `tokio`, `serde` are already present.
- **macOS-first.** Port + process detection uses `lsof`/`pgrep`; non-macOS degrades to empty/None, never errors.
- **No new SQLite migration.** All state is ephemeral/in-memory. Next free migration remains V0055.
- **Partial-failure tolerance.** `get_pane_metadata` returns `Err` ONLY on a malformed request (unknown `terminal_id`). Each gatherer catches its own errors and degrades to `None`/empty, logging a warning.
- **`ptys` HashMap is keyed by `terminal_id`** (`src-tauri/src/commands/mod.rs:526`), NOT `pane_id`.
- **`PtyHandle` does not yet capture the pid** — Task 1 adds it (`portable_pty` `child.process_id()` at `src-tauri/src/pty.rs:249`).
- **Keyboard shortcut: ⌘⇧L** (verified free). Taken `⌘⇧`: B,C,D,E,F,G,I,J,K,M,N,P,R,S,T,V,W.
- **camelCase at the IPC boundary** (Tauri auto-converts snake_case params; structs use `#[serde(rename_all = "camelCase")]`).
- **TDD, frequent commits, DRY, YAGNI.**

---

## File Structure

**Backend (Rust):**
- Modify: `src-tauri/src/pty.rs` — capture pid into `PtyHandle`, add `pid()` accessor.
- Create: `src-tauri/src/metadata/mod.rs` — module root, `PaneMetadata` + sub-struct types, `get_metadata()` orchestrator.
- Create: `src-tauri/src/metadata/proc.rs` — `child_pids()` process-tree helper (shared).
- Create: `src-tauri/src/metadata/git.rs` — `gather_git(cwd) -> Option<GitInfo>`.
- Create: `src-tauri/src/metadata/ports.rs` — `gather_ports(pid) -> Vec<PortInfo>`.
- Create: `src-tauri/src/metadata/ssh.rs` — `gather_ssh(...) -> Option<SshInfo>` + argv parser.
- Create: `src-tauri/src/commands/metadata.rs` — `get_pane_metadata` Tauri command.
- Modify: `src-tauri/src/lib.rs` — `pub mod metadata;`, register command, add menu item + accelerator.
- Modify: `src-tauri/src/commands/mod.rs` — `pub mod metadata;` (commands submodule).

**Frontend (React/TS):**
- Create: `src/lib/metadata.ts` — types + `getPaneMetadata` invoke wrapper.
- Create: `src/state/metadataStore.ts` — Zustand store (open, data, loading, position, toggle, refresh).
- Create: `src/state/metadataStore.test.ts` — store tests.
- Create: `src/components/MetadataCard.tsx` — floating HUD card.
- Create: `src/components/MetadataCard.css` — card styling.
- Create: `src/components/MetadataCard.test.tsx` — component tests.
- Modify: `src/App.tsx` — mount `<MetadataCard />`, wire ⌘⇧L + menu event.

---

## Task 1: Capture the PTY child pid in `PtyHandle`

**Files:**
- Modify: `src-tauri/src/pty.rs` (struct ~`:96`, spawn ~`:249`)

**Interfaces:**
- Consumes: `portable_pty` `Child::process_id() -> Option<u32>`.
- Produces: `PtyHandle.pid() -> Option<u32>` — used by Tasks 4 & 5 via the command in Task 6.

- [ ] **Step 1: Write the failing test**

Add to the `#[cfg(test)] mod tests` block in `src-tauri/src/pty.rs`:
```rust
#[tokio::test]
async fn test_spawn_pty_captures_pid() {
    let (tx, _rx) = tokio::sync::mpsc::channel(16);
    let handle = spawn_pty(
        PtyOptions {
            shell: "/bin/sh".to_string(),
            args: vec![],
            cwd: "/".to_string(),
            cols: 80,
            rows: 24,
        },
        tx,
    )
    .await
    .expect("spawn");
    assert!(handle.pid().is_some(), "expected a captured pid");
    assert!(handle.pid().unwrap() > 0);
    let _ = handle.kill();
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd src-tauri && cargo test --lib pty::tests::test_spawn_pty_captures_pid 2>&1 | tail -20`
Expected: FAIL — `no method named pid found for struct PtyHandle`.

- [ ] **Step 3: Add the `pid` field to `PtyHandle`**

In `src-tauri/src/pty.rs`, add a field to the struct (after `tap_slot`):
```rust
pub struct PtyHandle {
    master: Arc<Mutex<Box<dyn MasterPty + Send>>>,
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    killer: Arc<Mutex<Box<dyn portable_pty::ChildKiller + Send + Sync>>>,
    tap_slot: TapSlot,
    /// OS process id of the spawned shell (Phase 3E — used for port/ssh
    /// metadata gathering). `None` if the platform did not report one.
    pid: Option<u32>,
}
```

- [ ] **Step 4: Add the `pid()` accessor**

Add to an `impl PtyHandle` block in `src-tauri/src/pty.rs`:
```rust
impl PtyHandle {
    /// The OS process id of the spawned shell, if known.
    pub fn pid(&self) -> Option<u32> {
        self.pid
    }
}
```

- [ ] **Step 5: Capture the pid at spawn and set it on the handle**

In `spawn_pty` (`src-tauri/src/pty.rs` ~`:249`), immediately after `let child = pair.slave.spawn_command(cmd).context("spawn shell")?;` add:
```rust
    let pid = child.process_id();
```
Then add `pid,` to the `PtyHandle { ... }` constructor at the end of `spawn_pty` (wherever the handle is built and returned).

- [ ] **Step 6: Run test to verify it passes**

Run: `cd src-tauri && cargo test --lib pty::tests::test_spawn_pty_captures_pid 2>&1 | tail -20`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/pty.rs
git commit -m "feat(pty): capture shell pid in PtyHandle

portable_pty's child.process_id() was discarded at spawn. Capture it
into a new pid field with a pid() accessor — prerequisite for Phase 3E
port + ssh metadata gathering.

Part of Phase 3E (Task 1)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: Metadata module root + types

**Files:**
- Create: `src-tauri/src/metadata/mod.rs`
- Modify: `src-tauri/src/lib.rs` (add `pub mod metadata;`)

**Interfaces:**
- Produces:
  - `PaneMetadata { git: Option<GitInfo>, ports: Vec<PortInfo>, ssh: Option<SshInfo>, gathered_at: i64 }`
  - `GitInfo { branch: String, dirty: bool, changed_count: u32, ahead: u32, behind: u32 }`
  - `PortInfo { port: u16, proc_name: String }`
  - `SshInfo { host: String, user: Option<String>, port: Option<u16>, source: SshSource }`
  - `SshSource` enum `{ Chain, Process }` serialized lowercase.
  - All consumed by Tasks 3–6.

- [ ] **Step 1: Write the failing test**

Create `src-tauri/src/metadata/mod.rs` with ONLY a test at the bottom first (types added next step), so the module exists:
```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_ssh_source_serializes_lowercase() {
        let j = serde_json::to_string(&SshSource::Chain).unwrap();
        assert_eq!(j, "\"chain\"");
        let j = serde_json::to_string(&SshSource::Process).unwrap();
        assert_eq!(j, "\"process\"");
    }

    #[test]
    fn test_pane_metadata_serializes_camel_case() {
        let m = PaneMetadata {
            git: None,
            ports: vec![],
            ssh: None,
            gathered_at: 42,
        };
        let j = serde_json::to_string(&m).unwrap();
        assert!(j.contains("\"gatheredAt\":42"), "got {j}");
    }
}
```

- [ ] **Step 2: Add the type definitions above the test**

Prepend to `src-tauri/src/metadata/mod.rs`:
```rust
//! Phase 3E — pane metadata gathering. Three independent, partial-failure-
//! tolerant gatherers (git, ports, ssh) assembled into a `PaneMetadata`
//! snapshot for the focused terminal pane. macOS-first.

pub mod proc;
pub mod git;
pub mod ports;
pub mod ssh;

use serde::Serialize;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PaneMetadata {
    pub git: Option<GitInfo>,
    pub ports: Vec<PortInfo>,
    pub ssh: Option<SshInfo>,
    pub gathered_at: i64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GitInfo {
    pub branch: String,
    pub dirty: bool,
    pub changed_count: u32,
    pub ahead: u32,
    pub behind: u32,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PortInfo {
    pub port: u16,
    pub proc_name: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SshInfo {
    pub host: String,
    pub user: Option<String>,
    pub port: Option<u16>,
    pub source: SshSource,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum SshSource {
    Chain,
    Process,
}
```

NOTE: `pub mod proc/git/ports/ssh;` reference files created in Tasks 3–5. To let this task compile and test independently, create empty stub files now:
```bash
touch src-tauri/src/metadata/proc.rs src-tauri/src/metadata/git.rs src-tauri/src/metadata/ports.rs src-tauri/src/metadata/ssh.rs
```
(Each gets real content in its own task. Empty `.rs` files compile fine.)

- [ ] **Step 3: Register the module**

In `src-tauri/src/lib.rs`, add to the module list (alphabetically near `pub mod logging;` / `pub mod mcp;`):
```rust
pub mod metadata;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd src-tauri && cargo test --lib metadata::tests 2>&1 | tail -20`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/metadata/ src-tauri/src/lib.rs
git commit -m "feat(metadata): module root + PaneMetadata types

PaneMetadata/GitInfo/PortInfo/SshInfo/SshSource with camelCase IPC
serialization. Empty gatherer submodule stubs added (filled in later
tasks).

Part of Phase 3E (Task 2)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: Process-tree helper (`proc.rs`)

**Files:**
- Create (replace stub): `src-tauri/src/metadata/proc.rs`

**Interfaces:**
- Consumes: nothing (CLI `pgrep -P` at runtime).
- Produces:
  - `pub fn child_pids(root: u32) -> Vec<u32>` — BFS of descendants incl. `root`, via `pgrep`.
  - `pub(crate) fn walk_tree(root: u32, children_of: impl Fn(u32) -> Vec<u32>) -> Vec<u32>` — pure, testable BFS with cycle guard.

- [ ] **Step 1: Write the failing test**

Replace `src-tauri/src/metadata/proc.rs` contents with:
```rust
//! Process-tree helper (Phase 3E). Resolves a pid's descendants for the port
//! and ssh-fallback gatherers. macOS/Unix (`pgrep -P`).

use std::collections::{HashMap, HashSet, VecDeque};

/// Pure BFS over a process tree. `children_of(pid)` returns direct children.
/// Includes `root`. Cycle-guarded (a pid is visited at most once).
pub(crate) fn walk_tree(root: u32, children_of: impl Fn(u32) -> Vec<u32>) -> Vec<u32> {
    let mut seen = HashSet::new();
    let mut order = Vec::new();
    let mut q = VecDeque::new();
    q.push_back(root);
    while let Some(pid) = q.pop_front() {
        if !seen.insert(pid) {
            continue;
        }
        order.push(pid);
        for c in children_of(pid) {
            q.push_back(c);
        }
    }
    order
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tree() -> HashMap<u32, Vec<u32>> {
        // 100 -> 200 -> 400 ; 100 -> 300
        HashMap::from([(100, vec![200, 300]), (200, vec![400]), (300, vec![])])
    }

    #[test]
    fn test_walk_tree_bfs_includes_root_and_descendants() {
        let t = tree();
        let got = walk_tree(100, |p| t.get(&p).cloned().unwrap_or_default());
        assert_eq!(got, vec![100, 200, 300, 400]);
    }

    #[test]
    fn test_walk_tree_handles_cycle_without_infinite_loop() {
        // 1 -> 2 -> 1 (cycle)
        let t: HashMap<u32, Vec<u32>> = HashMap::from([(1, vec![2]), (2, vec![1])]);
        let got = walk_tree(1, |p| t.get(&p).cloned().unwrap_or_default());
        assert_eq!(got, vec![1, 2]);
    }

    #[test]
    fn test_walk_tree_leaf_only() {
        let got = walk_tree(7, |_| vec![]);
        assert_eq!(got, vec![7]);
    }
}
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `cd src-tauri && cargo test --lib metadata::proc::tests 2>&1 | tail -20`
Expected: PASS (3 tests). (The pure helper is fully testable now.)

- [ ] **Step 3: Add the real `child_pids` using `pgrep`**

Append to `src-tauri/src/metadata/proc.rs`:
```rust
/// Direct children of `pid` via `pgrep -P <pid>`. Empty on any failure.
fn pgrep_children(pid: u32) -> Vec<u32> {
    let out = match std::process::Command::new("pgrep").arg("-P").arg(pid.to_string()).output() {
        Ok(o) => o,
        Err(_) => return Vec::new(),
    };
    if !out.status.success() {
        return Vec::new(); // pgrep exits 1 when no children — not an error here
    }
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter_map(|l| l.trim().parse::<u32>().ok())
        .collect()
}

/// All descendants of `root` (inclusive), breadth-first. macOS/Unix only;
/// returns just `[root]` if `pgrep` is unavailable.
pub fn child_pids(root: u32) -> Vec<u32> {
    walk_tree(root, pgrep_children)
}
```

- [ ] **Step 4: Verify build (real path is integration-tested live in Task 8)**

Run: `cd src-tauri && cargo build 2>&1 | grep -E "^error" | head`
Expected: no output (builds clean).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/metadata/proc.rs
git commit -m "feat(metadata): process-tree helper (pure BFS + pgrep)

walk_tree is a cycle-guarded pure BFS (fully unit-tested); child_pids
wires it to pgrep -P. Shared by the ports + ssh-fallback gatherers.

Part of Phase 3E (Task 3)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: Git gatherer (`git.rs`)

**Files:**
- Create (replace stub): `src-tauri/src/metadata/git.rs`

**Interfaces:**
- Consumes: `git2::Repository`; `super::GitInfo`.
- Produces: `pub fn gather_git(cwd: &str) -> Option<GitInfo>` — used by Task 6.

- [ ] **Step 1: Write the failing test**

Replace `src-tauri/src/metadata/git.rs` contents with:
```rust
//! Git metadata gatherer (Phase 3E). Reuses git2 (already a dep). A non-repo
//! cwd yields None — the common case, not a failure.

use super::GitInfo;

pub fn gather_git(cwd: &str) -> Option<GitInfo> {
    todo!()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    fn sh(dir: &std::path::Path, args: &[&str]) {
        let status = Command::new(args[0]).args(&args[1..]).current_dir(dir).status().unwrap();
        assert!(status.success(), "cmd failed: {args:?}");
    }

    fn init_repo() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path();
        sh(p, &["git", "init", "-q", "-b", "main"]);
        sh(p, &["git", "config", "user.email", "t@t.com"]);
        sh(p, &["git", "config", "user.name", "t"]);
        std::fs::write(p.join("a.txt"), "hello").unwrap();
        sh(p, &["git", "add", "."]);
        sh(p, &["git", "commit", "-q", "-m", "init"]);
        dir
    }

    #[test]
    fn test_gather_git_clean_repo_on_main() {
        let dir = init_repo();
        let info = gather_git(dir.path().to_str().unwrap()).expect("some");
        assert_eq!(info.branch, "main");
        assert!(!info.dirty);
        assert_eq!(info.changed_count, 0);
    }

    #[test]
    fn test_gather_git_dirty_counts_changed() {
        let dir = init_repo();
        std::fs::write(dir.path().join("b.txt"), "new").unwrap(); // untracked
        let info = gather_git(dir.path().to_str().unwrap()).expect("some");
        assert!(info.dirty);
        assert_eq!(info.changed_count, 1);
    }

    #[test]
    fn test_gather_git_non_repo_is_none() {
        let dir = tempfile::tempdir().unwrap();
        assert!(gather_git(dir.path().to_str().unwrap()).is_none());
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd src-tauri && cargo test --lib metadata::git::tests 2>&1 | tail -20`
Expected: FAIL (panics at `todo!()`).

NOTE: If `tempfile` is not already a dev-dependency, check first:
```bash
grep -A20 "\[dev-dependencies\]" src-tauri/Cargo.toml | grep tempfile
```
If absent, the repo almost certainly already uses temp dirs elsewhere — search `grep -rl "tempfile::tempdir" src-tauri/src | head`. If genuinely absent, add `tempfile` under `[dev-dependencies]` only (dev-only, not a runtime dep, so it does not violate the no-new-deps constraint).

- [ ] **Step 3: Implement `gather_git`**

Replace the `todo!()` body:
```rust
pub fn gather_git(cwd: &str) -> Option<GitInfo> {
    let repo = git2::Repository::discover(cwd).ok()?;

    // Branch name (or detached short sha).
    let head = repo.head().ok();
    let branch = match &head {
        Some(h) if h.is_branch() => h.shorthand().unwrap_or("HEAD").to_string(),
        Some(h) => {
            let sha = h.target().map(|o| o.to_string()).unwrap_or_default();
            format!("(detached @ {})", &sha.chars().take(7).collect::<String>())
        }
        None => "HEAD".to_string(),
    };

    // Working-tree status (exclude ignored).
    let mut opts = git2::StatusOptions::new();
    opts.include_untracked(true).include_ignored(false);
    let statuses = repo.statuses(Some(&mut opts)).ok()?;
    let changed_count = statuses.iter().filter(|e| {
        !e.status().is_empty() && !e.status().contains(git2::Status::IGNORED)
    }).count() as u32;
    let dirty = changed_count > 0;

    // ahead/behind vs upstream (default 0/0 when no upstream).
    let (mut ahead, mut behind) = (0u32, 0u32);
    if let Some(h) = &head {
        if let Some(local_oid) = h.target() {
            if let Ok(local_branch) = repo.find_branch(
                h.shorthand().unwrap_or(""),
                git2::BranchType::Local,
            ) {
                if let Ok(upstream) = local_branch.upstream() {
                    if let Some(up_oid) = upstream.get().target() {
                        if let Ok((a, b)) = repo.graph_ahead_behind(local_oid, up_oid) {
                            ahead = a as u32;
                            behind = b as u32;
                        }
                    }
                }
            }
        }
    }

    Some(GitInfo { branch, dirty, changed_count, ahead, behind })
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd src-tauri && cargo test --lib metadata::git::tests 2>&1 | tail -20`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/metadata/git.rs src-tauri/Cargo.toml
git commit -m "feat(metadata): git gatherer (branch/dirty/ahead/behind)

git2-based; non-repo cwd -> None. Counts changed+untracked (excl.
ignored); ahead/behind vs upstream defaulting 0/0.

Part of Phase 3E (Task 4)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: Ports gatherer + SSH gatherer/parser (`ports.rs`, `ssh.rs`)

**Files:**
- Create (replace stub): `src-tauri/src/metadata/ports.rs`
- Create (replace stub): `src-tauri/src/metadata/ssh.rs`

**Interfaces:**
- Consumes: `super::proc::child_pids`; `super::{PortInfo, SshInfo, SshSource}`.
- Produces:
  - `pub fn gather_ports(pid: u32) -> Vec<PortInfo>` (ports.rs)
  - `pub(crate) fn parse_lsof_f(output: &str) -> Vec<PortInfo>` (ports.rs, pure/testable)
  - `pub(crate) fn parse_ssh_argv(argv: &[String]) -> Option<SshInfo>` (ssh.rs, pure/testable)
  - `pub fn gather_ssh_from_process(pid: u32) -> Option<SshInfo>` (ssh.rs)

- [ ] **Step 1: Write the failing test for the lsof parser**

Replace `src-tauri/src/metadata/ports.rs` with:
```rust
//! Listening-ports gatherer (Phase 3E, macOS-first). Walks the pane pid's
//! descendants and asks lsof for TCP LISTEN sockets in machine-parseable
//! (-F) format.

use super::PortInfo;
use std::collections::BTreeMap;

/// Parse `lsof -nP -FpcPn` field output into deduped PortInfo (by port).
/// lsof -F emits one field per line: `p<pid>`, `c<command>`, then per file
/// `n<name>` like `n*:8000` or `n127.0.0.1:8000`. We track the current
/// command (`c`) and extract the port from each `n` line.
pub(crate) fn parse_lsof_f(output: &str) -> Vec<PortInfo> {
    let mut by_port: BTreeMap<u16, String> = BTreeMap::new();
    let mut cur_cmd = String::new();
    for line in output.lines() {
        let (tag, rest) = match line.split_at(line.char_indices().nth(1).map(|(i, _)| i).unwrap_or(0)) {
            (t, r) => (t, r),
        };
        match tag {
            "c" => cur_cmd = rest.to_string(),
            "n" => {
                // rest is like "*:8000" or "127.0.0.1:8000" or "[::1]:8000"
                if let Some(idx) = rest.rfind(':') {
                    if let Ok(port) = rest[idx + 1..].parse::<u16>() {
                        by_port.entry(port).or_insert_with(|| cur_cmd.clone());
                    }
                }
            }
            _ => {}
        }
    }
    by_port.into_iter().map(|(port, proc_name)| PortInfo { port, proc_name }).collect()
}

pub fn gather_ports(pid: u32) -> Vec<PortInfo> {
    let pids = super::proc::child_pids(pid);
    if pids.is_empty() {
        return Vec::new();
    }
    let csv = pids.iter().map(|p| p.to_string()).collect::<Vec<_>>().join(",");
    let out = match std::process::Command::new("lsof")
        .args(["-nP", "-iTCP", "-sTCP:LISTEN", "-FpcPn", "-p", &csv])
        .output()
    {
        Ok(o) => o,
        Err(_) => return Vec::new(),
    };
    parse_lsof_f(&String::from_utf8_lossy(&out.stdout))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_lsof_extracts_port_and_command() {
        let sample = "p1234\ncpython3\nn*:8000\n";
        let got = parse_lsof_f(sample);
        assert_eq!(got, vec![PortInfo { port: 8000, proc_name: "python3".into() }]);
    }

    #[test]
    fn test_parse_lsof_dedups_by_port_and_handles_ipv6() {
        let sample = "p1\ncnode\nn127.0.0.1:3000\nn[::1]:3000\n";
        let got = parse_lsof_f(sample);
        assert_eq!(got, vec![PortInfo { port: 3000, proc_name: "node".into() }]);
    }

    #[test]
    fn test_parse_lsof_empty_is_empty() {
        assert!(parse_lsof_f("").is_empty());
    }
}
```

- [ ] **Step 2: Run ports tests to verify they pass**

Run: `cd src-tauri && cargo test --lib metadata::ports::tests 2>&1 | tail -20`
Expected: PASS (3 tests).

- [ ] **Step 3: Write the SSH argv parser + gatherer with failing tests**

Replace `src-tauri/src/metadata/ssh.rs` with:
```rust
//! SSH-context gatherer (Phase 3E). The chain-binding (authoritative) path is
//! handled in the command layer (needs the DB); this module provides the
//! process-fallback: find an ssh/telnet descendant and parse its argv.

use super::{SshInfo, SshSource};

/// Parse an `ssh`/`telnet` argv into SshInfo. Handles `user@host`, `-p PORT`,
/// `-l USER`, and a bare host. Returns None if no host can be determined or
/// argv is not an ssh/telnet invocation.
pub(crate) fn parse_ssh_argv(argv: &[String]) -> Option<SshInfo> {
    let prog = argv.first()?.rsplit('/').next().unwrap_or("");
    if prog != "ssh" && prog != "telnet" {
        return None;
    }
    let mut user: Option<String> = None;
    let mut port: Option<u16> = None;
    let mut host: Option<String> = None;

    let mut i = 1;
    while i < argv.len() {
        let a = &argv[i];
        match a.as_str() {
            "-p" | "-P" => {
                i += 1;
                if let Some(p) = argv.get(i) {
                    port = p.parse::<u16>().ok();
                }
            }
            "-l" => {
                i += 1;
                user = argv.get(i).cloned();
            }
            s if s.starts_with('-') => { /* skip other flags */ }
            s => {
                // first non-flag positional is the destination
                if host.is_none() {
                    if let Some((u, h)) = s.split_once('@') {
                        user = Some(u.to_string());
                        host = Some(h.to_string());
                    } else {
                        host = Some(s.to_string());
                    }
                }
            }
        }
        i += 1;
    }

    host.map(|host| SshInfo { host, user, port, source: SshSource::Process })
}

/// Read a pid's argv (macOS/Unix `ps -o command= -p <pid>`), split on spaces.
fn argv_of(pid: u32) -> Vec<String> {
    let out = match std::process::Command::new("ps")
        .args(["-o", "command=", "-p", &pid.to_string()])
        .output()
    {
        Ok(o) => o,
        Err(_) => return Vec::new(),
    };
    String::from_utf8_lossy(&out.stdout)
        .trim()
        .split_whitespace()
        .map(|s| s.to_string())
        .collect()
}

/// Walk the pane pid's descendants for an ssh/telnet process and parse it.
pub fn gather_ssh_from_process(pid: u32) -> Option<SshInfo> {
    for p in super::proc::child_pids(pid) {
        let argv = argv_of(p);
        if let Some(info) = parse_ssh_argv(&argv) {
            return Some(info);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn argv(parts: &[&str]) -> Vec<String> {
        parts.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn test_parse_user_at_host_with_port() {
        let info = parse_ssh_argv(&argv(&["ssh", "admin@192.168.1.1", "-p", "2222"])).unwrap();
        assert_eq!(info.host, "192.168.1.1");
        assert_eq!(info.user.as_deref(), Some("admin"));
        assert_eq!(info.port, Some(2222));
        assert_eq!(info.source, SshSource::Process);
    }

    #[test]
    fn test_parse_bare_host() {
        let info = parse_ssh_argv(&argv(&["ssh", "core-sw-01"])).unwrap();
        assert_eq!(info.host, "core-sw-01");
        assert!(info.user.is_none());
        assert!(info.port.is_none());
    }

    #[test]
    fn test_parse_dash_l_user() {
        let info = parse_ssh_argv(&argv(&["ssh", "-l", "operator", "10.0.0.5"])).unwrap();
        assert_eq!(info.host, "10.0.0.5");
        assert_eq!(info.user.as_deref(), Some("operator"));
    }

    #[test]
    fn test_full_path_ssh_binary() {
        let info = parse_ssh_argv(&argv(&["/usr/bin/ssh", "host"])).unwrap();
        assert_eq!(info.host, "host");
    }

    #[test]
    fn test_non_ssh_is_none() {
        assert!(parse_ssh_argv(&argv(&["vim", "file.txt"])).is_none());
        assert!(parse_ssh_argv(&argv(&[])).is_none());
    }
}
```

- [ ] **Step 4: Run ssh tests to verify they pass**

Run: `cd src-tauri && cargo test --lib metadata::ssh::tests 2>&1 | tail -20`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/metadata/ports.rs src-tauri/src/metadata/ssh.rs
git commit -m "feat(metadata): ports gatherer + ssh process-fallback parser

ports: walk pid descendants -> lsof -F -> deduped PortInfo (pure parser
unit-tested). ssh: parse_ssh_argv handles user@host/-p/-l/bare host
(unit-tested); gather_ssh_from_process walks descendants for ssh/telnet.

Part of Phase 3E (Task 5)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6: Aggregate orchestrator + Tauri command

**Files:**
- Modify: `src-tauri/src/metadata/mod.rs` (add `get_metadata` orchestrator)
- Create: `src-tauri/src/commands/metadata.rs` (the `#[tauri::command]`)
- Modify: `src-tauri/src/commands/mod.rs` (add `pub mod metadata;`)
- Modify: `src-tauri/src/lib.rs` (register command in `invoke_handler`)

**Interfaces:**
- Consumes: `gather_git`, `gather_ports`, `gather_ssh_from_process`; `AppState.ptys` (keyed by `terminal_id`); the existing SSH-chain lookup for the authoritative path.
- Produces: `#[tauri::command] get_pane_metadata(terminal_id, cwd, tab_id) -> Result<PaneMetadata, String>` — consumed by the frontend (Task 7).

- [ ] **Step 1: Add the orchestrator to `mod.rs` with a failing test**

In `src-tauri/src/metadata/mod.rs`, add above the `#[cfg(test)]` block:
```rust
/// Assemble pane metadata from the three gatherers. `pid` is the pane's shell
/// pid (None ⇒ ports/ssh-fallback skipped). `ssh_from_chain` is the
/// authoritative SSH context resolved by the caller (command layer) from the
/// tab's bound session chain; when present it wins over the process fallback.
pub fn get_metadata(
    cwd: &str,
    pid: Option<u32>,
    ssh_from_chain: Option<SshInfo>,
    now: i64,
) -> PaneMetadata {
    let git = git::gather_git(cwd);
    let ports = pid.map(ports::gather_ports).unwrap_or_default();
    let ssh = ssh_from_chain.or_else(|| pid.and_then(ssh::gather_ssh_from_process));
    PaneMetadata { git, ports, ssh, gathered_at: now }
}
```

Add this test to the `tests` module in `mod.rs`:
```rust
    #[test]
    fn test_get_metadata_chain_ssh_wins_over_process() {
        let chain = SshInfo {
            host: "chain-host".into(),
            user: None,
            port: None,
            source: SshSource::Chain,
        };
        // pid None ⇒ no process fallback; chain value must pass through.
        let m = get_metadata("/nonexistent-xyz", None, Some(chain.clone()), 7);
        assert_eq!(m.ssh, Some(chain));
        assert!(m.git.is_none());
        assert!(m.ports.is_empty());
        assert_eq!(m.gathered_at, 7);
    }
```

- [ ] **Step 2: Run test to verify it passes**

Run: `cd src-tauri && cargo test --lib metadata::tests::test_get_metadata_chain_ssh_wins_over_process 2>&1 | tail -20`
Expected: PASS.

- [ ] **Step 3: Discover the SSH-chain lookup helpers (no assumptions)**

The authoritative SSH path resolves: `tab_id` → bound chain → last hop target → host/user/port. Find the exact existing helpers before wiring:
```bash
cd "/Users/shaunwhi/CCIE Terminal"
grep -rn "tab_set_chain\|tab_get_chain\|fn.*chain" src-tauri/src/commands/ src-tauri/src/session_chains* 2>/dev/null | head -20
grep -rn "fn ssh_get_connection\|pub fn.*connection" src-tauri/src/commands/ssh.rs | head
```
Record the function names/signatures you find; use them in Step 4. If a tab→chain binding getter does not exist as a plain function (only as a `#[tauri::command]`), call the underlying store function it delegates to. If NO chain-binding lookup is reachable without a command, implement the chain path as a best-effort `None` for now and rely on the process fallback — note this gap in the commit message (do NOT block the task).

- [ ] **Step 4: Write the Tauri command**

Create `src-tauri/src/commands/metadata.rs`:
```rust
//! Phase 3E — get_pane_metadata command. Resolves the focused pane's shell pid
//! (via the ptys map, keyed by terminal_id) and the authoritative SSH context
//! (via the tab's bound session chain), then delegates to metadata::get_metadata.

use crate::commands::AppState;
use crate::metadata::{self, PaneMetadata, SshInfo, SshSource};
use tauri::State;

/// Resolve the authoritative SSH context from the tab's bound chain, if any.
/// Returns None when the tab has no chain or the lookup is unavailable.
fn ssh_from_chain(state: &AppState, tab_id: &str) -> Option<SshInfo> {
    // NOTE: wire to the helpers discovered in Step 3. Pattern:
    //   let chain_id = <get bound chain id for tab_id>?;
    //   let chain = <load chain by id>?;
    //   let last = chain.hops.last()?;
    //   let conn = <resolve last.target_ref to an SshConnection>?;
    //   Some(SshInfo { host: conn.host, user: conn.user,
    //                  port: conn.port.map(|p| p as u16), source: SshSource::Chain })
    let _ = (state, tab_id);
    None
}

#[tauri::command]
pub async fn get_pane_metadata(
    state: State<'_, AppState>,
    terminal_id: String,
    cwd: String,
    tab_id: String,
) -> Result<PaneMetadata, String> {
    // Resolve the pane's shell pid from the ptys map (keyed by terminal_id).
    let pid = {
        let ptys = state.ptys.lock();
        match ptys.get(&terminal_id) {
            Some(h) => h.pid(),
            None => {
                // Unknown terminal_id is the one genuine error case.
                return Err(format!("Unknown terminal_id '{}'", terminal_id));
            }
        }
    };

    let chain_ssh = ssh_from_chain(&state, &tab_id);

    // gather_ports / gather_ssh_from_process shell out (blocking). Run the
    // assembly off the async runtime's core threads.
    let now = chrono::Utc::now().timestamp();
    let meta = tokio::task::spawn_blocking(move || {
        metadata::get_metadata(&cwd, pid, chain_ssh, now)
    })
    .await
    .map_err(|e| format!("metadata join error: {}", e))?;

    Ok(meta)
}
```

NOTE on `chrono`: confirm it's a dep with `grep '^chrono' src-tauri/Cargo.toml`. If absent, replace the `now` line with:
```rust
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
```

- [ ] **Step 5: Register the command module + handler**

In `src-tauri/src/commands/mod.rs`, add near the other `pub mod` lines:
```rust
pub mod metadata;
```
In `src-tauri/src/lib.rs`, add to the `tauri::generate_handler![ ... ]` list (near `commands::browser::browser_eval,`):
```rust
            commands::metadata::get_pane_metadata,
```

- [ ] **Step 6: Build**

Run: `cd src-tauri && cargo build 2>&1 | grep -E "^error" | head`
Expected: no output (builds clean).

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/metadata/mod.rs src-tauri/src/commands/metadata.rs src-tauri/src/commands/mod.rs src-tauri/src/lib.rs
git commit -m "feat(metadata): get_pane_metadata command + orchestrator

get_metadata assembles git+ports+ssh with chain-ssh winning over the
process fallback (unit-tested). Command resolves the pane pid via the
ptys map (keyed by terminal_id), resolves authoritative SSH from the
tab chain, and runs the blocking gather on spawn_blocking.

Part of Phase 3E (Task 6)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 7: Frontend — lib wrapper, store, card component

**Files:**
- Create: `src/lib/metadata.ts`
- Create: `src/state/metadataStore.ts`
- Create: `src/state/metadataStore.test.ts`
- Create: `src/components/MetadataCard.tsx`
- Create: `src/components/MetadataCard.css`
- Create: `src/components/MetadataCard.test.tsx`

**Interfaces:**
- Consumes: `get_pane_metadata` (Task 6); `usePanesStore` (`focusedPaneId`, pane→`terminalId` resolver); `usePaneActivityStore` (`getActivity(paneId).cwd`); tab id source.
- Produces: `useMetadataStore` (`open`, `data`, `loading`, `error`, `position`, `toggle`, `setPosition`, `refresh`); `<MetadataCard />`.

- [ ] **Step 1: Write the lib wrapper + types**

Create `src/lib/metadata.ts`:
```typescript
import { invoke } from '@tauri-apps/api/core';

export type SshSource = 'chain' | 'process';

export interface GitInfo {
  branch: string;
  dirty: boolean;
  changedCount: number;
  ahead: number;
  behind: number;
}
export interface PortInfo {
  port: number;
  procName: string;
}
export interface SshInfo {
  host: string;
  user: string | null;
  port: number | null;
  source: SshSource;
}
export interface PaneMetadata {
  git: GitInfo | null;
  ports: PortInfo[];
  ssh: SshInfo | null;
  gatheredAt: number;
}

export const getPaneMetadata = (terminalId: string, cwd: string, tabId: string) =>
  invoke<PaneMetadata>('get_pane_metadata', { terminalId, cwd, tabId });
```

- [ ] **Step 2: Write the store test (failing)**

Create `src/state/metadataStore.test.ts`:
```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the lib wrapper so the store has no real IPC.
vi.mock('../lib/metadata', () => ({
  getPaneMetadata: vi.fn(),
}));
// Mock the pane stores the refresh() resolver depends on.
vi.mock('./panesStore', () => ({
  usePanesStore: { getState: vi.fn() },
}));
vi.mock('./paneActivityStore', () => ({
  usePaneActivityStore: { getState: vi.fn() },
}));

import { useMetadataStore } from './metadataStore';
import { getPaneMetadata } from '../lib/metadata';
import { usePanesStore } from './panesStore';
import { usePaneActivityStore } from './paneActivityStore';

beforeEach(() => {
  useMetadataStore.setState({
    open: false, data: null, loading: false, error: null,
    position: { x: 0, y: 0 },
  });
  vi.clearAllMocks();
});

describe('metadataStore', () => {
  it('toggle flips open', () => {
    expect(useMetadataStore.getState().open).toBe(false);
    useMetadataStore.getState().toggle();
    expect(useMetadataStore.getState().open).toBe(true);
  });

  it('refresh with no focused pane sets a neutral error and does not call IPC', async () => {
    (usePanesStore.getState as any).mockReturnValue({ focusedPaneId: null });
    await useMetadataStore.getState().refresh();
    expect(getPaneMetadata).not.toHaveBeenCalled();
    expect(useMetadataStore.getState().error).toMatch(/no focused pane/i);
  });

  it('refresh resolves pane context and stores returned data', async () => {
    (usePanesStore.getState as any).mockReturnValue({
      focusedPaneId: 'pane-1',
      focusedTabId: 'tab-1',
      resolveTerminalIdForPane: (_: string) => 'term-1',
    });
    (usePaneActivityStore.getState as any).mockReturnValue({
      getActivity: (_: string) => ({ cwd: '/repo' }),
    });
    (getPaneMetadata as any).mockResolvedValue({
      git: { branch: 'main', dirty: false, changedCount: 0, ahead: 0, behind: 0 },
      ports: [], ssh: null, gatheredAt: 123,
    });
    await useMetadataStore.getState().refresh();
    expect(getPaneMetadata).toHaveBeenCalledWith('term-1', '/repo', 'tab-1');
    expect(useMetadataStore.getState().data?.git?.branch).toBe('main');
    expect(useMetadataStore.getState().loading).toBe(false);
  });
});
```

- [ ] **Step 3: Discover the exact pane→terminalId + focusedTabId accessors (no assumptions)**

The store test assumes `focusedPaneId`, a tab id, and a pane→terminalId resolver on `usePanesStore`. Confirm the real names:
```bash
cd "/Users/shaunwhi/CCIE Terminal"
grep -nE "focusedPaneId|focusedTabId|activeTabId|resolveRecordingTerminalId|terminalId|resolve.*Terminal" src/state/panesStore.ts src/state/tabsStore.ts | head -30
```
Use the real accessor in Step 4's `refresh()`. The plan uses `resolveTerminalIdForPane(paneId)` as a placeholder name — if the actual resolver is `resolveRecordingTerminalId(tabId)` or a tree walk, adapt `refresh()` and the test's mock to match. The active tab id likely comes from `tabsStore` (e.g. `activeTabId`); use whatever the codebase exposes.

- [ ] **Step 4: Implement the store**

Create `src/state/metadataStore.ts`:
```typescript
import { create } from 'zustand';
import { getPaneMetadata, type PaneMetadata } from '../lib/metadata';
import { usePanesStore } from './panesStore';
import { usePaneActivityStore } from './paneActivityStore';

const DEFAULT_POSITION = { x: window.innerWidth - 320, y: 80 };

interface MetadataStore {
  open: boolean;
  data: PaneMetadata | null;
  loading: boolean;
  error: string | null;
  position: { x: number; y: number };
  toggle: () => void;
  setPosition: (x: number, y: number) => void;
  refresh: () => Promise<void>;
}

export const useMetadataStore = create<MetadataStore>((set) => ({
  open: false,
  data: null,
  loading: false,
  error: null,
  position: DEFAULT_POSITION,

  toggle: () => {
    set((s) => {
      const open = !s.open;
      // Reset to default corner each time it opens (no persistence).
      return open
        ? { open, position: { x: window.innerWidth - 320, y: 80 } }
        : { open };
    });
    // Refresh on open.
    if (useMetadataStore.getState().open) {
      void useMetadataStore.getState().refresh();
    }
  },

  setPosition: (x, y) => set({ position: { x, y } }),

  refresh: async () => {
    // Resolve focused pane context. Accessor names confirmed in Step 3 —
    // adapt the next lines to the real panesStore/tabsStore API.
    const panes = usePanesStore.getState() as any;
    const paneId: string | null = panes.focusedPaneId ?? null;
    if (!paneId) {
      set({ error: 'No focused pane', data: null, loading: false });
      return;
    }
    const tabId: string = panes.focusedTabId ?? panes.activeTabId ?? '';
    const terminalId: string =
      (panes.resolveTerminalIdForPane?.(paneId)) ??
      (panes.resolveRecordingTerminalId?.(tabId)) ??
      paneId;
    const activity = (usePaneActivityStore.getState() as any).getActivity?.(paneId);
    const cwd: string = activity?.cwd ?? '/';

    set({ loading: true, error: null });
    try {
      const data = await getPaneMetadata(terminalId, cwd, tabId);
      set({ data, loading: false });
    } catch (e) {
      set({ error: String(e), loading: false });
    }
  },
}));
```

- [ ] **Step 5: Run store tests to verify they pass**

Run: `npm test -- src/state/metadataStore.test.ts 2>&1 | tail -25`
Expected: PASS (3 tests). (If accessor names differ, fix `refresh()` + the test mock together per Step 3.)

- [ ] **Step 6: Write the component test (failing)**

Create `src/components/MetadataCard.test.tsx`:
```tsx
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { useMetadataStore } from '../state/metadataStore';
import MetadataCard from './MetadataCard';

beforeEach(() => {
  useMetadataStore.setState({
    open: true, loading: false, error: null,
    position: { x: 10, y: 10 },
    data: {
      git: { branch: 'main', dirty: true, changedCount: 3, ahead: 1, behind: 0 },
      ports: [{ port: 8000, procName: 'python3' }],
      ssh: { host: '192.168.1.1', user: 'admin', port: 22, source: 'chain' },
      gatheredAt: 1700000000,
    },
  });
});

describe('MetadataCard', () => {
  it('renders all three sections from data', () => {
    render(<MetadataCard />);
    expect(screen.getByText('main')).toBeInTheDocument();
    expect(screen.getByText(/8000/)).toBeInTheDocument();
    expect(screen.getByText(/192\.168\.1\.1/)).toBeInTheDocument();
    expect(screen.getByText(/chain/i)).toBeInTheDocument();
  });

  it('renders nothing when closed', () => {
    useMetadataStore.setState({ open: false });
    const { container } = render(<MetadataCard />);
    expect(container.firstChild).toBeNull();
  });

  it('shows empty states when sections are absent', () => {
    useMetadataStore.setState({
      data: { git: null, ports: [], ssh: null, gatheredAt: 1700000000 },
    });
    render(<MetadataCard />);
    expect(screen.getByText(/not a git repo/i)).toBeInTheDocument();
    expect(screen.getByText(/no listening ports/i)).toBeInTheDocument();
    expect(screen.getByText(/not an ssh session/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 7: Implement the component + CSS**

Create `src/components/MetadataCard.tsx`:
```tsx
import React, { useEffect, useRef } from 'react';
import { useMetadataStore } from '../state/metadataStore';
import { usePanesStore } from '../state/panesStore';
import './MetadataCard.css';

const MetadataCard: React.FC = () => {
  const { open, data, loading, error, position, setPosition, refresh, toggle } =
    useMetadataStore();
  const focusedPaneId = usePanesStore((s) => (s as any).focusedPaneId);
  const dragRef = useRef<{ dx: number; dy: number } | null>(null);

  // Refresh when the focused pane changes while open.
  useEffect(() => {
    if (open) void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusedPaneId]);

  if (!open) return null;

  const onPointerDown = (e: React.PointerEvent) => {
    dragRef.current = { dx: e.clientX - position.x, dy: e.clientY - position.y };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!dragRef.current) return;
    setPosition(e.clientX - dragRef.current.dx, e.clientY - dragRef.current.dy);
  };
  const onPointerUp = () => { dragRef.current = null; };

  const asOf = new Date((data?.gatheredAt ?? 0) * 1000).toLocaleTimeString();

  return (
    <div className="metadata-card" style={{ left: position.x, top: position.y }}>
      <div
        className="metadata-card__header"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      >
        <span className="metadata-card__title">Pane Context</span>
        <button
          className="metadata-card__btn"
          onClick={() => refresh()}
          aria-label="Refresh"
          title="Refresh"
        >
          <span className={loading ? 'spin' : ''}>↻</span>
        </button>
        <button className="metadata-card__btn" onClick={() => toggle()} aria-label="Close">×</button>
      </div>

      <div className="metadata-card__body">
        {error && <div className="metadata-card__error">{error}</div>}

        <section className="metadata-card__section">
          <h4>Git</h4>
          {data?.git ? (
            <div className="metadata-card__git">
              <span className="branch">⎇ {data.git.branch}</span>
              {data.git.dirty && <span className="dirty-dot" title="uncommitted changes">●</span>}
              <span className="muted">{data.git.changedCount} changed</span>
              <span className="muted">↑{data.git.ahead} ↓{data.git.behind}</span>
            </div>
          ) : (
            <div className="muted">Not a git repo</div>
          )}
        </section>

        <section className="metadata-card__section">
          <h4>Listening Ports</h4>
          {data && data.ports.length > 0 ? (
            <ul className="metadata-card__ports">
              {data.ports.map((p) => (
                <li key={p.port}><code>:{p.port}</code> {p.procName}</li>
              ))}
            </ul>
          ) : (
            <div className="muted">No listening ports</div>
          )}
        </section>

        <section className="metadata-card__section">
          <h4>SSH</h4>
          {data?.ssh ? (
            <div className="metadata-card__ssh">
              <code>
                {data.ssh.user ? `${data.ssh.user}@` : ''}{data.ssh.host}
                {data.ssh.port ? `:${data.ssh.port}` : ''}
              </code>
              <span className={`badge badge--${data.ssh.source}`}>via {data.ssh.source}</span>
            </div>
          ) : (
            <div className="muted">Not an SSH session</div>
          )}
        </section>
      </div>

      <div className="metadata-card__footer muted">as of {asOf}</div>
    </div>
  );
};

export default MetadataCard;
```

Create `src/components/MetadataCard.css`:
```css
.metadata-card {
  position: fixed;
  z-index: 9000;
  width: 280px;
  background: #1a1d24;
  border: 1px solid #2d3139;
  border-radius: 8px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45);
  color: #e6e1cf;
  font-size: 12px;
  user-select: none;
}
.metadata-card__header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  cursor: move;
  border-bottom: 1px solid #2d3139;
}
.metadata-card__title { flex: 1; font-weight: 600; }
.metadata-card__btn {
  background: none; border: none; color: #9aa0aa; cursor: pointer;
  font-size: 14px; line-height: 1; padding: 2px 4px;
}
.metadata-card__btn:hover { color: #e6e1cf; }
.metadata-card__body { padding: 8px 10px; }
.metadata-card__section { margin-bottom: 10px; }
.metadata-card__section h4 {
  margin: 0 0 4px; font-size: 10px; text-transform: uppercase;
  letter-spacing: 0.05em; color: #6b7280;
}
.metadata-card__git { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.metadata-card__git .branch { font-weight: 600; }
.metadata-card__git .dirty-dot { color: #f59e0b; }
.metadata-card__ports { list-style: none; margin: 0; padding: 0; }
.metadata-card__ports li { padding: 1px 0; }
.metadata-card__ssh { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.metadata-card .muted { color: #6b7280; }
.metadata-card code { background: #0f1115; padding: 1px 4px; border-radius: 3px; }
.metadata-card .badge {
  font-size: 10px; padding: 1px 6px; border-radius: 10px; border: 1px solid #2d3139;
}
.metadata-card .badge--chain { color: #4ade80; border-color: #234d33; }
.metadata-card .badge--process { color: #facc15; border-color: #4d4423; }
.metadata-card__error { color: #f87171; margin-bottom: 8px; }
.metadata-card__footer { padding: 6px 10px; border-top: 1px solid #2d3139; }
.spin { display: inline-block; animation: metadata-spin 0.7s linear infinite; }
@keyframes metadata-spin { to { transform: rotate(360deg); } }
```

- [ ] **Step 8: Run component tests to verify they pass**

Run: `npm test -- src/components/MetadataCard.test.tsx 2>&1 | tail -25`
Expected: PASS (3 tests).

- [ ] **Step 9: Commit**

```bash
git add src/lib/metadata.ts src/state/metadataStore.ts src/state/metadataStore.test.ts src/components/MetadataCard.tsx src/components/MetadataCard.css src/components/MetadataCard.test.tsx
git commit -m "feat(metadata): frontend store + floating HUD card

lib wrapper + Zustand store (toggle/refresh, focus-resolved context,
no persistence) + draggable MetadataCard rendering git/ports/ssh with
empty states and a provenance badge. Store + component unit-tested.

Part of Phase 3E (Task 7)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 8: Wire toggle (⌘⇧L + menu) + mount + live verification

**Files:**
- Modify: `src/App.tsx` (mount card, ⌘⇧L shortcut, menu-event listener)
- Modify: `src-tauri/src/lib.rs` (menu item + accelerator)

**Interfaces:**
- Consumes: `useMetadataStore.toggle`; `useKeyboardShortcut`; existing Tauri menu-event channel.
- Produces: user-reachable feature (⌘⇧L + menu).

- [ ] **Step 1: Add the menu item + accelerator (Rust)**

In `src-tauri/src/lib.rs` `.setup()`, mirroring the drift menu pattern (~`:717`), add a menu item and submenu (or append to an existing logical menu). Example standalone "Pane" menu:
```rust
            let pane_metadata = MenuItem::with_id(app, "pane_metadata_toggle", "Toggle Metadata Card", true, Some("CmdOrCtrl+Shift+L"))?;
            let pane_menu = Submenu::with_items(app, "Pane", true, &[&pane_metadata])?;
```
Add `&pane_menu` to the top-level `Menu::with_items(...)` list alongside the other submenus. In the existing `app.on_menu_event(...)` handler, add an arm:
```rust
                "pane_metadata_toggle" => {
                    let _ = app_handle.emit("menu://pane_metadata_toggle", ());
                }
```
(Match the exact emit pattern used by neighboring menu items — some emit to a window, some via `app.emit`. Copy whichever the file already uses.)

- [ ] **Step 2: Mount the card + wire shortcut + menu listener (React)**

In `src/App.tsx`:
- Import: `import MetadataCard from './components/MetadataCard';` and `import { useMetadataStore } from './state/metadataStore';`
- Near the other `useKeyboardShortcut` calls (~`:148`):
```tsx
  const toggleMetadata = useMetadataStore((s) => s.toggle);
  useKeyboardShortcut('l', () => toggleMetadata(), { cmd: true, shift: true });
```
- With the other Tauri menu-event listeners (search for an existing `listen('menu://`), add:
```tsx
  useEffect(() => {
    const un = listen('menu://pane_metadata_toggle', () => toggleMetadata());
    return () => { void un.then((f) => f()); };
  }, [toggleMetadata]);
```
(Use the same `listen` import the file already uses from `@tauri-apps/api/event`.)
- Mount the card near the other unconditional overlays (e.g. by `<StateDrawer />` / `<DriftSidebar />`):
```tsx
      <MetadataCard />
```

- [ ] **Step 3: Build + typecheck + tests**

Run:
```bash
cd src-tauri && cargo build 2>&1 | grep -E "^error" | head
cd .. && npx tsc --noEmit 2>&1 | grep -c "error TS"
npm test -- src/state/metadataStore.test.ts src/components/MetadataCard.test.tsx 2>&1 | tail -10
```
Expected: cargo no errors; TS error count not above the existing baseline (check `git stash` baseline if unsure); vitest green.

- [ ] **Step 4: LIVE verification — git section**

1. `npm run tauri dev`
2. In a pane, `cd` into this repo.
3. Press ⌘⇧L. Expected: card appears top-right; **Git shows `main`**; make an edit (`echo x >> README.md`) → refresh (↻) → **dirty dot + `1 changed`**.
Record the actual rendered values.

- [ ] **Step 5: LIVE verification — ports section**

1. In a pane: `python3 -m http.server 8000`.
2. Click ↻ on the card. Expected: **Ports shows `:8000 python3`**.
3. Ctrl-C the server → refresh → **"No listening ports"**.
Record actual output.

- [ ] **Step 6: LIVE verification — SSH section (both paths)**

1. Connect a pane to a device via a session chain → refresh → **SSH shows host + `via chain`** badge (green).
2. In another pane, manually `ssh <user>@<host>` (ad-hoc) → refresh → **SSH shows host + `via process`** badge (yellow).
If the chain path shows nothing (e.g. the Step 3/Task 6 chain lookup was left as a `None` gap), note it explicitly; the process path is the must-pass.
Record actual output for both.

- [ ] **Step 7: LIVE verification — drag, toggle, focus-follow**

1. Drag the card by its header → **it moves and stays**.
2. ⌘⇧L off, ⌘⇧L on → **returns to default top-right corner** (no persistence).
3. With the card open, focus a different pane (different cwd/repo) → **card auto-updates** to the new pane's context.
Record results.

- [ ] **Step 8: Write the verification report**

Create `.git/sdd/phase-3e-metadata-sidebar-verification.md` capturing each live step's actual output (git values, port list, both SSH badges, drag/toggle/focus behavior) and any gaps (e.g. chain-SSH path).

- [ ] **Step 9: Commit**

```bash
git add src/App.tsx src-tauri/src/lib.rs .git/sdd/phase-3e-metadata-sidebar-verification.md
git commit -m "feat(metadata): wire ⌘⇧L toggle + menu, mount card, verify live

Pane menu item (CmdOrCtrl+Shift+L) + JS shortcut + menu-event listener;
MetadataCard mounted in App.tsx. Live-verified git/ports/ssh sections,
drag, toggle reset, and focus-follow.

Completes Phase 3E.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:**
- One aggregate `get_pane_metadata`, partial-failure tolerant → Task 6 ✅
- Git/ports/ssh gatherers in new `metadata/` module → Tasks 4, 5 ✅
- Chain-first, process-fallback SSH + provenance badge → Tasks 5 (parser/process), 6 (chain + precedence), 7 (badge) ✅
- Capture PTY pid; resolve by `terminal_id` → Tasks 1, 6 ✅
- Floating draggable HUD, ⌘⇧L + menu, no persistence → Tasks 7, 8 ✅
- Lazy refresh (open + focus-change + manual), no timer → Task 7 (toggle/refresh, focus `useEffect`) ✅
- Unit tests (git/proc/ssh/ports parsers, store, component) + live verification → Tasks 3–8 ✅
- No new deps / macOS-first / no migration → Global Constraints, honored throughout ✅

**Placeholder scan:** Two intentional discovery steps (Task 6 Step 3 chain helpers, Task 7 Step 3 pane accessors) exist because exact existing signatures must be read from the codebase, not guessed — each gives an explicit grep + a concrete fallback so the task never blocks. The `ssh_from_chain` body documents the precise wiring pattern. No silent TODOs in shipped code.

**Type consistency:** `PaneMetadata`/`GitInfo`/`PortInfo`/`SshInfo`/`SshSource` consistent across Rust (Task 2) and TS (`camelCase`, Task 7). `gather_git`/`gather_ports`/`gather_ssh_from_process`/`get_metadata`/`child_pids`/`parse_lsof_f`/`parse_ssh_argv` names consistent between definition and call sites. `get_pane_metadata(terminalId, cwd, tabId)` matches between command (Task 6) and wrapper (Task 7).

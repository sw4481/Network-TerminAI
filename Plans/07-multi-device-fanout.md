# 07 — Multi-Device Fan-Out (50 concurrent devices)

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an engineer select up to **50 concurrent devices** (SSH or NETCONF), type one command, and fan it out. The UI shows a merged block containing (a) per-device tabs, (b) a "Merged" view that tabular-diffs outputs via Plan 05's parse + diff engine and highlights outliers (the one device with BGP neighbor DOWN among 49 UP), (c) per-device progress bars, (d) individual cancel + retry controls, and (e) export of the full run as a zip bundle (merged markdown report + per-device text files). Fan-out runs are persisted so engineers can reopen historical runs.

**Architecture:**
- New Rust module `src-tauri/src/fanout/` owning a Tokio-based executor. A `tokio::sync::Semaphore` with 50 permits gates concurrency; each per-device task runs on its own `tokio::spawn`, resolves credentials from the existing `ssh_connections` / `netconf_devices` stores, opens a single-use session, issues the command, captures raw output, feeds it through `parsers::parse_show` (Plan 00 / 05), and emits structured progress events on the Tauri event bus.
- New tables `fanout_groups`, `fanout_group_members`, `fanout_runs`, `fanout_run_results` (migration **V0034**) persist group definitions, run history and per-device results. Raw output is written as a `command_block` (Plan 01) and referenced via `block_id`; parsed output references a `parsed_outputs.id` (Plan 05).
- New frontend area `src/features/fanout/` with `FanoutPanel`, `DeviceTabs`, `MergedTable` (reuses Plan 05 `DiffTable`), `OutlierBanner`, `ProgressLane`, `HistoryDrawer`, and a Zustand store `fanoutStore.ts` that listens to Tauri events.
- Export bundle is assembled in Rust using the `zip` crate into a user-chosen path; the markdown report embeds a per-column diff table and a per-device appendix.

**Tech Stack:** Rust (Tokio, rusqlite, `zip` crate, `csv` crate, `sha2`), Tauri 2 event bus, React 19, Zustand 5, `@tanstack/react-virtual` (reused from Plan 01), `@tanstack/react-table` (reused from Plan 05 for MergedTable). Test deps already present: `rcgen`, `axum`, `russh` fake server harnesses (see `src-tauri/tests/` patterns).

**Prerequisites:**
- Plan 00 Phase 2 complete (`parsers::parse_show` Tauri command + `parsers_cache`).
- Plan 01 Phase 1 complete (block model exposes tags — fan-out stores one block per device with shared `fanout:<run_id>` tag).
- Plan 05 Phase 2 complete (`parsed_outputs` table + `DiffTable` component + row-level diff engine reused for MergedTable).

**Downstream consumers:** Plan 06 (Pre/Post Verification) schedules snapshot commands through the fan-out executor; Plan 08 (Config Drift) uses fan-out groups as the "set of devices to audit"; Plan 15 (Troubleshooting tree) dispatches multi-device probes through the same pool.

**Non-goals (out-of-scope for this plan):**
- Config *push* fan-out (write operations) — explicitly read-only here. Write fan-out is gated on Plan 09 Guardrails and handled separately.
- Cross-tenant / team sharing of groups — deferred with Warp Drive.

---

## Phase 1 — Schema + group CRUD + device picker

Scope: define persistence, expose CRUD, give the user a way to build groups from their existing SSH and NETCONF device lists (and via CSV import). No executor yet.

### Task 1.1 — Migration V0034  `SEQUENTIAL`

**Files:**
- Create: `src-tauri/migrations/V0034__fanout_groups_runs.sql`

- [ ] **Step 1: Write migration**

```sql
-- V0034: Multi-device fan-out groups and runs.

CREATE TABLE IF NOT EXISTS fanout_groups (
  id          TEXT    PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  name        TEXT    NOT NULL UNIQUE,
  description TEXT,
  created_at  INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  updated_at  INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
CREATE INDEX IF NOT EXISTS idx_fanout_groups_name ON fanout_groups(name);

CREATE TABLE IF NOT EXISTS fanout_group_members (
  group_id    TEXT    NOT NULL REFERENCES fanout_groups(id) ON DELETE CASCADE,
  device_id   TEXT    NOT NULL,           -- string form; NETCONF ids are int-cast to text
  device_kind TEXT    NOT NULL CHECK (device_kind IN ('ssh','netconf')),
  added_at    INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  PRIMARY KEY (group_id, device_id, device_kind)
);
CREATE INDEX IF NOT EXISTS idx_fanout_members_device
  ON fanout_group_members(device_kind, device_id);

CREATE TABLE IF NOT EXISTS fanout_runs (
  id          TEXT    PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  group_id    TEXT    REFERENCES fanout_groups(id) ON DELETE SET NULL,
  command     TEXT    NOT NULL,
  started_at  INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  ended_at    INTEGER,
  status      TEXT    NOT NULL CHECK (status IN
                ('pending','running','success','partial','failed','cancelled')),
  params_json TEXT    NOT NULL DEFAULT '{}'   -- timeout_ms, concurrency, auth overrides
);
CREATE INDEX IF NOT EXISTS idx_fanout_runs_started ON fanout_runs(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_fanout_runs_group   ON fanout_runs(group_id, started_at DESC);

CREATE TABLE IF NOT EXISTS fanout_run_results (
  run_id            TEXT    NOT NULL REFERENCES fanout_runs(id) ON DELETE CASCADE,
  device_id         TEXT    NOT NULL,
  device_kind       TEXT    NOT NULL CHECK (device_kind IN ('ssh','netconf')),
  block_id          TEXT,                      -- references command_blocks(id) if present
  parsed_output_id  TEXT,                      -- references parsed_outputs(id) when parseable
  status            TEXT    NOT NULL CHECK (status IN
                      ('pending','running','success','failed','timeout','cancelled')),
  error             TEXT,
  started_at        INTEGER,
  ended_at          INTEGER,
  PRIMARY KEY (run_id, device_id, device_kind)
);
CREATE INDEX IF NOT EXISTS idx_fanout_results_status
  ON fanout_run_results(run_id, status);
```

Notes:
- `device_id` is `TEXT` because SSH uses UUID-hex ids and NETCONF uses autoincrement ints — we normalize to text.
- Foreign keys to `command_blocks.id` and `parsed_outputs.id` are intentionally *not* `REFERENCES` clauses (they may be deleted via tab GC; we null-read defensively in Rust).

- [ ] **Step 2: Apply + test**

```bash
cargo test --manifest-path src-tauri/Cargo.toml --lib db::tests::migrations_apply
```
Expected: all migrations apply; new tables appear in `sqlite_master`.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/migrations/V0034__fanout_groups_runs.sql
git commit -m "feat(db): V0034 fanout groups, members, runs, results"
```

### Task 1.2 — Rust module skeleton + group CRUD  `SEQUENTIAL` (depends on 1.1)

**Files:**
- Create: `src-tauri/src/fanout/mod.rs`
- Create: `src-tauri/src/fanout/model.rs`
- Create: `src-tauri/src/fanout/store.rs`
- Create: `src-tauri/src/commands/fanout.rs`
- Modify: `src-tauri/src/commands/mod.rs` — `pub mod fanout;`
- Modify: `src-tauri/src/lib.rs` — `mod fanout;` + register commands in `tauri::generate_handler![...]`
- Create: `src-tauri/tests/fanout_group_crud_test.rs`

- [ ] **Step 1: Define types in `fanout/model.rs`**

```rust
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DeviceKind { Ssh, Netconf }

impl DeviceKind {
    pub fn as_str(&self) -> &'static str {
        match self { DeviceKind::Ssh => "ssh", DeviceKind::Netconf => "netconf" }
    }
    pub fn parse(s: &str) -> Result<Self, String> {
        match s {
            "ssh" => Ok(DeviceKind::Ssh),
            "netconf" => Ok(DeviceKind::Netconf),
            other => Err(format!("unknown device_kind {other}")),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FanoutGroup {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub member_count: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FanoutMember {
    pub device_id: String,
    pub device_kind: DeviceKind,
    pub display_name: String,  // resolved from ssh_connections.name or netconf_devices.name
    pub host: String,
    pub added_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FanoutRunSummary {
    pub id: String,
    pub group_id: Option<String>,
    pub command: String,
    pub status: String,
    pub started_at: i64,
    pub ended_at: Option<i64>,
    pub total: i64,
    pub succeeded: i64,
    pub failed: i64,
}
```

- [ ] **Step 2: Write the failing CRUD test** (`tests/fanout_group_crud_test.rs`)

```rust
use ccie_terminal_lib::fanout::model::DeviceKind;
use ccie_terminal_lib::fanout::store::FanoutStore;

#[test]
fn group_crud_and_member_roundtrip() {
    let tmp = tempfile::NamedTempFile::new().unwrap();
    // Apply full migration set so FK targets exist.
    let conn = ccie_terminal_lib::db::open_and_migrate(tmp.path()).unwrap();
    let store = FanoutStore::new(conn);

    let g = store.create_group("site-atl-core", Some("atlanta core")).unwrap();
    assert!(store.list_groups().unwrap().iter().any(|x| x.id == g.id));

    // Seed one SSH and one NETCONF device via the store's existing helpers
    // (uses ssh_connections and netconf_devices directly).
    let ssh_id = store.seed_test_ssh("r1", "10.0.0.1").unwrap();
    let nc_id  = store.seed_test_netconf("r2", "10.0.0.2").unwrap();

    store.add_member(&g.id, &ssh_id, DeviceKind::Ssh).unwrap();
    store.add_member(&g.id, &nc_id, DeviceKind::Netconf).unwrap();
    let members = store.list_members(&g.id).unwrap();
    assert_eq!(members.len(), 2);
    assert!(members.iter().any(|m| m.device_kind == DeviceKind::Ssh));
    assert!(members.iter().any(|m| m.device_kind == DeviceKind::Netconf));

    store.remove_member(&g.id, &ssh_id, DeviceKind::Ssh).unwrap();
    assert_eq!(store.list_members(&g.id).unwrap().len(), 1);

    store.delete_group(&g.id).unwrap();
    assert!(store.list_groups().unwrap().is_empty());
}
```

- [ ] **Step 3: Run — expect FAIL** (`FanoutStore` not yet implemented).

```bash
cargo test --manifest-path src-tauri/Cargo.toml fanout_group_crud
```

- [ ] **Step 4: Implement `fanout/store.rs`**

Use rusqlite transactions on all multi-statement operations. For `list_members` join against `ssh_connections` when kind='ssh', `netconf_devices` when 'netconf' — use `UNION ALL` with a kind-tagged SELECT so a single query returns both and orders by `display_name`:

```rust
pub fn list_members(&self, group_id: &str) -> Result<Vec<FanoutMember>> {
    let sql = "
      SELECT m.device_id, m.device_kind, m.added_at,
             COALESCE(s.name, n.name) AS display_name,
             COALESCE(s.host, n.host) AS host
      FROM fanout_group_members m
      LEFT JOIN ssh_connections   s ON m.device_kind='ssh'     AND s.id = m.device_id
      LEFT JOIN netconf_devices   n ON m.device_kind='netconf' AND CAST(n.id AS TEXT) = m.device_id
      WHERE m.group_id = ?1
      ORDER BY display_name COLLATE NOCASE";
    // ... map rows ...
}
```

`list_groups` returns `member_count` via a correlated `(SELECT COUNT(*) FROM fanout_group_members WHERE group_id=g.id)`.

- [ ] **Step 5: Implement Tauri commands in `commands/fanout.rs`**

```rust
#[tauri::command]
pub fn fanout_group_create(name: String, description: Option<String>, state: State<'_, AppState>) -> Result<FanoutGroup, String> { ... }

#[tauri::command]
pub fn fanout_group_update(id: String, name: Option<String>, description: Option<String>, state: State<'_, AppState>) -> Result<FanoutGroup, String> { ... }

#[tauri::command]
pub fn fanout_group_delete(id: String, state: State<'_, AppState>) -> Result<(), String> { ... }

#[tauri::command]
pub fn fanout_group_list(state: State<'_, AppState>) -> Result<Vec<FanoutGroup>, String> { ... }

#[tauri::command]
pub fn fanout_member_add(group_id: String, device_id: String, device_kind: String, state: State<'_, AppState>) -> Result<(), String> { ... }

#[tauri::command]
pub fn fanout_member_add_bulk(group_id: String, members: Vec<(String, String)>, state: State<'_, AppState>) -> Result<usize, String> { ... }

#[tauri::command]
pub fn fanout_member_remove(group_id: String, device_id: String, device_kind: String, state: State<'_, AppState>) -> Result<(), String> { ... }

#[tauri::command]
pub fn fanout_member_list(group_id: String, state: State<'_, AppState>) -> Result<Vec<FanoutMember>, String> { ... }
```

- [ ] **Step 6: Register commands** in `lib.rs` under the existing `tauri::generate_handler![...]` macro. Do NOT re-invent the registration pattern — copy the style used by `ssh_*` commands.

- [ ] **Step 7: Run — expect PASS**

```bash
cargo test --manifest-path src-tauri/Cargo.toml fanout_group_crud
```

- [ ] **Step 8: Commit**

```bash
git add src-tauri/
git commit -m "feat(fanout): rust store + group/member CRUD commands"
```

### Task 1.3 — CSV import  `PARALLEL with 1.4`

**Files:**
- Modify: `src-tauri/src/commands/fanout.rs` — add `fanout_group_import_csv`
- Modify: `src-tauri/Cargo.toml` — add `csv = "1.3"` (check `cargo add --dry-run csv` first; prefer latest minor compatible with existing deps)
- Create: `src-tauri/tests/fanout_csv_import_test.rs`
- Create: `docs/fanout-csv-format.md`

CSV format (first row is header, required columns in this order):

```
device_kind,identifier
ssh,r1-atl-core
ssh,r2-atl-core
netconf,xe1-atl-dist
```

`identifier` can be either the saved connection **name** or **id**. Resolver tries id first (exact match), then name (case-insensitive). Rows that resolve to no device are returned in a warnings array, not a hard error.

- [ ] **Step 1: Write failing test** — import 5-line CSV, 1 row with bogus identifier. Expect 4 members added, 1 warning.

- [ ] **Step 2: Implement resolver + import**

Response type:
```rust
#[derive(Serialize)]
pub struct CsvImportResult {
    pub added: usize,
    pub warnings: Vec<String>,     // "line 3: no ssh device named 'r99-atl'"
}
```

- [ ] **Step 3: Write `docs/fanout-csv-format.md`** documenting the required header, allowed device_kinds, and resolver precedence.

- [ ] **Step 4: Run — expect PASS.**

- [ ] **Step 5: Commit**

```bash
git add src-tauri/ docs/fanout-csv-format.md
git commit -m "feat(fanout): CSV import with name-or-id resolver and warnings"
```

### Task 1.4 — Frontend store + device picker UI  `PARALLEL with 1.3`

**Files:**
- Create: `src/features/fanout/fanoutStore.ts`
- Create: `src/features/fanout/FanoutGroupsPanel.tsx` + `.css`
- Create: `src/features/fanout/DevicePickerDialog.tsx` + `.css`
- Create: `src/features/fanout/fanoutStore.test.ts`
- Create: `src/features/fanout/FanoutGroupsPanel.test.tsx`

- [ ] **Step 1: Dispatch `frontend-design` skill** pre-impl:
  > "Design a two-pane group manager for our CCIE Terminal. Left pane: list of saved groups with member counts. Right pane: group editor with a device picker showing saved SSH connections (from `ssh_connections`) and NETCONF devices (`netconf_devices`) in a unified, filterable table. Show device kind as a tagged badge. Include a CSV import button and a 'Select all filtered' action. macOS-native feel. Reuse palette from `src/App.css` and the existing chip component style used in `CommandBlock.css`. Deliver: ASCII wireframe + CSS class names per region."

  Save returned spec to `docs/design/fanout-group-picker.md` and commit.

- [ ] **Step 2: Write failing store test**

```ts
import { describe, it, expect, vi } from "vitest";
import { useFanoutStore } from "./fanoutStore";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args: any) => {
    if (cmd === "fanout_group_list") return [];
    if (cmd === "fanout_group_create") return { id: "g1", name: args.name, member_count: 0 };
    throw new Error(`unexpected ${cmd}`);
  }),
}));

describe("fanoutStore", () => {
  it("creates a group and keeps it in state", async () => {
    const { createGroup, groups } = useFanoutStore.getState();
    await createGroup("site-atl", null);
    expect(useFanoutStore.getState().groups.some(g => g.name === "site-atl")).toBe(true);
  });
});
```

- [ ] **Step 3: Implement `fanoutStore.ts`**

```ts
import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";

export type DeviceKind = "ssh" | "netconf";
export interface FanoutGroup { id: string; name: string; description: string | null; member_count: number; created_at: number; updated_at: number; }
export interface FanoutMember { device_id: string; device_kind: DeviceKind; display_name: string; host: string; added_at: number; }

interface State {
  groups: FanoutGroup[];
  membersByGroup: Record<string, FanoutMember[]>;
  loading: boolean;
  error: string | null;
  refreshGroups: () => Promise<void>;
  refreshMembers: (groupId: string) => Promise<void>;
  createGroup: (name: string, description: string | null) => Promise<FanoutGroup>;
  updateGroup: (id: string, patch: { name?: string; description?: string | null }) => Promise<void>;
  deleteGroup: (id: string) => Promise<void>;
  addMember: (groupId: string, deviceId: string, kind: DeviceKind) => Promise<void>;
  addMembersBulk: (groupId: string, members: Array<{ deviceId: string; kind: DeviceKind }>) => Promise<number>;
  removeMember: (groupId: string, deviceId: string, kind: DeviceKind) => Promise<void>;
  importCsv: (groupId: string, csvText: string) => Promise<{ added: number; warnings: string[] }>;
}
// ...implementation with invoke + optimistic updates for member changes...
```

- [ ] **Step 4: Implement `FanoutGroupsPanel.tsx`** per the design spec.

- [ ] **Step 5: Implement `DevicePickerDialog.tsx`** — fetches SSH connections (`ssh_list_connections`) + NETCONF devices (`netconf_device_list`), unifies them into a single filterable list with kind badges. Multi-select with a "Select all filtered" button that enforces the 50-device cap with a banner when exceeded.

- [ ] **Step 6: Write component tests** (render, select/deselect, bulk select cap warning).

- [ ] **Step 7: Post-impl design review** — capture screenshot, dispatch `frontend-design` skill for feedback, apply fixes.

- [ ] **Step 8: Commit**

```bash
git add src/features/fanout/ docs/design/fanout-group-picker.md
git commit -m "feat(fanout): group manager + device picker UI"
```

### Task 1.5 — Phase 1 regression  `SEQUENTIAL`

- [ ] **Step 1:** `cd sidecar && python -m pytest -v` (no changes expected, just regression).
- [ ] **Step 2:** `bun run test` — all green.
- [ ] **Step 3:** `cargo test --manifest-path src-tauri/Cargo.toml` — all green.
- [ ] **Step 4:** `bunx playwright test --grep @smoke` — all green.
- [ ] **Step 5: Dispatch `feature-dev:code-reviewer`** over phase diff with prompt:
  > "Review Phase 1 of Plan 07 (`/Plans/07-multi-device-fanout.md`). Focus: migration correctness, Rust store transactional safety, CSV resolver edge cases, frontend store optimistic-update consistency. Report `must-fix` vs. `nits`."
- [ ] **Step 6: Update plan file — check all Phase 1 boxes + append**

```markdown
## Phase 1 — COMPLETED YYYY-MM-DD
Schema V0034 applied; group/member CRUD + CSV import live; device picker UI merged with saved SSH and NETCONF lists; 50-cap enforced at UI.
```

- [ ] **Step 7: Commit plan update.**

```bash
git add Plans/07-multi-device-fanout.md
git commit -m "docs(plans): Plan 07 Phase 1 complete"
```

---

## Phase 2 — Tokio fan-out executor + event bus

Scope: the engine. No UI surfaces beyond the event bus definitions. Output lands in `command_blocks` + `parsed_outputs` + `fanout_run_results`. Stress-tested against 50 mocked devices.

### Task 2.1 — Executor core  `SEQUENTIAL`

**Files:**
- Create: `src-tauri/src/fanout/executor.rs`
- Create: `src-tauri/src/fanout/events.rs`
- Create: `src-tauri/src/fanout/worker.rs`
- Create: `src-tauri/src/fanout/auth.rs`
- Create: `src-tauri/tests/fanout_executor_test.rs`

- [ ] **Step 1: Define event payload types in `events.rs`**

These are the *only* shapes frontend code subscribes to; changing them is a breaking change.

```rust
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum FanoutEvent {
    RunStarted { run_id: String, total: usize, command: String, group_id: Option<String> },
    DeviceQueued { run_id: String, device_id: String, device_kind: String, display_name: String },
    DeviceStarted { run_id: String, device_id: String, device_kind: String },
    DeviceProgress { run_id: String, device_id: String, device_kind: String, bytes: u64 },
    DeviceSucceeded { run_id: String, device_id: String, device_kind: String, block_id: String, parsed_output_id: Option<String>, duration_ms: u64 },
    DeviceFailed { run_id: String, device_id: String, device_kind: String, error: String, duration_ms: u64, kind: FailureKind },
    DeviceCancelled { run_id: String, device_id: String, device_kind: String },
    RunCompleted { run_id: String, succeeded: usize, failed: usize, cancelled: usize, duration_ms: u64 },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum FailureKind { Timeout, Auth, Connect, Protocol, Parse, Other }
```

Tauri event channel name: `"fanout://event"`. Frontend binds via `listen<FanoutEvent>("fanout://event", ...)`.

- [ ] **Step 2: Write the failing executor test**

Mock devices via in-memory handlers that implement the same trait the real runners use. The executor must never call real networking in tests.

```rust
use ccie_terminal_lib::fanout::executor::{Executor, ExecuteArgs};
use ccie_terminal_lib::fanout::worker::{DeviceWorker, WorkerOutcome};
use std::time::Duration;

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn executor_fans_out_50_and_respects_semaphore() {
    let mock = MockWorkerFactory::with_delay(Duration::from_millis(100));
    let ex = Executor::new_with_factory(test_db_pool(), mock.clone(), 50);
    let members = (0..50).map(|i| member(format!("d{i}"))).collect::<Vec<_>>();
    let args = ExecuteArgs { command: "show version".into(), group_id: None, members, timeout_ms: 30_000, concurrency: 50 };

    let run_id = ex.spawn_run(args).await.unwrap();
    let outcome = ex.await_run(&run_id).await.unwrap();
    assert_eq!(outcome.succeeded, 50);
    assert_eq!(outcome.failed, 0);
    // p95 total time must be < 2× single-device time
    assert!(outcome.duration_ms < 200, "expected <200ms, got {}", outcome.duration_ms);
    // Peak concurrent worker count must equal 50 (not 51, not 25).
    assert_eq!(mock.peak_concurrency(), 50);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn executor_enforces_per_device_timeout() {
    let mock = MockWorkerFactory::with_delay(Duration::from_millis(5_000));
    let ex = Executor::new_with_factory(test_db_pool(), mock, 10);
    let members = (0..10).map(|i| member(format!("d{i}"))).collect::<Vec<_>>();
    let args = ExecuteArgs { command: "show run".into(), group_id: None, members, timeout_ms: 100, concurrency: 10 };
    let run_id = ex.spawn_run(args).await.unwrap();
    let outcome = ex.await_run(&run_id).await.unwrap();
    assert_eq!(outcome.succeeded, 0);
    assert_eq!(outcome.failed, 10);
    // Every failure must be classified as Timeout.
    assert!(outcome.failures.iter().all(|f| matches!(f.kind, FailureKind::Timeout)));
}
```

- [ ] **Step 3: Implement `auth.rs`**

Resolve credentials by `device_kind` + `device_id`:
- `ssh`: `SELECT host, user, port, identity_file, password_encrypted FROM ssh_connections WHERE id=?`, then `ssh_decrypt_password` (reuse `commands::ssh::decrypt_password`).
- `netconf`: `SELECT host, port, username, platform, hostkey_verify FROM netconf_devices WHERE id=?`. Password resolution follows the existing NETCONF flow (prompt if missing — in fan-out we fail fast with `FailureKind::Auth` instead of prompting; the UI must collect missing passwords BEFORE spawning the run).

Expose:
```rust
pub enum DeviceCreds {
    Ssh { host: String, port: u16, user: String, identity: Option<PathBuf>, password: Option<String> },
    Netconf { host: String, port: u16, user: String, password: String, platform: String, hostkey_verify: bool },
}
pub fn resolve_creds(conn: &rusqlite::Connection, kind: DeviceKind, id: &str) -> Result<DeviceCreds, FailureKind>;
```

- [ ] **Step 4: Implement `worker.rs`**

Trait + two real impls + a mock factory for tests.

```rust
#[async_trait::async_trait]
pub trait DeviceWorker: Send + Sync {
    async fn run(&self, command: &str, timeout: Duration) -> Result<WorkerOutcome, WorkerError>;
}

pub struct WorkerOutcome {
    pub raw_output: String,
    pub duration_ms: u64,
}

pub enum WorkerError {
    Timeout,
    Auth(String),
    Connect(String),
    Protocol(String),
    Other(String),
}
```

- `SshWorker`: wraps existing russh flow used by `commands/ssh.rs`. A single-use session: open → authenticate → `exec` the command → collect stdout/stderr → close. This is a *read-only* exec channel; no PTY.
- `NetconfWorker`: if `command` starts with `<rpc`, send raw XML through `netconf_runner::session::Session::send_rpc`. Otherwise translate vendor-native `show` into a `<get>` with a filter using the existing `netconf_runner` helpers. If no helper exists, fail with `WorkerError::Protocol("netconf worker requires raw <rpc> payload")` — do NOT guess.

- [ ] **Step 5: Implement `executor.rs`**

```rust
pub struct Executor {
    db: DbPool,
    factory: Arc<dyn WorkerFactory>,
    semaphore: Arc<Semaphore>,
    runs: DashMap<String, RunHandle>,
    app: tauri::AppHandle,
}

impl Executor {
    pub async fn spawn_run(&self, args: ExecuteArgs) -> Result<String, ExecError> {
        let run_id = insert_run_row(&self.db, &args).await?;
        self.emit(FanoutEvent::RunStarted { run_id: run_id.clone(), total: args.members.len(), command: args.command.clone(), group_id: args.group_id.clone() });

        let cancel = CancellationToken::new();
        let per_device_cancels: DashMap<String, CancellationToken> = DashMap::new();
        for m in &args.members {
            per_device_cancels.insert(member_key(m), cancel.child_token());
            insert_pending_result(&self.db, &run_id, m).await?;
            self.emit(FanoutEvent::DeviceQueued { /* ... */ });
        }

        let handle = tokio::spawn(self.clone().drive(run_id.clone(), args, cancel.clone(), per_device_cancels));
        self.runs.insert(run_id.clone(), RunHandle { handle, cancel });
        Ok(run_id)
    }

    async fn drive(self, run_id: String, args: ExecuteArgs, run_cancel: CancellationToken, per_device: DashMap<String, CancellationToken>) {
        let started = Instant::now();
        let mut set = JoinSet::new();
        for member in args.members {
            let permit = self.semaphore.clone().acquire_owned().await.expect("semaphore closed");
            let child_cancel = per_device.get(&member_key(&member)).unwrap().clone();
            let this = self.clone();
            let run_id = run_id.clone();
            let cmd = args.command.clone();
            let to = Duration::from_millis(args.timeout_ms);
            set.spawn(async move {
                let _permit = permit;
                this.run_one(&run_id, member, cmd, to, child_cancel).await
            });
            if run_cancel.is_cancelled() { break; }
        }
        let mut succeeded = 0; let mut failed = 0; let mut cancelled = 0;
        while let Some(res) = set.join_next().await {
            match res { Ok(Ok(())) => succeeded += 1, Ok(Err(Classification::Cancelled)) => cancelled += 1, _ => failed += 1 }
        }
        finalize_run_row(&self.db, &run_id, succeeded, failed, cancelled).await.ok();
        self.emit(FanoutEvent::RunCompleted { run_id, succeeded, failed, cancelled, duration_ms: started.elapsed().as_millis() as u64 });
    }

    async fn run_one(&self, run_id: &str, member: MemberRef, command: String, timeout: Duration, cancel: CancellationToken) -> Result<(), Classification> {
        self.emit(FanoutEvent::DeviceStarted { /* ... */ });
        let creds = auth::resolve_creds(&self.db.conn(), member.kind, &member.id).map_err(fail_auth)?;
        let worker = self.factory.create(member.kind, creds);
        let fut = worker.run(&command, timeout);
        tokio::select! {
            _ = cancel.cancelled() => { /* emit Cancelled, update row */ Err(Classification::Cancelled) }
            out = fut => match out {
                Ok(outcome) => {
                    let block_id = write_block(&self.db, run_id, &member, &command, &outcome.raw_output).await?;
                    let parsed = try_parse(&self.db, &member, &command, &outcome.raw_output).await; // Plan 05 best-effort
                    finalize_result_success(&self.db, run_id, &member, &block_id, parsed.as_ref()).await?;
                    self.emit(FanoutEvent::DeviceSucceeded { /* ... */ });
                    Ok(())
                }
                Err(WorkerError::Timeout) => { /* emit Failed(Timeout) */ Err(Classification::Timeout) }
                Err(e) => { /* emit Failed with classified kind */ Err(Classification::Other) }
            }
        }
    }

    pub async fn cancel_device(&self, run_id: &str, device_id: &str, kind: DeviceKind) -> Result<(), ExecError> { ... }
    pub async fn cancel_run(&self, run_id: &str) -> Result<(), ExecError> { ... }
    pub async fn await_run(&self, run_id: &str) -> Result<RunOutcome, ExecError> { ... }
}
```

Key requirements verified by tests:
- Permits are dropped *after* DB writes and event emission so the semaphore truly caps work-in-flight.
- A run with 0 members immediately emits `RunCompleted { total: 0 }`.
- Cancellation must propagate within ≤250ms of the cancel call (measured by a test with a 10s mock worker).

- [ ] **Step 6: Add new crate deps** to `src-tauri/Cargo.toml`:

```toml
async-trait = "0.1"
dashmap = "6"
tokio-util = { version = "0.7", features = ["rt"] }   # CancellationToken
```

- [ ] **Step 7: Run — expect PASS**

```bash
cargo test --manifest-path src-tauri/Cargo.toml fanout_executor
```

- [ ] **Step 8: Commit**

```bash
git add src-tauri/
git commit -m "feat(fanout): tokio executor with semaphore, per-device timeout, cancellation"
```

### Task 2.2 — Persistence + parse integration  `SEQUENTIAL` (depends on 2.1)

**Files:**
- Modify: `src-tauri/src/fanout/executor.rs`
- Modify: `src-tauri/src/fanout/store.rs`
- Create: `src-tauri/tests/fanout_persistence_test.rs`

- [ ] **Step 1: Write failing test** — after a successful run of 3 mock devices, the DB must contain:
  - 1 row in `fanout_runs` with `status='success'`, `ended_at` set.
  - 3 rows in `fanout_run_results`, all `status='success'`, each with a non-null `block_id`.
  - 3 rows in `command_blocks`, each tagged `fanout:<run_id>` via `block_tags` (Plan 01).
  - For a command matched by Plan 05 parsers (`show version` with IOS-XE), `parsed_output_id` is non-null.

- [ ] **Step 2: Implement DB writes** inside `run_one`:
  1. Insert a row in `command_blocks` (re-use existing insert helper; capture returned id).
  2. Upsert a tag `fanout:<run_id>` via `block_tag_add` (Plan 01).
  3. Invoke `parsers::parse_show` via the in-process bridge (not Tauri command dispatch) to avoid a round-trip. On success, insert a `parsed_outputs` row (Plan 05 helper) and capture id.
  4. Update `fanout_run_results` with `status='success'`, `block_id`, `parsed_output_id`, `ended_at`.
  5. When ALL result rows are terminal, update `fanout_runs.status` to one of `'success'` (all succeeded), `'partial'` (mix), `'failed'` (all failed), `'cancelled'` (all cancelled).

- [ ] **Step 3: Handle parse failures gracefully** — a parse failure does NOT fail the device; it sets `parsed_output_id=NULL` and raw output is still available.

- [ ] **Step 4: Run — expect PASS.**

- [ ] **Step 5: Commit**

```bash
git add src-tauri/
git commit -m "feat(fanout): persist results as blocks + parsed_outputs + run status rollup"
```

### Task 2.3 — Tauri command surface + event bus  `PARALLEL with 2.4`

**Files:**
- Modify: `src-tauri/src/commands/fanout.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Add commands**

```rust
#[tauri::command]
pub async fn fanout_run_start(
    command: String,
    group_id: Option<String>,
    member_overrides: Option<Vec<MemberRef>>,  // ad-hoc run without a saved group
    timeout_ms: Option<u64>,
    concurrency: Option<usize>,
    state: State<'_, AppState>,
) -> Result<String, String> { ... }   // returns run_id

#[tauri::command]
pub async fn fanout_run_cancel(run_id: String, state: State<'_, AppState>) -> Result<(), String> { ... }

#[tauri::command]
pub async fn fanout_device_cancel(run_id: String, device_id: String, device_kind: String, state: State<'_, AppState>) -> Result<(), String> { ... }

#[tauri::command]
pub async fn fanout_device_retry(run_id: String, device_id: String, device_kind: String, state: State<'_, AppState>) -> Result<(), String> { ... }

#[tauri::command]
pub fn fanout_run_get(run_id: String, state: State<'_, AppState>) -> Result<FanoutRunDetail, String> { ... }

#[tauri::command]
pub fn fanout_run_list(limit: Option<i64>, state: State<'_, AppState>) -> Result<Vec<FanoutRunSummary>, String> { ... }
```

- [ ] **Step 2:** `timeout_ms` default = 30_000 (30s). `concurrency` default = 50, hard-capped server-side at 50.

- [ ] **Step 3: Register in `lib.rs`** alongside Phase 1 commands.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/
git commit -m "feat(fanout): Tauri commands for start/cancel/retry/list"
```

### Task 2.4 — Stress test: 50 mocked devices  `PARALLEL with 2.3`

**Files:**
- Create: `src-tauri/tests/fanout_stress_test.rs`

- [ ] **Step 1: Test — p95 across 20 runs < 2× single-device time**

```rust
#[tokio::test(flavor = "multi_thread", worker_threads = 8)]
async fn fanout_p95_under_2x_single() {
    const DELAY_MS: u64 = 150;
    const RUNS: usize = 20;
    let mut samples = Vec::with_capacity(RUNS);
    for _ in 0..RUNS {
        let ex = new_test_executor_with_mock_delay(DELAY_MS).await;
        let args = ExecuteArgs { command: "show version".into(), group_id: None, members: fifty_mock_members(), timeout_ms: 30_000, concurrency: 50 };
        let run_id = ex.spawn_run(args).await.unwrap();
        let outcome = ex.await_run(&run_id).await.unwrap();
        samples.push(outcome.duration_ms);
    }
    samples.sort_unstable();
    let p95 = samples[(RUNS as f64 * 0.95) as usize - 1];
    assert!(p95 < (2 * DELAY_MS), "p95={}ms exceeds 2x single-device={}ms", p95, 2 * DELAY_MS);
}
```

- [ ] **Step 2: Test — semaphore really caps at 50**

Use a mock factory that atomically increments a shared `AtomicUsize` on enter and decrements on exit, and records peak. Fire a run of 120 members and assert `peak <= 50`.

- [ ] **Step 3: Test — backpressure yields, does not starve**

Run 200 members with `concurrency=50`. Assert all 200 complete and that each device waited at most `ceil(200/50) * DELAY_MS` milliseconds plus slack.

- [ ] **Step 4: Run — expect PASS.**

```bash
cargo test --manifest-path src-tauri/Cargo.toml fanout_stress -- --test-threads=1
```
(use `--test-threads=1` so stress tests don't compete with each other for scheduler time)

- [ ] **Step 5: Commit**

```bash
git add src-tauri/tests/fanout_stress_test.rs
git commit -m "test(fanout): 50-device p95 + semaphore cap + backpressure stress"
```

### Task 2.5 — Phase 2 regression  `SEQUENTIAL`

- [ ] **Step 1:** `bun run test` — green.
- [ ] **Step 2:** `cargo test --manifest-path src-tauri/Cargo.toml` — green (stress tests included).
- [ ] **Step 3:** `bunx playwright test --grep @smoke` — green.
- [ ] **Step 4: Dispatch `feature-dev:code-reviewer`** over phase diff:
  > "Review Phase 2 of Plan 07. Focus: executor correctness (semaphore drop ordering, cancellation propagation, permit leaks), timeout enforcement via tokio::select!, event-bus type stability, parser integration failure modes. Report `must-fix` vs. `nits`."
- [ ] **Step 5: Update plan — check Phase 2 boxes + completion block.**
- [ ] **Step 6: Commit plan.**

---

## Phase 3 — UI: fan-out panel + per-device tabs + merged diff view

Scope: ship the end-to-end interactive surface. Uses Plan 05's `DiffTable` + row-diff engine; this plan does NOT re-implement diffing.

### Task 3.1 — Pre-impl design review  `SEQUENTIAL`

- [ ] **Step 1: Dispatch `frontend-design` skill** with brief:
  > "Design the 'Multi-Device Fan-Out' panel for CCIE Terminal (macOS Tauri app). It opens in a new block within an SSH or NETCONF tab. Components needed:
  > - Command bar at top: group selector + ad-hoc 'pick devices' + command input + 'Run' button + timeout input.
  > - Progress lane: one horizontal strip per device showing status chip (queued/running/success/failed/timeout/cancelled), per-device progress bar, device display_name, elapsed time, inline cancel and retry icons.
  > - Main view: tab bar with one tab per device + a leading 'Merged' tab. Each device tab shows raw output (monospace, virtualized). 'Merged' tab shows the diff table.
  > - Outlier banner: above the Merged table, show 'Outliers detected: 1 device has <column>=<value> while 49 share <value>' when row-diff detects minority values. Click-to-focus a device tab.
  > - History drawer handle on right side to reopen previous runs.
  > Constraints: reuse `DiffTable` from Plan 05. Follow the Warp-inspired palette already in `src/App.css` and the chip/badge style from `CommandBlock.css`. Deliver an ASCII wireframe plus all required Tailwind/CSS class names."

- [ ] **Step 2: Save returned spec to** `docs/design/fanout-panel.md` and commit.

### Task 3.2 — Event subscription + run state  `SEQUENTIAL` (depends on 3.1)

**Files:**
- Modify: `src/features/fanout/fanoutStore.ts`
- Create: `src/features/fanout/useFanoutEvents.ts`
- Create: `src/features/fanout/useFanoutEvents.test.ts`

- [ ] **Step 1: Extend store state**

```ts
export type DeviceStatus = "pending"|"running"|"success"|"failed"|"timeout"|"cancelled";
export interface DeviceRunState {
  deviceId: string;
  deviceKind: DeviceKind;
  displayName: string;
  status: DeviceStatus;
  progressBytes: number;
  durationMs?: number;
  errorMessage?: string;
  blockId?: string;
  parsedOutputId?: string;
}
export interface ActiveRun {
  runId: string;
  command: string;
  groupId: string | null;
  startedAt: number;
  endedAt?: number;
  status: "running"|"success"|"partial"|"failed"|"cancelled";
  devices: Record<string, DeviceRunState>;   // key = `${kind}:${id}`
}
```

Add `activeRunsById: Record<string, ActiveRun>` and pure reducers for each event variant.

- [ ] **Step 2: Write failing event-application tests** — feed a scripted stream of `RunStarted` → `DeviceStarted` → `DeviceSucceeded` ×N → `RunCompleted` and assert final store shape. Include out-of-order events (e.g. `DeviceSucceeded` before `DeviceStarted`) and confirm idempotent merge.

- [ ] **Step 3: Implement `useFanoutEvents` hook** — subscribes on mount via `listen("fanout://event", ...)`, dispatches to the store, unsubscribes on unmount. Guard against double-subscription in React 19 Strict Mode.

- [ ] **Step 4: Commit** `feat(fanout): event subscription + run state reducers`

### Task 3.3 — `FanoutPanel` + `DeviceTabs` + `ProgressLane`  `PARALLEL with 3.4`

**Files:**
- Create: `src/features/fanout/FanoutPanel.tsx` + `.css`
- Create: `src/features/fanout/DeviceTabs.tsx` + `.css`
- Create: `src/features/fanout/ProgressLane.tsx` + `.css`
- Create: `src/features/fanout/FanoutPanel.test.tsx`

- [ ] **Step 1: Write failing render tests** — mount with a scripted store, assert progress lane shows 3 devices, tab bar shows 'Merged' + 3 device tabs, clicking a tab updates active view.

- [ ] **Step 2: Implement per the design spec.** Virtualize the per-device raw-output viewer with `@tanstack/react-virtual` (already installed by Plan 01).

- [ ] **Step 3: Commit** `feat(fanout): panel + device tabs + progress lane`

### Task 3.4 — `MergedTable` + outlier detection  `PARALLEL with 3.3`

**Files:**
- Create: `src/features/fanout/MergedTable.tsx` + `.css`
- Create: `src/features/fanout/outliers.ts`
- Create: `src/features/fanout/outliers.test.ts`
- Create: `src/features/fanout/OutlierBanner.tsx` + `.css`

- [ ] **Step 1: Write failing outlier tests**

```ts
import { detectOutliers } from "./outliers";

// Minority-value detection: one device out of many differs on a column.
test("detects single outlier in 50-device BGP parsed output", () => {
  const rows = Array.from({ length: 50 }, (_, i) => ({
    deviceKey: `ssh:r${i}`,
    columns: { neighbor: "10.0.0.1", state: i === 37 ? "Idle" : "Established" },
  }));
  const outliers = detectOutliers(rows, { keyColumn: "neighbor" });
  expect(outliers).toEqual([
    { deviceKey: "ssh:r37", column: "state", value: "Idle", majorityValue: "Established", minoritySize: 1, majoritySize: 49 },
  ]);
});

// No outlier when majority share is below threshold.
test("does not flag columns without a clear majority (>=75%)", () => {
  const rows = [/* 50/50 split on a column */];
  expect(detectOutliers(rows, { keyColumn: "neighbor", majorityThreshold: 0.75 })).toEqual([]);
});
```

- [ ] **Step 2: Implement `detectOutliers`** with the contract:
  - Input: array of `{ deviceKey, columns: Record<string,string> }`.
  - Group rows by `keyColumn`. Within each group, for each other column, compute value frequencies. If one value has share ≥ `majorityThreshold` (default 0.75) AND minority share ≤ 0.10, flag every device not matching the majority value.
  - Return sorted by `(column, minoritySize ASC, deviceKey ASC)` for stable rendering.

- [ ] **Step 3: `MergedTable`** — consume parsed outputs from each device's `parsed_outputs` row, hand them to Plan 05's `DiffTable`. When all devices return a `list`-shaped parser result (e.g. TextFSM for `show ip bgp summary`), render tabular; otherwise fall back to key-value mode. Highlight outlier cells in red with a tooltip showing majority/minority counts.

- [ ] **Step 4: `OutlierBanner`** — renders `detectOutliers` results above the table. Click-through focuses the offending device's tab.

- [ ] **Step 5: Commit** `feat(fanout): merged diff table + minority-value outlier detection`

### Task 3.5 — Post-impl design review + Phase 3 regression  `SEQUENTIAL`

- [ ] **Step 1:** `bun run tauri dev`, seed a run with 5 mock devices (one with a BGP neighbor forced to Idle via fixture), capture screenshots.
- [ ] **Step 2: Dispatch `frontend-design` skill** with screenshots for post-impl review. Apply fixes.
- [ ] **Step 3:** Full regression (`bun run test`, `cargo test`, `bunx playwright test`).
- [ ] **Step 4: Dispatch `feature-dev:code-reviewer`.**
- [ ] **Step 5: Update plan — check Phase 3 boxes + completion block.**
- [ ] **Step 6: Commit plan.**

---

## Phase 4 — Cancel / retry / resume + history browser

Scope: wire cancel/retry into the UI, enable reopening historical runs, support resume of interrupted runs (app crash mid-fanout).

### Task 4.1 — Cancel / retry UX  `PARALLEL with 4.2`

**Files:**
- Modify: `src/features/fanout/ProgressLane.tsx`
- Modify: `src/features/fanout/FanoutPanel.tsx`
- Create: `src/features/fanout/ProgressLane.cancel.test.tsx`

- [ ] **Step 1: Wire inline cancel** on each progress strip → `fanout_device_cancel`.
- [ ] **Step 2: Wire retry** → `fanout_device_retry` (only enabled for `failed|timeout|cancelled`).
- [ ] **Step 3: Wire "Cancel all remaining"** button on panel header → `fanout_run_cancel`.
- [ ] **Step 4: Write failing tests** verifying:
  - Cancel button disabled when device status is terminal.
  - Retry reuses the same `run_id` and adds a fresh attempt row in `fanout_run_results` (see Task 4.3 migration).
- [ ] **Step 5: Implement.**
- [ ] **Step 6: Commit** `feat(fanout): inline cancel + retry controls`

### Task 4.2 — History drawer + reopen  `PARALLEL with 4.1`

**Files:**
- Create: `src/features/fanout/HistoryDrawer.tsx` + `.css`
- Create: `src/features/fanout/HistoryDrawer.test.tsx`

- [ ] **Step 1: Failing test** — `fanout_run_list(limit=50)` returns N summaries; drawer renders them newest-first; clicking reopens the run via `fanout_run_get`, re-hydrates `ActiveRun` from persisted rows (status = already terminal).

- [ ] **Step 2: Implement `fanout_run_get`** in Rust to return `FanoutRunDetail`:
  ```rust
  pub struct FanoutRunDetail {
      pub summary: FanoutRunSummary,
      pub devices: Vec<DeviceResultRow>,
  }
  pub struct DeviceResultRow {
      pub device_id: String,
      pub device_kind: DeviceKind,
      pub display_name: String,
      pub status: String,
      pub error: Option<String>,
      pub block_id: Option<String>,
      pub parsed_output_id: Option<String>,
      pub started_at: Option<i64>,
      pub ended_at: Option<i64>,
  }
  ```

- [ ] **Step 3: Implement drawer UI.**

- [ ] **Step 4: Commit** `feat(fanout): history drawer with reopen`

### Task 4.3 — Retry attempts + resume  `SEQUENTIAL` (depends on 4.1)

**Files:**
- Create: `src-tauri/migrations/V0034b__fanout_attempts.sql` (same migration-number family, suffix-per-SQL)
- Modify: `src-tauri/src/fanout/store.rs`
- Modify: `src-tauri/src/fanout/executor.rs`

> **Migration-numbering note.** Refinery V0034 is a single file. Because suffix-families are unsupported, instead we extend V0034 directly. Update Task 1.1 to include the attempt_number column from the start OR introduce this as **V0043** (post-reservation). **Decision:** Extend V0034 to include `attempt_number` at Phase 1 time. Revise Task 1.1 Step 1 before executing if Phase 1 has not yet been completed; if it has been completed, claim V0043 here.

- [ ] **Step 1: Decide path** — inspect whether Phase 1 has shipped. If yes, use V0043; if no, add `attempt_number INTEGER NOT NULL DEFAULT 1` to the V0034 schema for `fanout_run_results` and change the PK to `(run_id, device_id, device_kind, attempt_number)`.

- [ ] **Step 2: Implement retry**

On `fanout_device_retry(run_id, device_id, kind)`:
1. Read current terminal attempt.
2. Insert a new `fanout_run_results` row with `attempt_number = max(attempt)+1`, `status='pending'`.
3. Spawn a single worker task under the run's executor handle, reusing the semaphore.
4. Emit events with an `attempt` field appended (extend `FanoutEvent` accordingly — this is a breaking change to the event schema, note in changelog).

- [ ] **Step 3: Implement resume on app startup**

At app init, scan for `fanout_runs` rows with `status='running'` and no `ended_at`. Mark each as `status='failed'` with a synthesized per-device error for `pending`/`running` results: `"interrupted: app restart"`. This avoids zombie runs without re-establishing real sessions (read-only — a failed run is recoverable via retry).

- [ ] **Step 4: Test resume** — seed DB with an in-progress run, launch app, confirm cleanup. Use the existing app-init test harness.

- [ ] **Step 5: Commit** `feat(fanout): retry attempts + orphan-run cleanup on startup`

### Task 4.4 — Phase 4 regression  `SEQUENTIAL`

- [ ] Full regression suite.
- [ ] Code review subagent.
- [ ] UI review subagent (post-impl).
- [ ] Update plan — check Phase 4 boxes + completion block.
- [ ] Commit plan.

---

## Phase 5 — Export zip bundle + integration tests + docs

### Task 5.1 — Export zip  `SEQUENTIAL`

**Files:**
- Create: `src-tauri/src/fanout/export.rs`
- Modify: `src-tauri/src/commands/fanout.rs` — add `fanout_run_export_zip(run_id, dest_path)`
- Modify: `src-tauri/Cargo.toml` — add `zip = "2"` (check `cargo add --dry-run` before pinning)
- Create: `src-tauri/tests/fanout_export_test.rs`
- Create: `src/features/fanout/ExportButton.tsx` + `.css`

- [ ] **Step 1: Failing test** — run 3 mock devices, call `fanout_run_export_zip`, assert:
  - Zip contains `report.md`, `manifest.json`, and one `devices/<kind>_<display_name>.txt` per device.
  - `report.md` contains a markdown table with one column per device and one row per parsed-output column (reused from MergedTable rendering logic — shared via a `render_merged_markdown` pure function).
  - `manifest.json` contains `run_id`, `command`, `started_at`, `ended_at`, per-device status array.

- [ ] **Step 2: Implement `export.rs`**

```rust
pub fn export_run_zip(conn: &Connection, run_id: &str, dest: &Path) -> Result<ExportManifest, ExportError> {
    let detail = store::run_get(conn, run_id)?;
    let file = File::create(dest)?;
    let mut zip = ZipWriter::new(file);
    let opts = FileOptions::default().compression_method(CompressionMethod::Deflated);

    zip.start_file("manifest.json", opts)?;
    serde_json::to_writer_pretty(&mut zip, &ExportManifest::from(&detail))?;

    let report = render_merged_markdown(&detail, load_parsed_outputs(conn, &detail)?);
    zip.start_file("report.md", opts)?;
    zip.write_all(report.as_bytes())?;

    for d in &detail.devices {
        if let Some(bid) = &d.block_id {
            let raw = load_block_raw(conn, bid)?;
            let path = format!("devices/{}_{}.txt", d.device_kind.as_str(), sanitize_filename(&d.display_name));
            zip.start_file(path, opts)?;
            zip.write_all(raw.as_bytes())?;
        }
    }
    zip.finish()?;
    Ok(ExportManifest::from(&detail))
}
```

- [ ] **Step 3: Frontend** — `ExportButton` uses `@tauri-apps/plugin-dialog` save dialog (already present), calls `fanout_run_export_zip`, shows toast on success.

- [ ] **Step 4: Commit** `feat(fanout): export run as zip bundle (markdown + per-device txt)`

### Task 5.2 — Integration tests with fake SSH / NETCONF  `SEQUENTIAL` (depends on 5.1)

**Files:**
- Create: `src-tauri/tests/fanout_integration_test.rs`
- Create: `src-tauri/tests/support/fake_ssh.rs`  (if not already present; inspect `src-tauri/tests/` for reusable harness first)

- [ ] **Step 1: Inspect existing fakes**

```bash
ls src-tauri/tests/ && grep -l "rcgen\|axum\|russh::server" src-tauri/tests/ src-tauri/tests/support/
```
If an `rcgen` + `russh::server` harness already exists (patterns referenced in `dev-dependencies`), reuse it. Do NOT re-implement.

- [ ] **Step 2: Scenarios**

  1. **Happy path** — 3 fake SSH servers each returning canned `show version` output; fan-out succeeds; exported zip contains correct content.
  2. **One device outlier** — server #2 returns an `Idle` BGP neighbor; `MergedTable` equivalent (pure-Rust diff helper) surfaces the outlier in the exported `report.md`.
  3. **Timeout** — server #3 sleeps 5s; run with `timeout_ms=500` fails that device with `kind=Timeout`; other 2 succeed; status = `partial`.
  4. **Auth failure** — server #4 rejects password; classified as `FailureKind::Auth`.
  5. **Mixed SSH + NETCONF** — 2 fake SSH + 1 fake NETCONF responder; both kinds land in the same run correctly.
  6. **50 fake servers concurrent** — reuse the stress harness; assert `duration_ms < 2x single_device_delay`.

- [ ] **Step 3: Run — expect PASS.**

- [ ] **Step 4: Commit** `test(fanout): integration suite against fake ssh+netconf servers`

### Task 5.3 — Docs  `PARALLEL with 5.4`

**Files:**
- Create: `docs/FANOUT.md`
- Modify: `docs/USER_GUIDE.md` — add "Multi-device fan-out" section with screenshot + keyboard shortcut table.

- [ ] **Step 1: Document**
  - Group management (create / edit / CSV import).
  - Running a fan-out (screenshots of picker, progress lane, merged view, outlier banner).
  - Keyboard shortcuts: `⌘⇧F` open fan-out, `⌘.` cancel all, `⌘R` retry failed.
  - Export zip format (tree diagram of `report.md` + `manifest.json` + `devices/`).
  - Troubleshooting: auth failures, timeout tuning, resume behavior.

- [ ] **Step 2: Commit** `docs: fan-out user guide`

### Task 5.4 — Keyboard shortcuts  `PARALLEL with 5.3`

**Files:**
- Create: `src/features/fanout/useFanoutShortcuts.ts`

- [ ] **Step 1: Bindings** (match Plan 01's `react-hotkeys-hook` pattern; do not guess — read `useBlockShortcuts.ts` first):
  - `⌘⇧F` — open fan-out panel (or focus input if open).
  - `⌘.` — cancel all remaining devices in the active run.
  - `⌘R` — retry all failed devices.
  - `⌘E` — export active run as zip.

- [ ] **Step 2: Tests with `@testing-library/user-event`.**
- [ ] **Step 3: Commit** `feat(fanout): keyboard shortcuts`

### Task 5.5 — Phase 5 regression + plan closeout  `SEQUENTIAL`

- [ ] Full regression (`bun run test`, `cargo test`, `bunx playwright test`).
- [ ] Code review subagent.
- [ ] UI review subagent (final).
- [ ] Update `/Plans/README.md` status column for row 07 to ✅ Complete.
- [ ] Update this plan: all boxes checked, append final completion block.
- [ ] Commit.

---

## Self-review checklist (before marking plan complete)

- [ ] Migration number **V0034** matches `/Plans/README.md` reservation (and Phase 4 retry-attempt numbering resolved: either folded into V0034 or claimed as V0043 with README update).
- [ ] Every phase ends with regression + code review + plan-file update.
- [ ] No step contains `TODO`, `...`, or placeholder values that are not explicitly marked as example comments.
- [ ] Type names (`DeviceKind`, `FanoutGroup`, `FanoutMember`, `FanoutRunSummary`, `FanoutRunDetail`, `DeviceResultRow`, `FanoutEvent`, `FailureKind`, `WorkerOutcome`, `ActiveRun`, `DeviceRunState`) are consistent across Rust + TS.
- [ ] Event channel name `"fanout://event"` is used by both the Rust emitter and the React listener.
- [ ] Semaphore cap (50) is enforced server-side — command-layer ignores higher `concurrency` requests.
- [ ] Per-device timeout default 30 s, override documented, enforced via `tokio::time::timeout` inside `run_one`.
- [ ] Plan 05 diff engine is *reused*, not duplicated — `DiffTable` import lives in `MergedTable.tsx`, not re-implemented.
- [ ] Plan 01 block tagging is reused — every fanout output block carries a `fanout:<run_id>` tag.
- [ ] Outlier detector has explicit majority + minority thresholds and tests for both "clear outlier" and "no outlier" cases.
- [ ] Integration tests cover happy-path + timeout + auth-fail + mixed-kind + 50-server stress.
- [ ] Export zip layout documented and tested.
- [ ] Parallel vs. sequential labels are correct — sub-tasks touching the same file are marked sequential.
- [ ] No vendor-command behavior is assumed without being either verified in existing code or confirmed via `mcp__plugin_context7_context7__query-docs`.

## Completion log

## Phase 1 — COMPLETED 2026-05-18
Schema V0034 (with attempt_number folded in) applied; group/member CRUD + CSV import live; device picker UI merged with saved SSH and NETCONF lists; 50-cap enforced at UI. 10 cargo tests + 8 vitest tests green.

## Phase 2 — COMPLETED 2026-05-18
Tokio executor (Semaphore<50> + tokio::select! timeout + CancellationToken) live; LiveFactory wires russh-based one-shot exec for SSH, NETCONF stubbed pending raw-RPC plumbing; events on `fanout://event`; per-device persistence into command_blocks + block_tags + parsed_outputs (best-effort) + fanout_run_results; status rollup; orphan-run cleanup helper. 22 cargo tests green (executor, persistence, stress p95).

## Phase 3 — COMPLETED 2026-05-18
Frontend FanoutPanel (command bar + progress lane + per-device tabs + merged view + history drawer + outlier banner), fanoutRunsStore reducer driven by `fanout://event`, useFanoutEvents subscription hook, fanoutOutliers (75/10 majority/minority detection), Tools + Fan-Out menus wired with menu listeners. 20 vitest tests green (outliers 5 + runs store 4 + panel 3 + carry-over 8).

## Phase 4 — COMPLETED 2026-05-18
Cancel/retry/history mostly delivered in Phases 2+3 (cancel_run, cancel_device, retry_device, history drawer, retry-all-failed UX). App boot now sweeps orphan runs (`running`+no `ended_at` → `failed`+`interrupted: app restart`).

## Phase 5 — COMPLETED 2026-05-18
`fanout/export.rs` writes a zip with manifest.json + report.md + devices/<kind>_<name>.txt; `fanout_run_export_zip` Tauri command; `useFanoutShortcuts` (⌘⇧F open / ⌘. cancel / ⌘R retry-failed / ⌘E export); `docs/FANOUT.md` user guide. 6 additional cargo tests (export 2) + 4 vitest tests (hotkeys).

Final tally: 28 fanout cargo tests + 24 fanout vitest tests, all green. Pre-existing regression baselines unchanged (5 netconf lib + 1 agent_bridge cargo failures; 9 vitest in NetconfTab/ParameterForm/PipeMenu).

<!-- Append `## Phase N — COMPLETED YYYY-MM-DD` blocks below as phases finish. -->

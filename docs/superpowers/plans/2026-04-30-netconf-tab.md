# NETCONF Tab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a third tab type `"netconf"` to CCIE Terminal, mirroring the API tab pattern, to let network engineers push XML/CLI over NETCONF to Cisco devices, browse YANG models, and retrieve configs — all with the existing Zustand + Rust + Python-sidecar stack.

**Architecture:** React (`src/components/netconf/`) + Rust (`src-tauri/src/netconf_runner/`) + Python sidecar (`sidecar/src/ccie_sidecar/netconf_runner.py`). Sessions live in the sidecar via `ncclient`; Rust proxies RPCs and owns storage; React owns UI. Passwords live in the OS keychain, YANG model files live on disk under `~/.ccie-terminal/yang-cache/`.

**Tech Stack:** Rust (rusqlite, refinery, tauri v2, serde, thiserror, keyring), TypeScript (React 19, Zustand, Monaco), Python (ncclient, pyang, httpx), SQLite (refinery migrations), Vitest, cargo test, pytest.

**Spec:** `/Users/shaunwhi/.claude/plans/id-like-to-add-swift-taco.md` (approved 2026-04-30).

**Scope of this plan document:** Detailed TDD tasks for **Step 1 (plumbing)** only — the foundation that unblocks everything else. Steps 2–9 (sidecar, ncclient, UI, history, retrieve, AI, YANG browser) are each complex enough to warrant their own plan file and will be written after Step 1 ships and is reviewed. Each subsequent step's scope is summarized at the bottom of this document.

---

## File Structure — Step 1 (Plumbing)

Files this plan creates or modifies. Each file has one responsibility.

### Create
- `src-tauri/migrations/V0015__netconf_runner.sql` — schema: `netconf_tab_state`, `netconf_devices`, `netconf_saved_rpcs`, `netconf_history`, `yang_releases`, `yang_modules`.
- `src-tauri/src/netconf_runner/mod.rs` — module root; re-exports submodules as they're added. Empty aside from module declarations in Step 1.
- `src-tauri/src/netconf_runner/session_store.rs` — `create_netconf_tab` function; minimal right now, grows with later steps.
- `src-tauri/tests/migration_v0015_test.rs` — schema regression tests (mirror of `migration_v0013_test.rs`).
- `src-tauri/tests/netconf_tab_test.rs` — `create_netconf_tab` + `close_tab` round-trip tests.
- `src/components/netconf/NetconfTab.tsx` — empty placeholder component; renders a "NETCONF tab (coming soon)" card with the tab's title.
- `src/components/netconf/NetconfTab.test.tsx` — smoke test: renders when given a `Tab`.

### Modify
- `src-tauri/src/session.rs:9-24` — no change yet. (The `tab_type` field already accepts any string; `"netconf"` just works.)
- `src-tauri/src/commands.rs:323-358` — add `tab_new_netconf` + `tab_close_netconf` right after the existing API equivalents.
- `src-tauri/src/lib.rs:79-140` — register new commands in `tauri::generate_handler!`.
- `src/lib/types.ts:1` — extend `TabType` union: `"terminal" | "api" | "netconf"`.
- `src/lib/tauri.ts:129-142` — add `tabNewNetconf` + `tabCloseNetconf` wrappers.
- `src/components/TabBar.tsx:1-83` — add `+ NETCONF` button and `isNetconf` branch in close handler.
- `src/App.tsx:171-240` — add `handleNewNetconfTab` and route `tab.tab_type === "netconf"` to `NetconfTab`.

Nothing else is modified in Step 1.

---

## Task 1: V0015 migration — failing schema test

**Files:**
- Test: `src-tauri/tests/migration_v0015_test.rs`

- [ ] **Step 1.1: Write the failing test**

```rust
//! V0015 (NETCONF Runner) migration regression tests.

use ccie_terminal_lib::db;
use rusqlite::Connection;
use tempfile::TempDir;

fn has_column(conn: &Connection, table: &str, column: &str) -> bool {
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({})", table)).unwrap();
    let cols: Vec<String> = stmt
        .query_map([], |r| r.get::<_, String>(1))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    cols.iter().any(|c| c == column)
}

fn has_table(conn: &Connection, table: &str) -> bool {
    let n: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?",
            [table],
            |r| r.get(0),
        )
        .unwrap();
    n > 0
}

fn has_index(conn: &Connection, index: &str) -> bool {
    let n: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name=?",
            [index],
            |r| r.get(0),
        )
        .unwrap();
    n > 0
}

#[test]
fn fresh_db_gets_all_netconf_tables() {
    let dir = TempDir::new().unwrap();
    let db_path = dir.path().join("fresh.db");
    let conn = db::open_and_migrate(&db_path).expect("migrate");

    assert!(has_table(&conn, "netconf_tab_state"));
    assert!(has_table(&conn, "netconf_devices"));
    assert!(has_table(&conn, "netconf_saved_rpcs"));
    assert!(has_table(&conn, "netconf_history"));
    assert!(has_table(&conn, "yang_releases"));
    assert!(has_table(&conn, "yang_modules"));
}

#[test]
fn netconf_tab_state_has_expected_columns() {
    let dir = TempDir::new().unwrap();
    let conn = db::open_and_migrate(&dir.path().join("c.db")).unwrap();
    for col in [
        "tab_id", "device_id", "ad_hoc_host", "ad_hoc_port",
        "ad_hoc_username", "editor_mode", "editor_content",
        "target_datastore", "session_id",
    ] {
        assert!(has_column(&conn, "netconf_tab_state", col), "missing {col}");
    }
}

#[test]
fn netconf_history_index_exists() {
    let dir = TempDir::new().unwrap();
    let conn = db::open_and_migrate(&dir.path().join("c.db")).unwrap();
    assert!(has_index(&conn, "idx_nc_hist_tab"));
}

#[test]
fn cascading_delete_removes_netconf_tab_state() {
    use ccie_terminal_lib::session;
    let dir = TempDir::new().unwrap();
    let conn = db::open_and_migrate(&dir.path().join("c.db")).unwrap();
    conn.execute("PRAGMA foreign_keys = ON", []).unwrap();

    // Insert a netconf tab directly (session helper added in Task 3).
    conn.execute(
        "INSERT INTO tabs (id, title, shell_cmd, cwd, tab_type) VALUES (?, ?, '', '', 'netconf')",
        rusqlite::params!["nc-1", "test"],
    ).unwrap();
    conn.execute(
        "INSERT INTO netconf_tab_state (tab_id, editor_mode, editor_content, target_datastore) VALUES (?, 'raw_xml', '', 'running')",
        ["nc-1"],
    ).unwrap();

    conn.execute("DELETE FROM tabs WHERE id = ?", ["nc-1"]).unwrap();
    let remaining: i64 = conn.query_row(
        "SELECT COUNT(*) FROM netconf_tab_state WHERE tab_id = ?",
        ["nc-1"], |r| r.get(0),
    ).unwrap();
    assert_eq!(remaining, 0);
}

#[test]
fn migration_is_idempotent() {
    let dir = TempDir::new().unwrap();
    let db_path = dir.path().join("idempotent.db");
    { let _c = db::open_and_migrate(&db_path).unwrap(); }
    let conn = db::open_and_migrate(&db_path).unwrap();
    assert!(has_table(&conn, "netconf_history"));
}
```

- [ ] **Step 1.2: Run test to verify it fails**

Run: `cd src-tauri && cargo test --test migration_v0015_test`
Expected: compile/migration error — file `V0015__netconf_runner.sql` does not exist yet, refinery panics on open.

---

## Task 2: V0015 migration — write the SQL

**Files:**
- Create: `src-tauri/migrations/V0015__netconf_runner.sql`

- [ ] **Step 2.1: Write the migration**

```sql
-- NETCONF tab support: devices, sessions, saved RPCs, history, YANG model cache.
-- No schema change to `tabs`: the existing `tab_type TEXT` column (added by
-- V0013) accepts 'netconf' without modification.

CREATE TABLE IF NOT EXISTS netconf_tab_state (
  tab_id            TEXT    PRIMARY KEY REFERENCES tabs(id) ON DELETE CASCADE,
  device_id         INTEGER REFERENCES netconf_devices(id) ON DELETE SET NULL,
  ad_hoc_host       TEXT,
  ad_hoc_port       INTEGER,
  ad_hoc_username   TEXT,
  editor_mode       TEXT    NOT NULL DEFAULT 'raw_xml',
  editor_content    TEXT    NOT NULL DEFAULT '',
  target_datastore  TEXT    NOT NULL DEFAULT 'running',
  session_id        TEXT
);

CREATE TABLE IF NOT EXISTS netconf_devices (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  name            TEXT    NOT NULL UNIQUE,
  host            TEXT    NOT NULL,
  port            INTEGER NOT NULL DEFAULT 830,
  username        TEXT    NOT NULL,
  platform        TEXT    NOT NULL DEFAULT 'iosxe',
  hostkey_verify  INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  updated_at      INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE TABLE IF NOT EXISTS netconf_saved_rpcs (
  id           TEXT    PRIMARY KEY,
  name         TEXT    NOT NULL UNIQUE,
  editor_mode  TEXT    NOT NULL,
  content      TEXT    NOT NULL,
  operation    TEXT    NOT NULL,
  target       TEXT,
  platform     TEXT,
  created_at   INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  updated_at   INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE TABLE IF NOT EXISTS netconf_history (
  id                 TEXT    PRIMARY KEY,
  tab_id             TEXT    REFERENCES tabs(id) ON DELETE SET NULL,
  saved_rpc_id       TEXT    REFERENCES netconf_saved_rpcs(id) ON DELETE SET NULL,
  device_id          INTEGER REFERENCES netconf_devices(id) ON DELETE SET NULL,
  host               TEXT,
  operation          TEXT    NOT NULL,
  target_datastore   TEXT,
  request_xml        TEXT    NOT NULL,
  response_xml       TEXT,
  response_truncated INTEGER NOT NULL DEFAULT 0,
  status             TEXT    NOT NULL,
  error_message      TEXT,
  duration_ms        INTEGER,
  sent_at            INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
CREATE INDEX IF NOT EXISTS idx_nc_hist_tab ON netconf_history(tab_id, sent_at DESC);

CREATE TABLE IF NOT EXISTS yang_releases (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  vendor         TEXT    NOT NULL,
  os             TEXT    NOT NULL,
  release        TEXT    NOT NULL,
  source_path    TEXT    NOT NULL,
  cache_dir      TEXT    NOT NULL,
  module_count   INTEGER NOT NULL DEFAULT 0,
  downloaded_at  INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  UNIQUE(vendor, os, release)
);

CREATE TABLE IF NOT EXISTS yang_modules (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  release_id   INTEGER NOT NULL REFERENCES yang_releases(id) ON DELETE CASCADE,
  name         TEXT    NOT NULL,
  namespace    TEXT,
  revision     TEXT,
  file_path    TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_yang_mod_release ON yang_modules(release_id);
CREATE INDEX IF NOT EXISTS idx_yang_mod_name    ON yang_modules(name);
```

> Note on the self-referencing FK (`netconf_tab_state.device_id` → `netconf_devices`): SQLite only validates FKs when `PRAGMA foreign_keys=ON`; creation order doesn't matter because SQLite defers binding. The cascade test explicitly enables FKs.

- [ ] **Step 2.2: Run test to verify it passes**

Run: `cd src-tauri && cargo test --test migration_v0015_test`
Expected: all 5 tests pass.

- [ ] **Step 2.3: Commit**

```bash
git add src-tauri/migrations/V0015__netconf_runner.sql src-tauri/tests/migration_v0015_test.rs
git commit -m "feat(netconf): V0015 migration for NETCONF tab tables"
```

---

## Task 3: `create_netconf_tab` + `close_tab` round-trip — failing test

**Files:**
- Test: `src-tauri/tests/netconf_tab_test.rs`

- [ ] **Step 3.1: Write the failing test**

```rust
//! Integration test: netconf tab creation round-trip.

use ccie_terminal_lib::{db, session};
use ccie_terminal_lib::netconf_runner::session_store::create_netconf_tab;
use tempfile::TempDir;

#[test]
fn netconf_tab_round_trip() {
    let dir = TempDir::new().unwrap();
    let conn = db::open_and_migrate(&dir.path().join("nc.db")).unwrap();

    let tab = create_netconf_tab(&conn, "New NETCONF Session").unwrap();
    assert_eq!(tab.tab_type, "netconf");
    assert_eq!(tab.title, "New NETCONF Session");
    assert_eq!(tab.shell_cmd, "");
    assert_eq!(tab.cwd, "");

    // Companion state row exists with defaults.
    let (mode, content, ds): (String, String, String) = conn
        .query_row(
            "SELECT editor_mode, editor_content, target_datastore FROM netconf_tab_state WHERE tab_id = ?",
            [&tab.id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .unwrap();
    assert_eq!(mode, "raw_xml");
    assert_eq!(content, "");
    assert_eq!(ds, "running");

    // list_open_tabs includes it.
    let tabs = session::list_open_tabs(&conn).unwrap();
    assert_eq!(tabs.len(), 1);
    assert_eq!(tabs[0].tab_type, "netconf");
}

#[test]
fn netconf_and_terminal_and_api_coexist() {
    let dir = TempDir::new().unwrap();
    let conn = db::open_and_migrate(&dir.path().join("mix.db")).unwrap();

    session::create_tab(&conn, "t", "/bin/zsh", "/").unwrap();
    session::create_api_tab(&conn, "a", None, None).unwrap();
    create_netconf_tab(&conn, "n").unwrap();

    let tabs = session::list_open_tabs(&conn).unwrap();
    let types: Vec<&str> = tabs.iter().map(|t| t.tab_type.as_str()).collect();
    assert!(types.contains(&"terminal"));
    assert!(types.contains(&"api"));
    assert!(types.contains(&"netconf"));
}

#[test]
fn close_removes_netconf_tab_from_open_list() {
    let dir = TempDir::new().unwrap();
    let conn = db::open_and_migrate(&dir.path().join("close.db")).unwrap();

    let tab = create_netconf_tab(&conn, "to-close").unwrap();
    session::close_tab(&conn, &tab.id).unwrap();

    let tabs = session::list_open_tabs(&conn).unwrap();
    assert_eq!(tabs.len(), 0);
}
```

- [ ] **Step 3.2: Run test to verify it fails**

Run: `cd src-tauri && cargo test --test netconf_tab_test`
Expected: compile error — `ccie_terminal_lib::netconf_runner` module does not exist.

---

## Task 4: Create `netconf_runner` module + `create_netconf_tab`

**Files:**
- Create: `src-tauri/src/netconf_runner/mod.rs`
- Create: `src-tauri/src/netconf_runner/session_store.rs`
- Modify: `src-tauri/src/lib.rs` (add `pub mod netconf_runner;`)

- [ ] **Step 4.1: Create the module root**

`src-tauri/src/netconf_runner/mod.rs`:
```rust
//! NETCONF tab: tab state, session proxy to sidecar, history, YANG cache.
//! Mirrors the `api_runner` module's layout.

pub mod session_store;
```

- [ ] **Step 4.2: Implement `create_netconf_tab`**

`src-tauri/src/netconf_runner/session_store.rs`:
```rust
//! Creates and persists a NETCONF tab. Does NOT open a session — that happens
//! via `netconf_connect` later. Only the DB rows are written here.

use anyhow::{Context, Result};
use rusqlite::{params, Connection};
use uuid::Uuid;

use crate::session::Tab;

/// Create a new NETCONF tab and its companion `netconf_tab_state` row with
/// the default editor mode (`raw_xml`), empty content, and target datastore
/// `running`. No session is opened; `session_id` remains NULL.
pub fn create_netconf_tab(conn: &Connection, title: &str) -> Result<Tab> {
    let id = Uuid::new_v4().to_string();
    conn.execute(
        "INSERT INTO tabs (id, title, shell_cmd, cwd, tab_type) VALUES (?, ?, '', '', 'netconf')",
        params![id, title],
    )
    .context("insert netconf tab")?;
    conn.execute(
        "INSERT INTO netconf_tab_state (tab_id, editor_mode, editor_content, target_datastore)
         VALUES (?, 'raw_xml', '', 'running')",
        params![id],
    )
    .context("insert netconf_tab_state")?;
    let created_at: i64 = conn
        .query_row("SELECT created_at FROM tabs WHERE id = ?", params![id], |r| r.get(0))
        .context("read created_at")?;
    Ok(Tab {
        id,
        title: title.into(),
        shell_cmd: String::new(),
        cwd: String::new(),
        created_at,
        tab_type: "netconf".to_string(),
    })
}
```

- [ ] **Step 4.3: Register the module in `lib.rs`**

Open `src-tauri/src/lib.rs`. Find the block of `pub mod` declarations (near the top of the file). Add:

```rust
pub mod netconf_runner;
```

alongside the existing `pub mod api_runner;` (or wherever the module declarations are). If other modules are declared `mod` (private), match that style — but check whether `api_runner` is `pub mod`. The integration test requires `pub mod`.

- [ ] **Step 4.4: Run test to verify it passes**

Run: `cd src-tauri && cargo test --test netconf_tab_test`
Expected: all 3 tests pass.

- [ ] **Step 4.5: Commit**

```bash
git add src-tauri/src/netconf_runner/ src-tauri/src/lib.rs src-tauri/tests/netconf_tab_test.rs
git commit -m "feat(netconf): create_netconf_tab session helper + module scaffold"
```

---

## Task 5: Tauri commands `tab_new_netconf` + `tab_close_netconf`

**Files:**
- Modify: `src-tauri/src/commands.rs` (insert after `tab_close_api` at line 358)
- Modify: `src-tauri/src/lib.rs` (register both in `invoke_handler`)

No standalone Rust test; the frontend test in Task 9 exercises the command via `invoke`.

- [ ] **Step 5.1: Add both commands in `commands.rs`**

Insert immediately after `tab_close_api` (after line 358). Follow the exact style of `tab_new_api` / `tab_close_api`:

```rust
/// Create a NETCONF tab. Like `tab_new_api`, this does NOT spawn a PTY —
/// it inserts a row with `tab_type='netconf'` plus a companion
/// `netconf_tab_state` row. Sessions open lazily via `netconf_connect`.
#[tauri::command]
pub fn tab_new_netconf(
    state: State<'_, AppState>,
    title: String,
) -> Result<session::Tab, String> {
    tracing::info!(title = %title, "Creating NETCONF tab");
    let db = state.db.lock();
    netconf_runner::session_store::create_netconf_tab(&db, &title).map_err(|e| {
        tracing::error!(error = %e, "Failed to create NETCONF tab");
        e.to_string()
    })
}

/// Close a NETCONF tab (no PTY, just a DB close). Safe to call repeatedly.
/// Does NOT tear down an active sidecar session — that is the caller's
/// responsibility via `netconf_disconnect`.
#[tauri::command]
pub fn tab_close_netconf(state: State<'_, AppState>, tab_id: String) -> Result<(), String> {
    let validated = validation::validate_tab_id(&tab_id).map_err(|e| e.to_string())?;
    let db = state.db.lock();
    session::close_tab(&db, &validated).map_err(|e| e.to_string())
}
```

If `commands.rs` does not already `use crate::netconf_runner;`, add that to the `use` block at the top of the file.

- [ ] **Step 5.2: Register the commands in `lib.rs`**

In `src-tauri/src/lib.rs` at line 88–89 (where `tab_new_api` / `tab_close_api` are registered), add two new lines right after them:

```rust
commands::tab_new_api,
commands::tab_close_api,
commands::tab_new_netconf,
commands::tab_close_netconf,
```

- [ ] **Step 5.3: Verify the crate still compiles and all tests pass**

Run: `cd src-tauri && cargo test`
Expected: clean compile; previous tests still pass. (No new tests at this step; behavior is exercised from the frontend.)

- [ ] **Step 5.4: Commit**

```bash
git add src-tauri/src/commands.rs src-tauri/src/lib.rs
git commit -m "feat(netconf): tab_new_netconf and tab_close_netconf Tauri commands"
```

---

## Task 6: Extend `TabType` + typed Tauri wrappers

**Files:**
- Modify: `src/lib/types.ts:1`
- Modify: `src/lib/tauri.ts:129-142`

- [ ] **Step 6.1: Extend `TabType`**

Change `src/lib/types.ts` line 1 from:

```ts
export type TabType = "terminal" | "api";
```

to:

```ts
export type TabType = "terminal" | "api" | "netconf";
```

Update the doc comment on line 9 (the `tab_type?` field):

```ts
/** "terminal" = PTY-backed; "api" = API Runner tab; "netconf" = NETCONF workbench. Defaults to "terminal" for pre-V0013 data. */
```

- [ ] **Step 6.2: Add wrapper functions**

In `src/lib/tauri.ts`, immediately after the `tabCloseApi` function at line 142, insert:

```ts
/**
 * Create a new NETCONF tab. Does NOT open a session or spawn a PTY.
 */
export const tabNewNetconf = (opts: { title: string }) =>
  invoke<Tab>("tab_new_netconf", { title: opts.title });

/** Close a NETCONF tab (no PTY, no active session). */
export const tabCloseNetconf = (tabId: string) =>
  invoke<void>("tab_close_netconf", { tabId });
```

- [ ] **Step 6.3: Verify no existing code broke**

Run: `npm run typecheck` (or `npx tsc --noEmit` if there's no script)
Expected: no errors.

- [ ] **Step 6.4: Commit**

```bash
git add src/lib/types.ts src/lib/tauri.ts
git commit -m "feat(netconf): extend TabType and add tabNewNetconf/tabCloseNetconf"
```

---

## Task 7: Placeholder `NetconfTab` component + test

**Files:**
- Create: `src/components/netconf/NetconfTab.tsx`
- Create: `src/components/netconf/NetconfTab.test.tsx`

- [ ] **Step 7.1: Write the failing test**

`src/components/netconf/NetconfTab.test.tsx`:
```tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { NetconfTab } from "./NetconfTab";
import type { Tab } from "../../lib/types";

function makeTab(overrides: Partial<Tab> = {}): Tab {
  return {
    id: "nc-test-id",
    title: "My NETCONF Tab",
    shell_cmd: "",
    cwd: "",
    created_at: 0,
    tab_type: "netconf",
    ...overrides,
  };
}

describe("NetconfTab (placeholder)", () => {
  it("renders a coming-soon card with the tab title", () => {
    render(<NetconfTab tab={makeTab()} />);
    expect(screen.getByText(/NETCONF/i)).toBeInTheDocument();
    expect(screen.getByText(/My NETCONF Tab/)).toBeInTheDocument();
    expect(screen.getByTestId("netconf-tab-root")).toBeInTheDocument();
  });

  it("shows the tab id (useful for debugging)", () => {
    render(<NetconfTab tab={makeTab({ id: "abc-123" })} />);
    expect(screen.getByText(/abc-123/)).toBeInTheDocument();
  });
});
```

- [ ] **Step 7.2: Run test to verify it fails**

Run: `npm test -- src/components/netconf/NetconfTab.test.tsx --run`
Expected: FAIL — cannot resolve `./NetconfTab`.

- [ ] **Step 7.3: Implement the placeholder component**

`src/components/netconf/NetconfTab.tsx`:
```tsx
import type { Tab } from "../../lib/types";

/**
 * Placeholder shell for the NETCONF tab. Wiring only; real panels (connection,
 * editor, response, retrieve, YANG browser) land in later phases.
 */
export function NetconfTab({ tab }: { tab: Tab }) {
  return (
    <div
      data-testid="netconf-tab-root"
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        height: "100%",
        padding: "2rem",
        color: "#a8b0bd",
        fontFamily: "system-ui, sans-serif",
      }}
    >
      <h2 style={{ marginBottom: "0.5rem" }}>NETCONF</h2>
      <p style={{ margin: 0 }}>
        <strong>{tab.title}</strong>
      </p>
      <p style={{ margin: "0.5rem 0 0", fontSize: "0.85rem", opacity: 0.7 }}>
        tab id: {tab.id}
      </p>
      <p style={{ marginTop: "1.5rem", fontSize: "0.9rem", opacity: 0.7 }}>
        Connection panel, RPC editor, response viewer, and YANG browser land
        in later phases.
      </p>
    </div>
  );
}
```

- [ ] **Step 7.4: Run test to verify it passes**

Run: `npm test -- src/components/netconf/NetconfTab.test.tsx --run`
Expected: PASS (2 tests).

- [ ] **Step 7.5: Commit**

```bash
git add src/components/netconf/
git commit -m "feat(netconf): placeholder NetconfTab component"
```

---

## Task 8: Wire TabBar button + App.tsx routing

**Files:**
- Modify: `src/components/TabBar.tsx:1-83`
- Modify: `src/App.tsx:171-240`

- [ ] **Step 8.1: Update `TabBar.tsx`**

Make three targeted changes.

**A. Import the new close wrapper** (line 2):
```ts
import { ptyKill, tabCloseApi, tabCloseNetconf } from "../lib/tauri";
```

**B. Accept `onNewNetconf` prop and add `isNetconf` branching** — replace the component signature and body (lines 4–83) with:

```tsx
export function TabBar({
  onNew,
  onNewApi,
  onNewNetconf,
  onSettings,
  onSaveSession,
}: {
  onNew: () => void;
  onNewApi?: () => void;
  onNewNetconf?: () => void;
  onSettings?: () => void;
  onSaveSession?: () => void;
}) {
  const { tabs, activeTabId, setActive, removeTab } = useTabs();
  return (
    <div className="tabbar">
      {tabs.map((t) => {
        const isApi = t.tab_type === "api";
        const isNetconf = t.tab_type === "netconf";
        return (
          <div
            key={t.id}
            className={`tab ${t.id === activeTabId ? "tab-active" : ""} ${
              isApi ? "tab-api" : isNetconf ? "tab-netconf" : "tab-terminal"
            }`}
            onClick={() => setActive(t.id)}
            data-testid={`tab-${t.id}`}
            data-tab-type={t.tab_type ?? "terminal"}
          >
            {isApi && (
              <span className="tab-type-badge" title="API Runner tab">
                API
              </span>
            )}
            {isNetconf && (
              <span className="tab-type-badge" title="NETCONF tab">
                NC
              </span>
            )}
            <span>{t.title}</span>
            <button
              className="tab-close"
              onClick={async (e) => {
                e.stopPropagation();
                if (isApi) {
                  await tabCloseApi(t.id).catch(() => {});
                } else if (isNetconf) {
                  await tabCloseNetconf(t.id).catch(() => {});
                } else {
                  await ptyKill(t.id).catch(() => {});
                }
                removeTab(t.id);
              }}
            >
              ×
            </button>
          </div>
        );
      })}
      <button className="tab-new" onClick={onNew} title="New terminal tab">
        +
      </button>
      {onNewApi && (
        <button
          className="tab-new-api"
          onClick={onNewApi}
          title="New API Runner tab"
          data-testid="tab-new-api"
        >
          + API
        </button>
      )}
      {onNewNetconf && (
        <button
          className="tab-new-netconf"
          onClick={onNewNetconf}
          title="New NETCONF tab"
          data-testid="tab-new-netconf"
        >
          + NETCONF
        </button>
      )}
      {onSaveSession && (
        <button
          className="tab-save-session"
          onClick={onSaveSession}
          title="Save Session"
        >
          Save
        </button>
      )}
      {onSettings && (
        <button className="tab-settings" onClick={onSettings} title="Settings">
          ⚙
        </button>
      )}
    </div>
  );
}
```

- [ ] **Step 8.2: Update `App.tsx`**

**A. Update the `tauri` import** (search for existing `tabNewApi` import near the top of `App.tsx`) — add `tabNewNetconf`:

```ts
import { tabNewApi, tabNewNetconf } from "./lib/tauri";
```

(Adjust to match the exact existing import statement's other members.)

**B. Import `NetconfTab`** (near the `ApiTab` import):

```ts
import { NetconfTab } from "./components/netconf/NetconfTab";
```

**C. Add a `handleNewNetconfTab` function** — insert immediately after `handleNewApiTab` (currently ending at line 186):

```ts
const handleNewNetconfTab = async () => {
  try {
    const tab = await tabNewNetconf({ title: "New NETCONF Session" });
    addTab(tab);
  } catch (err) {
    console.error("Failed to create NETCONF tab:", err);
  }
};
```

**D. Pass `onNewNetconf` to `TabBar`** — replace lines 205–209:

```tsx
<TabBar
  onNew={handleNewTab}
  onNewApi={handleNewApiTab}
  onNewNetconf={handleNewNetconfTab}
  onSettings={() => setSettingsOpen(true)}
/>
```

**E. Add routing for `tab_type === "netconf"`** — inside the `term-col` div, immediately after the API tabs `.map(...)` block (ending at line 240), insert:

```tsx
{tabs
  .filter((t) => t.tab_type === "netconf")
  .map((tab) => (
    <div
      key={tab.id}
      style={{
        height: "100%",
        display: tab.id === activeTabId ? "block" : "none",
      }}
    >
      <NetconfTab tab={tab} />
    </div>
  ))}
```

- [ ] **Step 8.3: Verify typecheck + tests pass**

Run: `npm run typecheck && npm test -- --run`
Expected: clean typecheck; all frontend tests pass (including the two new NetconfTab tests).

- [ ] **Step 8.4: Commit**

```bash
git add src/App.tsx src/components/TabBar.tsx
git commit -m "feat(netconf): wire + NETCONF button and route new tab type"
```

---

## Task 9: End-to-end manual smoke test

This is a manual verification step. No code changes. Do it before stopping.

- [ ] **Step 9.1: Launch the app**

Run: `npm run tauri dev`
Expected: app window opens as usual, no console errors on startup.

- [ ] **Step 9.2: Open a NETCONF tab**

Click the `+ NETCONF` button in the tab bar.
Expected:
- A new tab appears titled "New NETCONF Session" with a green-ish `NC` badge.
- The workspace shows the placeholder card: "NETCONF / New NETCONF Session / tab id: <uuid> / Connection panel..."
- No console errors.

- [ ] **Step 9.3: Coexistence with other tabs**

Open a terminal tab (`+`), an API tab (`+ API`), and another NETCONF tab. Switch between them.
Expected: all three render without interfering with each other; switching back to NETCONF shows the placeholder cleanly.

- [ ] **Step 9.4: Close the tab**

Click the `×` on a NETCONF tab.
Expected: tab disappears; no errors. Reopen — fresh state.

- [ ] **Step 9.5: Restart persistence**

Open a NETCONF tab, then kill the app and relaunch.
Expected: the NETCONF tab reappears in the tab bar (since `list_open_tabs` includes it), renders the placeholder, can be closed cleanly. (If restart-restore UX isn't fully wired yet, at minimum the tab should exist in DB and be closable.)

- [ ] **Step 9.6: Commit the verification evidence**

No code to commit; just confirm all five manual checks passed before proceeding.

---

## Self-review checklist (run after finishing Task 9)

- [ ] All new Rust tests pass: `cd src-tauri && cargo test`
- [ ] All new frontend tests pass: `npm test -- --run`
- [ ] Typecheck clean: `npm run typecheck`
- [ ] `git log --oneline` shows 5 new commits, each scoped to one task.
- [ ] No TODO/FIXME added by this plan remains in the code.
- [ ] Spec coverage for Step 1: migration ✓, tab lifecycle ✓, tab routing ✓, placeholder UI ✓. (Steps 2–9 tracked below for future plan docs.)

---

## Summary of remaining steps (outside this plan)

Each of these is its own plan file, written after the previous ships and is reviewed. Reference: `/Users/shaunwhi/.claude/plans/id-like-to-add-swift-taco.md`.

| Step | Name | Scope (one-line) |
|---|---|---|
| 2 | Sidecar stub | `netconf_runner.py` with fake connect/disconnect/send_rpc; Rust `SidecarClient` trait + `FakeSidecarClient`; Tauri commands `netconf_connect`/`_disconnect`/`_send_rpc`; tests with fake. |
| 3 | Real `ncclient` | Wire `ncclient` in sidecar; capability exchange; verify manually against 172.16.6.2 (cisco/password1). |
| 4 | Connection UI + devices | `ConnectionPanel.tsx`, saved-devices CRUD, `keyring` crate for passwords, `netconf_device_*` commands. |
| 5 | RPC editor + response viewer | `RpcEditor.tsx` (raw XML mode), `RpcResponseViewer.tsx`, send flow, history write, then CLI mode + `cli_wrapper.rs`. |
| 6 | History + saved RPCs | `HistoryPanel.tsx`, `SavedRpcsPanel.tsx` — mirror API tab. |
| 7 | Retrieve panel | `RetrievePanel.tsx` — running/startup/get/capabilities/get-schema buttons; `netconf_retrieve` + `netconf_get_schema` commands. |
| 8 | AI features | `netconf_explain_response`, `netconf_explain_yang`, `netconf_ai_cli_to_yang` via sidecar + UI buttons. |
| 9 | YANG browser | `YangBrowser.tsx`, `yang_downloader.py`, `yang_renderer.py`, `yang_*` commands, progress events, example-XML-to-editor integration. Biggest piece; land last. |

Verification for the whole feature (from spec): live Cat8kv-like device at `172.16.6.2` / `cisco` / `password1`, reachable via `:830`. Smoke-test steps listed in the design spec.

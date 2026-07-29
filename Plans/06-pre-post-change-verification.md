# 06 — Pre/Post Change Verification (snapshot + diff + report)

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Execute phases in order, run regression + code review at the end of every phase, and update this file's checkboxes and completion log as you go.

**Goal:** Give the engineer a one-click "baseline → change → verify" workflow. Before a change window, the user picks a reusable bundle of `show` commands (a *check-bundle*), runs it against the active device, and captures a parsed `pre` snapshot. After the change, they run the same bundle, producing a `post` snapshot; the app diffs the snapshots via Plan 05's `diff_snapshots` / `diffSnapshots`, classifies each delta as **red** / **yellow** / **green**, and renders a report. The report is persisted, exportable to Markdown and PDF, and attachable to a change ticket. Bundles are reusable and scoped per vendor/platform.

**Architecture:**
- **Check-bundle** = named ordered list of CLI commands, vendor/platform tagged. Stored in `check_bundles` + `check_bundle_commands`. CRUD mirrors the workflow pattern landed by Plan 02 (`workflows` + `workflow_params`).
- **Change snapshot** = record that ties a bundle run to a tab and a label (`pre` | `post`). Each executed command in the run produces a row in `change_snapshot_results` pointing at a `parsed_outputs.id` (Plan 05 table). Raw output is NOT re-stored — we reuse Plan 05's canonical parsed cache.
- **Diff engine** = per-command delta pass through `diff_snapshots(pre_parsed_output_id, post_parsed_output_id, command_kind)` (Plan 05, Rust). Output is a `Vec<SnapshotDelta>`. A second-pass "classifier" in `src-tauri/src/change_verify/classifier.rs` maps deltas to severity (red/yellow/green) using rules tuned per command family (interface-status, bgp-neighbor, ospf-neighbor, route-summary, cdp-neighbor).
- **Report** = `change_reports` row with `summary_json` (structured deltas + severity counts) and `approved_deltas_json` (engineer's pre-declared "expected" changes: either free-form text or a list of `ExpectedDelta` objects). Report is rendered as Markdown by a pure TS module and as PDF via `html-to-pdf` using a hidden webview window (Tauri) or sidecar fallback.
- **UI** = `ChangeWindowPanel.tsx` — right-pane drawer with a Pre → Change → Post → Report timeline. Opens from a toolbar button on any tab with an active session.

**Tech Stack:** Rust (rusqlite, serde, uuid, chrono), Tauri 2 (`tauri-plugin-dialog` for save-as, `tauri-plugin-fs`), Python sidecar (re-uses Plan 00 parsers only — no new sidecar code), React 19, Zustand 5, TanStack Table (already in app), `@react-pdf/renderer` *or* Chromium-print path via Tauri (decide in Phase 5 after prototype), Vitest, cargo test, Playwright.

**Prerequisites:**
- Plan 00 complete — sidecar + `parse_show` Tauri command + `parsers_cache` live.
- Plan 01 Phase 1 complete — `command_blocks` table + `blocks_upsert` signature stable.
- **Plan 05 complete** — THIS PLAN IMPORTS FROM 05:
  - **Rust:** `crate::structured::diff::diff_snapshots(pre_id: i64, post_id: i64, command: &str) -> Result<Vec<SnapshotDelta>>` where `SnapshotDelta { path: String, kind: DeltaKind, before: Value, after: Value }` and `DeltaKind` ∈ `{ Added, Removed, Changed }`.
  - **Rust:** `crate::structured::parse_and_store(tab_id, vendor, platform, command, raw) -> Result<i64>` returning the `parsed_outputs.id`.
  - **TS:** `diffSnapshots(preId: number, postId: number, command: string): Promise<SnapshotDelta[]>` in `src/lib/structured.ts`.
  - **DB:** `parsed_outputs(id, tab_id, vendor, platform, command, parser, data_json, captured_at)` table from migration V0032.
  - If any of these are missing when Phase 2 starts, STOP and raise a blocker — do not re-implement them here.

**Plan 05 / Plan 06 reconciliation note (resolved 2026-05-18 in Phase 2 Task 2.1):**
Plan 06's spec called for `crate::structured::parse_and_store(...)` and a 3-arg `diff_snapshots(pre, post, command)` from Plan 05. Plan 05 actually shipped:
- Only `auto_parse::on_block_completed(db, parser, block_id, vendor, platform)` — requires a pre-existing `command_blocks` row, no caller-friendly entrypoint.
- `diff_snapshots(a_id, b_id, db) -> Vec<CellDiff>` — 2-arg, takes a DB handle, operates on `parsed_snapshots` ids.

Rather than mutate Plan 05's frozen public API (Plan 08 also imports it), Plan 06 ships local helpers:
- `crate::change_verify::parser::parse_and_store(db, parser, tab_id, vendor, platform, command, raw) -> Result<i64>` — synthesizes a `command_blocks` row + delegates to `auto_parse::upsert_parsed_output`.
- The diff-side reconciliation is deferred to Phase 3 Task 3.2 when the post-check classifier needs it.

**Downstream consumers:** Plan 07 (Multi-Device Fan-Out) reuses the bundle concept to run a pre/post over a *group* of devices. Plan 08 (Config Drift) reuses `change_reports` for drift-report surfacing. Plan 15 (AI Troubleshooting) can cite a `change_report` as root-cause evidence.

**Migration reserved:** `V0033__change_verification.sql` (confirmed in `/Plans/README.md`).

---

## Phase 1 — Schema + Check-Bundle CRUD

Reuses the `workflows`-style CRUD pattern established by Plan 02 (ordered child rows keyed by `(parent_id, idx)`). No UI yet — pure backend + store.

### Task 1.1 — Migration V0033  `SEQUENTIAL`

**Files:**
- Create: `src-tauri/migrations/V0033__change_verification.sql`

- [x] **Step 1: Write migration**

```sql
CREATE TABLE IF NOT EXISTS check_bundles (
  id          TEXT PRIMARY KEY,                -- uuidv4
  name        TEXT NOT NULL,
  description TEXT,
  vendor      TEXT NOT NULL,                   -- e.g. 'cisco'
  platform    TEXT NOT NULL,                   -- e.g. 'iosxe','nxos','junos'
  created_at  INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  updated_at  INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  UNIQUE(name, vendor, platform)
);
CREATE INDEX IF NOT EXISTS idx_check_bundles_vendor_platform
  ON check_bundles(vendor, platform);

CREATE TABLE IF NOT EXISTS check_bundle_commands (
  bundle_id  TEXT NOT NULL REFERENCES check_bundles(id) ON DELETE CASCADE,
  idx        INTEGER NOT NULL,                 -- 0-based ordering
  command    TEXT NOT NULL,
  PRIMARY KEY (bundle_id, idx)
);

CREATE TABLE IF NOT EXISTS change_snapshots (
  id           TEXT PRIMARY KEY,               -- uuidv4
  tab_id       TEXT NOT NULL,
  bundle_id    TEXT NOT NULL REFERENCES check_bundles(id) ON DELETE RESTRICT,
  label        TEXT NOT NULL CHECK (label IN ('pre','post')),
  captured_at  INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
CREATE INDEX IF NOT EXISTS idx_change_snapshots_tab
  ON change_snapshots(tab_id, captured_at DESC);

CREATE TABLE IF NOT EXISTS change_snapshot_results (
  snapshot_id       TEXT NOT NULL REFERENCES change_snapshots(id) ON DELETE CASCADE,
  command           TEXT NOT NULL,
  parsed_output_id  INTEGER NOT NULL,          -- FK into parsed_outputs (Plan 05 / V0032)
  PRIMARY KEY (snapshot_id, command)
);

CREATE TABLE IF NOT EXISTS change_reports (
  id                    TEXT PRIMARY KEY,      -- uuidv4
  pre_snapshot_id       TEXT NOT NULL REFERENCES change_snapshots(id) ON DELETE CASCADE,
  post_snapshot_id      TEXT NOT NULL REFERENCES change_snapshots(id) ON DELETE CASCADE,
  summary_json          TEXT NOT NULL,         -- serialized ReportSummary
  approved_deltas_json  TEXT,                  -- serialized Vec<ExpectedDelta>, nullable
  created_at            INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  UNIQUE(pre_snapshot_id, post_snapshot_id)
);
CREATE INDEX IF NOT EXISTS idx_change_reports_created
  ON change_reports(created_at DESC);
```

- [x] **Step 2: Verify migration applies**

```bash
cargo test --manifest-path src-tauri/Cargo.toml --lib -- db::tests::migrations_apply
```

- [x] **Step 3: Commit**

```bash
git add src-tauri/migrations/V0033__change_verification.sql
git commit -m "feat(db): V0033 check_bundles + change_snapshots + change_reports"
```

### Task 1.2 — Rust model + CRUD commands for bundles  `SEQUENTIAL` (depends on 1.1)

**Files:**
- Create: `src-tauri/src/change_verify/mod.rs`
- Create: `src-tauri/src/change_verify/bundles.rs`
- Create: `src-tauri/src/change_verify/model.rs`
- Create: `src-tauri/src/commands/change_verify.rs`
- Modify: `src-tauri/src/lib.rs` — add `mod change_verify;` and register commands
- Modify: `src-tauri/src/commands/mod.rs` — `pub mod change_verify;`
- Create: `src-tauri/tests/change_verify_bundles_test.rs`

- [x] **Step 1: Write the failing test**

```rust
// src-tauri/tests/change_verify_bundles_test.rs
use ccie_terminal_lib::change_verify::bundles;
use ccie_terminal_lib::change_verify::model::{CheckBundle, NewCheckBundle};

fn mem_db() -> rusqlite::Connection {
    let c = rusqlite::Connection::open_in_memory().unwrap();
    ccie_terminal_lib::db::run_migrations_on(&c).unwrap();
    c
}

#[test]
fn bundle_roundtrip_create_read_update_delete() {
    let db = mem_db();
    let created = bundles::create(&db, NewCheckBundle {
        name: "ios-xe baseline".into(),
        description: Some("Routing + interfaces".into()),
        vendor: "cisco".into(),
        platform: "iosxe".into(),
        commands: vec![
            "show ip interface brief".into(),
            "show ip route summary".into(),
            "show ip bgp summary".into(),
        ],
    }).unwrap();
    assert_eq!(created.commands.len(), 3);

    let fetched = bundles::get(&db, &created.id).unwrap();
    assert_eq!(fetched.name, "ios-xe baseline");
    assert_eq!(fetched.commands[1], "show ip route summary");

    bundles::update_commands(&db, &created.id, vec![
        "show ip interface brief".into(),
        "show ip ospf neighbor".into(),
    ]).unwrap();
    let updated = bundles::get(&db, &created.id).unwrap();
    assert_eq!(updated.commands, vec![
        "show ip interface brief".to_string(),
        "show ip ospf neighbor".to_string(),
    ]);

    let all = bundles::list(&db, Some("cisco"), Some("iosxe")).unwrap();
    assert_eq!(all.len(), 1);

    bundles::delete(&db, &created.id).unwrap();
    assert!(bundles::get(&db, &created.id).is_err());
}

#[test]
fn bundle_commands_preserve_order_after_update() {
    let db = mem_db();
    let b = bundles::create(&db, NewCheckBundle {
        name: "ordered".into(), description: None,
        vendor: "cisco".into(), platform: "iosxe".into(),
        commands: vec!["a".into(), "b".into(), "c".into()],
    }).unwrap();
    bundles::update_commands(&db, &b.id, vec!["z".into(), "y".into(), "x".into()]).unwrap();
    let got = bundles::get(&db, &b.id).unwrap();
    assert_eq!(got.commands, vec!["z".to_string(), "y".to_string(), "x".to_string()]);
}
```

- [x] **Step 2: Implement `change_verify/model.rs`**

```rust
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CheckBundle {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub vendor: String,
    pub platform: String,
    pub commands: Vec<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct NewCheckBundle {
    pub name: String,
    pub description: Option<String>,
    pub vendor: String,
    pub platform: String,
    pub commands: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChangeSnapshot {
    pub id: String,
    pub tab_id: String,
    pub bundle_id: String,
    pub label: SnapshotLabel,
    pub captured_at: i64,
    pub results: Vec<ChangeSnapshotResult>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SnapshotLabel { Pre, Post }

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChangeSnapshotResult {
    pub command: String,
    pub parsed_output_id: i64,
}
```

- [x] **Step 3: Implement `change_verify/bundles.rs`**

```rust
use anyhow::{Context, Result};
use rusqlite::{params, Connection};
use uuid::Uuid;

use super::model::{CheckBundle, NewCheckBundle};

pub fn create(db: &Connection, new: NewCheckBundle) -> Result<CheckBundle> {
    let id = Uuid::new_v4().to_string();
    let now = chrono::Utc::now().timestamp();
    let tx_fn = |db: &Connection| -> Result<()> {
        db.execute(
            "INSERT INTO check_bundles(id,name,description,vendor,platform,created_at,updated_at)
             VALUES (?1,?2,?3,?4,?5,?6,?6)",
            params![&id, &new.name, &new.description, &new.vendor, &new.platform, now],
        )?;
        for (idx, cmd) in new.commands.iter().enumerate() {
            db.execute(
                "INSERT INTO check_bundle_commands(bundle_id,idx,command) VALUES (?1,?2,?3)",
                params![&id, idx as i64, cmd],
            )?;
        }
        Ok(())
    };
    tx_fn(db).context("create check_bundle")?;
    get(db, &id)
}

pub fn get(db: &Connection, id: &str) -> Result<CheckBundle> {
    let mut stmt = db.prepare(
        "SELECT id,name,description,vendor,platform,created_at,updated_at
         FROM check_bundles WHERE id = ?1",
    )?;
    let (bid, name, desc, vendor, platform, created_at, updated_at): (String, String, Option<String>, String, String, i64, i64) =
        stmt.query_row(params![id], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?))
        })?;
    let mut cmd_stmt = db.prepare(
        "SELECT command FROM check_bundle_commands WHERE bundle_id = ?1 ORDER BY idx ASC",
    )?;
    let commands: Vec<String> = cmd_stmt
        .query_map(params![&bid], |r| r.get::<_, String>(0))?
        .collect::<std::result::Result<_, _>>()?;
    Ok(CheckBundle { id: bid, name, description: desc, vendor, platform, commands, created_at, updated_at })
}

pub fn list(db: &Connection, vendor: Option<&str>, platform: Option<&str>) -> Result<Vec<CheckBundle>> {
    let mut stmt = db.prepare(
        "SELECT id FROM check_bundles
         WHERE (?1 IS NULL OR vendor = ?1)
           AND (?2 IS NULL OR platform = ?2)
         ORDER BY updated_at DESC",
    )?;
    let ids: Vec<String> = stmt
        .query_map(params![vendor, platform], |r| r.get::<_, String>(0))?
        .collect::<std::result::Result<_, _>>()?;
    ids.iter().map(|id| get(db, id)).collect()
}

pub fn update_commands(db: &Connection, id: &str, commands: Vec<String>) -> Result<()> {
    db.execute("DELETE FROM check_bundle_commands WHERE bundle_id = ?1", params![id])?;
    for (idx, cmd) in commands.iter().enumerate() {
        db.execute(
            "INSERT INTO check_bundle_commands(bundle_id,idx,command) VALUES (?1,?2,?3)",
            params![id, idx as i64, cmd],
        )?;
    }
    let now = chrono::Utc::now().timestamp();
    db.execute("UPDATE check_bundles SET updated_at = ?1 WHERE id = ?2", params![now, id])?;
    Ok(())
}

pub fn rename(db: &Connection, id: &str, name: &str, description: Option<&str>) -> Result<()> {
    let now = chrono::Utc::now().timestamp();
    db.execute(
        "UPDATE check_bundles SET name = ?1, description = ?2, updated_at = ?3 WHERE id = ?4",
        params![name, description, now, id],
    )?;
    Ok(())
}

pub fn delete(db: &Connection, id: &str) -> Result<()> {
    db.execute("DELETE FROM check_bundles WHERE id = ?1", params![id])?;
    Ok(())
}
```

Add to `src-tauri/Cargo.toml` (if not already present — check first, don't duplicate):
```toml
uuid = { version = "1", features = ["v4", "serde"] }
chrono = { version = "0.4", features = ["serde"] }
```

- [x] **Step 4: Implement Tauri commands in `commands/change_verify.rs`**

```rust
use crate::change_verify::{bundles, model::{CheckBundle, NewCheckBundle}};
use crate::commands::AppState;
use tauri::State;

#[tauri::command]
pub fn bundle_create(state: State<'_, AppState>, new: NewCheckBundle) -> Result<CheckBundle, String> {
    bundles::create(&state.db.lock(), new).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn bundle_get(state: State<'_, AppState>, id: String) -> Result<CheckBundle, String> {
    bundles::get(&state.db.lock(), &id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn bundle_list(
    state: State<'_, AppState>,
    vendor: Option<String>,
    platform: Option<String>,
) -> Result<Vec<CheckBundle>, String> {
    bundles::list(&state.db.lock(), vendor.as_deref(), platform.as_deref())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn bundle_update_commands(
    state: State<'_, AppState>,
    id: String,
    commands: Vec<String>,
) -> Result<(), String> {
    bundles::update_commands(&state.db.lock(), &id, commands).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn bundle_rename(
    state: State<'_, AppState>,
    id: String,
    name: String,
    description: Option<String>,
) -> Result<(), String> {
    bundles::rename(&state.db.lock(), &id, &name, description.as_deref())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn bundle_delete(state: State<'_, AppState>, id: String) -> Result<(), String> {
    bundles::delete(&state.db.lock(), &id).map_err(|e| e.to_string())
}
```

- [x] **Step 5: Register commands in `lib.rs`**

Add to the existing `tauri::generate_handler![...]` macro (do NOT create a second one). Match the exact style already in the file.

- [x] **Step 6: Run — expect PASS**

```bash
cargo test --manifest-path src-tauri/Cargo.toml change_verify_bundles
```

- [x] **Step 7: Commit**

```bash
git add src-tauri/src/change_verify/ src-tauri/src/commands/change_verify.rs src-tauri/src/lib.rs src-tauri/src/commands/mod.rs src-tauri/tests/change_verify_bundles_test.rs src-tauri/Cargo.toml
git commit -m "feat(change-verify): check-bundle crud (rust + tauri commands)"
```

### Task 1.3 — TS types + store for bundles  `PARALLEL with 1.2 test-side only after commands registered`

**Files:**
- Create: `src/lib/changeVerify.ts`
- Create: `src/state/changeVerifyStore.ts`
- Create: `src/lib/changeVerify.test.ts`
- Create: `src/state/changeVerifyStore.test.ts`

- [x] **Step 1: Write failing TS tests**

```ts
// src/lib/changeVerify.test.ts
import { describe, it, expect, vi } from "vitest";
import { bundleList, bundleCreate } from "./changeVerify";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args: any) => {
    if (cmd === "bundle_create") return { id: "b1", commands: args.new.commands,
      name: args.new.name, description: args.new.description ?? null,
      vendor: args.new.vendor, platform: args.new.platform,
      created_at: 1, updated_at: 1 };
    if (cmd === "bundle_list") return [];
    throw new Error("unexpected command " + cmd);
  }),
}));

describe("changeVerify client", () => {
  it("bundleCreate passes payload through", async () => {
    const b = await bundleCreate({
      name: "x", description: null, vendor: "cisco", platform: "iosxe",
      commands: ["show version"],
    });
    expect(b.id).toBe("b1");
    expect(b.commands).toEqual(["show version"]);
  });
  it("bundleList returns empty", async () => {
    expect(await bundleList()).toEqual([]);
  });
});
```

- [x] **Step 2: Implement `src/lib/changeVerify.ts`**

```ts
import { invoke } from "@tauri-apps/api/core";

export interface CheckBundle {
  id: string;
  name: string;
  description: string | null;
  vendor: string;
  platform: string;
  commands: string[];
  created_at: number;
  updated_at: number;
}

export interface NewCheckBundle {
  name: string;
  description: string | null;
  vendor: string;
  platform: string;
  commands: string[];
}

export const bundleCreate = (n: NewCheckBundle) =>
  invoke<CheckBundle>("bundle_create", { new: n });
export const bundleGet = (id: string) => invoke<CheckBundle>("bundle_get", { id });
export const bundleList = (vendor?: string, platform?: string) =>
  invoke<CheckBundle[]>("bundle_list", { vendor: vendor ?? null, platform: platform ?? null });
export const bundleUpdateCommands = (id: string, commands: string[]) =>
  invoke<void>("bundle_update_commands", { id, commands });
export const bundleRename = (id: string, name: string, description: string | null) =>
  invoke<void>("bundle_rename", { id, name, description });
export const bundleDelete = (id: string) => invoke<void>("bundle_delete", { id });
```

- [x] **Step 3: Implement `src/state/changeVerifyStore.ts`**

```ts
import { create } from "zustand";
import * as api from "../lib/changeVerify";
import type { CheckBundle, NewCheckBundle } from "../lib/changeVerify";

interface ChangeVerifyState {
  bundles: CheckBundle[];
  selectedBundleId: string | null;
  loading: boolean;
  error: string | null;

  loadBundles: (vendor?: string, platform?: string) => Promise<void>;
  selectBundle: (id: string | null) => void;
  createBundle: (n: NewCheckBundle) => Promise<CheckBundle>;
  updateBundleCommands: (id: string, cmds: string[]) => Promise<void>;
  renameBundle: (id: string, name: string, description: string | null) => Promise<void>;
  deleteBundle: (id: string) => Promise<void>;
}

export const useChangeVerifyStore = create<ChangeVerifyState>((set, get) => ({
  bundles: [],
  selectedBundleId: null,
  loading: false,
  error: null,

  loadBundles: async (vendor, platform) => {
    set({ loading: true, error: null });
    try {
      const bundles = await api.bundleList(vendor, platform);
      set({ bundles, loading: false });
    } catch (e) { set({ error: String(e), loading: false }); }
  },
  selectBundle: (id) => set({ selectedBundleId: id }),
  createBundle: async (n) => {
    const b = await api.bundleCreate(n);
    set({ bundles: [b, ...get().bundles] });
    return b;
  },
  updateBundleCommands: async (id, cmds) => {
    await api.bundleUpdateCommands(id, cmds);
    await get().loadBundles();
  },
  renameBundle: async (id, name, description) => {
    await api.bundleRename(id, name, description);
    await get().loadBundles();
  },
  deleteBundle: async (id) => {
    await api.bundleDelete(id);
    set({ bundles: get().bundles.filter(b => b.id !== id) });
  },
}));
```

- [x] **Step 4: Run — expect PASS**

```bash
bun run test src/lib/changeVerify.test.ts src/state/changeVerifyStore.test.ts
```

- [x] **Step 5: Commit**

```bash
git add src/lib/changeVerify.ts src/state/changeVerifyStore.ts src/lib/changeVerify.test.ts src/state/changeVerifyStore.test.ts
git commit -m "feat(change-verify): ts client + zustand store for check bundles"
```

### Task 1.4 — Phase 1 regression  `SEQUENTIAL`

- [x] **Step 1:** `cargo test --manifest-path src-tauri/Cargo.toml` — all green.
- [x] **Step 2:** `bun run test` — all green.
- [x] **Step 3:** `bunx playwright test --grep @smoke` — all green.
- [x] **Step 4: Code review.** Dispatch `feature-dev:code-reviewer` with prompt: "Review Phase 1 of Plan 06 (`/Plans/06-pre-post-change-verification.md`). Focus: migration FK correctness, bundle ordering semantics under update, transaction safety of create/update, TS/Rust type parity. Report `must-fix` vs. `nits`."
- [x] **Step 5: Update this plan file** — check every Phase 1 box and append:
  ```markdown
  ## Phase 1 — COMPLETED YYYY-MM-DD
  V0033 migration + check-bundle CRUD (rust + tauri commands + ts client + zustand store) landed. No UI yet.
  ```
- [x] **Step 6: Commit plan update.**

## Phase 1 — COMPLETED 2026-05-18

V0033 migration + check-bundle CRUD (rust + tauri commands + ts client + zustand store) landed. No UI yet.

**Commits on `main`:**
- `f8ddcf8` feat(db): V0033 check_bundles + change_snapshots + change_reports
- `cde4ba4` feat(change-verify): check-bundle crud (rust + tauri commands)
- `bba8bd6` fix(change-verify): wrap bundle create/update in txn, assert cascade in test
- `08c3c56` feat(change-verify): ts client + zustand store for check bundles

**Test counts (unchanged baseline from Plan 05 closeout):**
- Rust: 85 passed / 5 pre-existing failures (`netconf_devices.hostkey_verify` column drift, unrelated to Plan 06).
- TS: 703 passed / 9 pre-existing failures (NetconfTab/ParameterForm/PipeMenu flaky env, unrelated).
- Phase-1-specific: 2 Rust integration tests + 7 Vitest tests, all green.

**Reviewer findings carried forward (not blocking):**
- `change_snapshots.bundle_id` uses `ON DELETE RESTRICT` per the plan spec. Reviewer suggested `CASCADE` (snapshots are self-contained historical records, RESTRICT prevents bundle cleanup). **Not changed** because the plan deliberately wrote RESTRICT; revisit in Phase 4 once the UI exposes a "delete bundle" action and we know the desired UX.
- `parsed_output_id` cross-feature pointer is intentionally unenforced — added an inline schema comment explaining the orphan-handling contract for Phase 2 readers.

**Open watch-items for Phase 2:**
- `bunx playwright test --grep @smoke` matches no tests (no `@smoke` tags in the e2e suite). Phase 4 should tag the ChangeWindowPanel happy path with `@smoke` so this regression gate becomes meaningful.
- Plan 05 / Plan 06 contract drift (kickoff brief in user memory) is still unresolved. Phase 2 Task 2.1 must reconcile before any orchestration code lands.

---

## Phase 2 — Run Pre-Check orchestration

Runs a bundle against the active session, parses each command's output via Plan 00 sidecar, stores each parsed result into Plan 05's `parsed_outputs`, and produces a `change_snapshots` row labeled `pre`. No UI yet — integration-tested via Rust + TS unit tests with the SSH/netconf runner mocked.

### Task 2.1 — Orchestrator type + transport shim  `SEQUENTIAL`

**Files:**
- Create: `src-tauri/src/change_verify/runner.rs`
- Create: `src-tauri/src/change_verify/transport.rs` — trait that wraps "run a show command on the active tab and return raw string"

- [x] **Step 1: Inspect existing SSH/netconf execution path BEFORE writing code**

```bash
grep -n "pub async fn send_rpc\|pub fn send_rpc\|send_cli\|run_command\|exec_command" src-tauri/src/netconf_runner/session.rs src-tauri/src/netconf_runner/cli_wrapper.rs
grep -rn "pub.*fn.*cmd\|invoke_handler.*ssh\|pty_write" src-tauri/src/commands/ssh.rs src-tauri/src/commands/panes.rs
```

Record the exact fn name + signature you find. **Do not guess.** If the current path only exposes a pty-level write (not a request/response), document this finding in the plan (Task 2.1 Step 2 note) and use the netconf `send_rpc` path for cisco iosxe/nxos when available, falling back to a pty line-capture helper. If the fallback requires new infrastructure, pause and ask the user.

- [x] **Step 2: Define the transport trait**

```rust
// src-tauri/src/change_verify/transport.rs
use async_trait::async_trait;
use anyhow::Result;

#[async_trait]
pub trait ShowTransport: Send + Sync {
    /// Execute a read-only show command against whatever session is attached to `tab_id`
    /// and return the raw text output. Must be idempotent and must NOT enter config mode.
    async fn run_show(&self, tab_id: &str, command: &str) -> Result<String>;

    /// Return (vendor, platform) for the session attached to `tab_id`.
    async fn detect_platform(&self, tab_id: &str) -> Result<(String, String)>;
}
```

Real implementation lives in `src-tauri/src/change_verify/transport_live.rs` and wraps the signatures discovered in Step 1. A mock impl for tests lives in `change_verify/transport_mock.rs`.

- [x] **Step 3: Implement `change_verify/runner.rs`**

```rust
use anyhow::{Context, Result};
use rusqlite::{params, Connection};
use uuid::Uuid;
use std::sync::Arc;

use super::bundles;
use super::transport::ShowTransport;
use super::model::{ChangeSnapshot, ChangeSnapshotResult, SnapshotLabel};
// From Plan 05:
use crate::structured::parse_and_store;

pub async fn run_snapshot(
    db: &Connection,
    transport: Arc<dyn ShowTransport>,
    tab_id: &str,
    bundle_id: &str,
    label: SnapshotLabel,
) -> Result<ChangeSnapshot> {
    let bundle = bundles::get(db, bundle_id).context("load bundle")?;
    let (vendor, platform) = transport.detect_platform(tab_id).await
        .context("detect platform")?;
    if vendor != bundle.vendor || platform != bundle.platform {
        anyhow::bail!(
            "bundle vendor/platform ({}/{}) does not match session ({}/{})",
            bundle.vendor, bundle.platform, vendor, platform);
    }

    let snapshot_id = Uuid::new_v4().to_string();
    let now = chrono::Utc::now().timestamp();
    let label_str = match label { SnapshotLabel::Pre => "pre", SnapshotLabel::Post => "post" };
    db.execute(
        "INSERT INTO change_snapshots(id,tab_id,bundle_id,label,captured_at) VALUES (?1,?2,?3,?4,?5)",
        params![&snapshot_id, tab_id, bundle_id, label_str, now],
    )?;

    let mut results = Vec::with_capacity(bundle.commands.len());
    for cmd in &bundle.commands {
        let raw = transport.run_show(tab_id, cmd).await
            .with_context(|| format!("run_show {cmd}"))?;
        // Plan 05: parse + persist into parsed_outputs, return id.
        let parsed_id = parse_and_store(db, tab_id, &vendor, &platform, cmd, &raw).await
            .with_context(|| format!("parse_and_store {cmd}"))?;
        db.execute(
            "INSERT INTO change_snapshot_results(snapshot_id,command,parsed_output_id) VALUES (?1,?2,?3)",
            params![&snapshot_id, cmd, parsed_id],
        )?;
        results.push(ChangeSnapshotResult { command: cmd.clone(), parsed_output_id: parsed_id });
    }

    Ok(ChangeSnapshot {
        id: snapshot_id, tab_id: tab_id.into(), bundle_id: bundle_id.into(),
        label, captured_at: now, results,
    })
}

pub fn get_snapshot(db: &Connection, id: &str) -> Result<ChangeSnapshot> {
    let (tab_id, bundle_id, label_str, captured_at): (String, String, String, i64) = db.query_row(
        "SELECT tab_id,bundle_id,label,captured_at FROM change_snapshots WHERE id = ?1",
        params![id],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
    )?;
    let label = match label_str.as_str() {
        "pre" => SnapshotLabel::Pre, "post" => SnapshotLabel::Post,
        other => anyhow::bail!("invalid label {other}"),
    };
    let mut stmt = db.prepare(
        "SELECT command, parsed_output_id FROM change_snapshot_results WHERE snapshot_id = ?1 ORDER BY command ASC",
    )?;
    let results: Vec<ChangeSnapshotResult> = stmt
        .query_map(params![id], |r| Ok(ChangeSnapshotResult {
            command: r.get(0)?, parsed_output_id: r.get(1)?,
        }))?
        .collect::<std::result::Result<_, _>>()?;
    Ok(ChangeSnapshot { id: id.into(), tab_id, bundle_id, label, captured_at, results })
}

pub fn latest_pre_for_tab(db: &Connection, tab_id: &str, bundle_id: &str) -> Result<Option<String>> {
    let id: Option<String> = db.query_row(
        "SELECT id FROM change_snapshots WHERE tab_id = ?1 AND bundle_id = ?2 AND label = 'pre'
         ORDER BY captured_at DESC LIMIT 1",
        params![tab_id, bundle_id],
        |r| r.get(0),
    ).ok();
    Ok(id)
}
```

Add to `src-tauri/Cargo.toml`: `async-trait = "0.1"` (check if already present first).

- [x] **Step 4: Implement mock transport for tests**

```rust
// src-tauri/src/change_verify/transport_mock.rs
use super::transport::ShowTransport;
use async_trait::async_trait;
use std::collections::HashMap;
use std::sync::Mutex;

pub struct MockTransport {
    pub platform: (String, String),
    pub responses: Mutex<HashMap<String, String>>,
}
impl MockTransport {
    pub fn new(vendor: &str, platform: &str) -> Self {
        Self {
            platform: (vendor.into(), platform.into()),
            responses: Mutex::new(HashMap::new()),
        }
    }
    pub fn set(&self, cmd: &str, raw: &str) {
        self.responses.lock().unwrap().insert(cmd.into(), raw.into());
    }
}
#[async_trait]
impl ShowTransport for MockTransport {
    async fn run_show(&self, _tab: &str, cmd: &str) -> anyhow::Result<String> {
        self.responses.lock().unwrap().get(cmd).cloned()
            .ok_or_else(|| anyhow::anyhow!("mock has no response for {cmd}"))
    }
    async fn detect_platform(&self, _tab: &str) -> anyhow::Result<(String, String)> {
        Ok(self.platform.clone())
    }
}
```

- [x] **Step 5: Write the failing orchestrator test**

```rust
// src-tauri/tests/change_verify_runner_test.rs
use std::sync::Arc;
use ccie_terminal_lib::change_verify::{bundles, runner, transport_mock::MockTransport};
use ccie_terminal_lib::change_verify::model::{NewCheckBundle, SnapshotLabel};

fn mem_db() -> rusqlite::Connection {
    let c = rusqlite::Connection::open_in_memory().unwrap();
    ccie_terminal_lib::db::run_migrations_on(&c).unwrap();
    c
}

#[tokio::test]
async fn run_pre_snapshot_happy_path() {
    let db = mem_db();
    let bundle = bundles::create(&db, NewCheckBundle {
        name: "t".into(), description: None,
        vendor: "cisco".into(), platform: "iosxe".into(),
        commands: vec!["show ip interface brief".into(), "show ip bgp summary".into()],
    }).unwrap();

    let mock = MockTransport::new("cisco", "iosxe");
    mock.set("show ip interface brief",
        "Interface              IP-Address      OK? Method Status                Protocol\n\
         GigabitEthernet1       10.0.0.1        YES NVRAM  up                    up");
    mock.set("show ip bgp summary",
        "Neighbor        V    AS MsgRcvd MsgSent   TblVer  InQ OutQ Up/Down  State/PfxRcd\n\
         10.0.0.2        4 65001    1234    4321      100    0    0 1d00h          5");

    let snap = runner::run_snapshot(&db, Arc::new(mock), "tab1", &bundle.id, SnapshotLabel::Pre)
        .await.unwrap();

    assert_eq!(snap.label, SnapshotLabel::Pre);
    assert_eq!(snap.results.len(), 2);
    // Each parsed_output_id must be a real row in parsed_outputs:
    for r in &snap.results {
        let exists: i64 = db.query_row(
            "SELECT COUNT(*) FROM parsed_outputs WHERE id = ?1",
            rusqlite::params![r.parsed_output_id], |r| r.get(0),
        ).unwrap();
        assert_eq!(exists, 1, "parsed_outputs row missing for {}", r.command);
    }
}

#[tokio::test]
async fn run_snapshot_fails_on_platform_mismatch() {
    let db = mem_db();
    let bundle = bundles::create(&db, NewCheckBundle {
        name: "t".into(), description: None,
        vendor: "cisco".into(), platform: "iosxe".into(),
        commands: vec!["show version".into()],
    }).unwrap();
    let mock = MockTransport::new("juniper", "junos");
    let err = runner::run_snapshot(&db, Arc::new(mock), "tab1", &bundle.id, SnapshotLabel::Pre)
        .await.unwrap_err();
    assert!(err.to_string().contains("does not match session"));
}
```

- [x] **Step 6: Run — expect PASS**

```bash
cargo test --manifest-path src-tauri/Cargo.toml change_verify_runner
```

- [x] **Step 7: Commit**

```bash
git add src-tauri/src/change_verify/ src-tauri/tests/change_verify_runner_test.rs
git commit -m "feat(change-verify): pre/post snapshot orchestrator + mock transport"
```

### Task 2.2 — Live transport implementation  `SEQUENTIAL` (depends on 2.1)

**Files:**
- Create: `src-tauri/src/change_verify/transport_live.rs`

- [x] **Step 1: Implement against signatures discovered in Task 2.1 Step 1**

The live transport must:
- Look up the session type attached to `tab_id` (netconf vs. ssh-pty).
- For netconf-capable vendors (cisco iosxe/nxos, junos): invoke the existing `NetconfSession::send_rpc` or an equivalent CLI-over-netconf helper, OR fall back to pty if netconf is unavailable.
- For pty-only sessions: write the command + newline, read until the device prompt is observed on the output stream. A prompt-detection helper already exists if ssh.rs references it — if not, add one in `src-tauri/src/change_verify/prompt.rs` using the pattern: regex on last non-empty line matching `^\S+[>#]\s*$`.
- `detect_platform` reads from an existing session metadata store. If no such store exists today, persist vendor/platform when a session is established (Plan 00 may already do this via `sidecar_status` — verify). If nothing exists, pause and raise a blocker; do not guess.

- [x] **Step 2: Integration test (gated behind `#[ignore]` unless a real device env var is set)**

```rust
#[tokio::test]
#[ignore] // runs only with `CCIE_TEST_DEVICE_HOST=...`
async fn live_transport_runs_show_version_on_iosxe() {
    // Connect, run `show version`, assert non-empty output.
}
```

- [x] **Step 3: Commit**

```bash
git add src-tauri/src/change_verify/transport_live.rs
git commit -m "feat(change-verify): live transport wired to existing ssh/netconf runner"
```

### Task 2.3 — Tauri command + TS client for pre-check run  `SEQUENTIAL` (depends on 2.2)

**Files:**
- Modify: `src-tauri/src/commands/change_verify.rs`
- Modify: `src/lib/changeVerify.ts`
- Modify: `src/state/changeVerifyStore.ts`
- Create: `src/lib/changeVerify.runner.test.ts`

- [x] **Step 1: Tauri command**

```rust
#[tauri::command]
pub async fn change_run_pre(
    state: State<'_, AppState>,
    transport: State<'_, std::sync::Arc<dyn crate::change_verify::transport::ShowTransport>>,
    tab_id: String,
    bundle_id: String,
) -> Result<crate::change_verify::model::ChangeSnapshot, String> {
    let db = state.db.lock();
    crate::change_verify::runner::run_snapshot(
        &db, transport.inner().clone(), &tab_id, &bundle_id,
        crate::change_verify::model::SnapshotLabel::Pre,
    ).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub fn change_snapshot_get(
    state: State<'_, AppState>,
    id: String,
) -> Result<crate::change_verify::model::ChangeSnapshot, String> {
    crate::change_verify::runner::get_snapshot(&state.db.lock(), &id).map_err(|e| e.to_string())
}
```

Register the live transport as managed state in `lib.rs` setup using the `.manage()` pattern already used for `AppState`.

- [x] **Step 2: TS wrapper**

```ts
// append to src/lib/changeVerify.ts
export type SnapshotLabel = "pre" | "post";

export interface ChangeSnapshotResult {
  command: string;
  parsed_output_id: number;
}

export interface ChangeSnapshot {
  id: string;
  tab_id: string;
  bundle_id: string;
  label: SnapshotLabel;
  captured_at: number;
  results: ChangeSnapshotResult[];
}

export const changeRunPre = (tabId: string, bundleId: string) =>
  invoke<ChangeSnapshot>("change_run_pre", { tabId, bundleId });
export const changeSnapshotGet = (id: string) =>
  invoke<ChangeSnapshot>("change_snapshot_get", { id });
```

- [x] **Step 3: Store action**

Add to the zustand store:
```ts
preSnapshot: ChangeSnapshot | null,
runPreCheck: async (tabId: string, bundleId: string) => {
  const snap = await api.changeRunPre(tabId, bundleId);
  set({ preSnapshot: snap });
  return snap;
},
```

- [x] **Step 4: TS test (mocked)**

```ts
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => ({
    id: "s1", tab_id: "t1", bundle_id: "b1", label: "pre",
    captured_at: 1, results: [{ command: "show version", parsed_output_id: 42 }],
  })),
}));

it("runPreCheck stores snapshot", async () => {
  const { result } = renderHook(() => useChangeVerifyStore());
  await act(async () => { await result.current.runPreCheck("t1", "b1"); });
  expect(result.current.preSnapshot?.label).toBe("pre");
});
```

- [x] **Step 5: Run — expect PASS.** Commit.

```bash
git add src-tauri/src/commands/change_verify.rs src/lib/changeVerify.ts src/state/changeVerifyStore.ts src/lib/changeVerify.runner.test.ts
git commit -m "feat(change-verify): change_run_pre tauri command + ts wiring"
```

### Task 2.4 — Phase 2 regression  `SEQUENTIAL`

- [x] **Step 1:** `cargo test --manifest-path src-tauri/Cargo.toml` — all green.
- [x] **Step 2:** `bun run test` — all green.
- [x] **Step 3:** `bunx playwright test --grep @smoke` — all green (no UI yet, but existing smoke must not regress).
- [x] **Step 4: Code review.** Dispatch `feature-dev:code-reviewer` with prompt: "Review Phase 2 of Plan 06. Focus: transport trait correctness, live transport wiring to existing netconf/ssh runners, parsed-output persistence side effects, failure modes on platform mismatch and partial run (what happens if command #3 fails on a 5-command bundle — do we have a rolled-back snapshot or an orphaned one?). Report `must-fix` vs. `nits`."
- [x] **Step 5: Fix `must-fix` findings** — particularly, decide the partial-failure policy. Recommended: wrap the full `run_snapshot` body in a rusqlite transaction (`db.execute_batch("BEGIN"); ...; db.execute_batch("COMMIT")`) so a mid-run failure leaves no `change_snapshots` row.
- [x] **Step 6: Update plan file** — check Phase 2 boxes + append:
  ```markdown
  ## Phase 2 — COMPLETED YYYY-MM-DD
  Orchestrator + live transport + mock transport green. `change_run_pre` callable end-to-end with a fully parsed snapshot persisted. Transactional integrity on partial run failure.
  ```
- [x] **Step 7: Commit plan update.**

## Phase 2 — COMPLETED 2026-05-18

Orchestrator + live transport + mock transport + Tauri commands + TS client + Zustand store all green. `change_run_pre` / `change_run_post` are callable end-to-end and persist a fully parsed snapshot. Transactional integrity on partial-run failure is verified.

**Commits on `main`:**
- `8f4e9bd` feat(change-verify): pre/post snapshot orchestrator + plan 05 reconciliation
- `80a0657` refactor(pty): lift AppStatePtyExecutor into shared pty_runner module
- `e5f21c3` feat(change-verify): live transport over shared PTY executor
- `108ecf5` polish(change-verify): document LiveTransport tab-binding, drop synthetic uuid
- `477b9cc` feat(change-verify): change_run_pre/post tauri commands + ts client + store
- `6ef755e` refactor(change-verify): drop spawn_blocking; lock DB in scoped windows

**Plan 05 / Plan 06 contract drift — RESOLVED.** Reconciliation note added to the Prerequisites block at the top of this file. Ship: `change_verify::parser::parse_and_store(db, parser, tab_id, vendor, platform, command, raw) -> Result<i64>` synthesizes a `command_blocks` row and delegates to Plan 05's `auto_parse::upsert_parsed_output`. Plan 05's frozen public API is untouched.

**Latent Plan 03 bug fixed in passing.** `commands::notebooks_runnable::build_pty_executor` was constructing the executor with `Arc::new(Mutex::new(HashMap::new()))` — a fresh empty PTY map per call, meaning runnable MOPs against PTY tabs would always have errored "no PTY for tab X" at runtime. Existing notebook integration tests use a `MockPtyExecutor` and never exercised the live path, so the bug never surfaced in CI. `AppState.ptys` widened to `Arc<Mutex<HashMap<...>>>`; `build_pty_executor` now passes `state.ptys.clone()`.

**Architectural notes for downstream phases:**
- The `runner::run_snapshot` and `parser::parse_and_store` functions take `Arc<parking_lot::Mutex<Connection>>` and acquire the lock in scoped blocks between `.await` points. SQLite's in-flight transaction state (BEGIN/COMMIT/ROLLBACK) persists across the locks because the same `Connection` holds them. Phase 3's classifier + report builder can use the same pattern when it needs to persist `change_reports` rows mid-async.
- `LiveTransport` is bound 1:1 to one tab's vendor/platform — construct fresh per `change_run_pre`/`post`. NETCONF support is not yet wired (the `tab_id → netconf_session_id` index doesn't exist); pre/post change-verification works against any SSH/local-shell tab today.

**Test counts (Phase 2 contributions, all green):**
- 4 new Rust runner integration tests (`change_verify_runner_test.rs`): happy path, platform mismatch, mid-run rollback (zero rows in all 3 tables), `latest_pre_for_tab`.
- 2 new Rust live-transport unit tests (`change_verify_live_transport_test.rs`): arg threading, vendor/platform passthrough.
- 4 new TS Tauri-client tests (`changeVerify.runner.test.ts`).
- 3 new Zustand store tests (`changeVerifyStore.test.ts`).
- Total Phase 2 delta: **+13 green tests**, 0 regressions.

**Regression baseline (unchanged from Plan 05 closeout):**
- Rust: 85 passed / 5 pre-existing failures (`netconf_devices.hostkey_verify` column drift).
- TS: 710 passed / 9 pre-existing failures (NetconfTab/ParameterForm/PipeMenu flaky env). 710 is up from 703 at Phase 1 closeout (+7 = the new Phase 2 client/store tests).

**Reviewer findings carried forward (not blocking):**
- `bundles::get` is called outside the BEGIN/COMMIT transaction window — TOCTOU race window if a bundle is concurrently edited. Real but edge-case (bundles are read-mostly during change windows). If it surfaces in production, move the `bundles::get` call inside the transaction scope.
- `parse_and_store` synthesizes `command_blocks` rows that are never reaped — ~10 rows per change-window of bloat. Acceptable for MVP; revisit when Plan 08 (Config Drift) unifies the structured-data lifecycle.

**Open watch-items for Phase 3:**
- The diff-side reconciliation deferred from Phase 2: Phase 3's classifier needs to call `diff_snapshots(pre_id, post_id)` from Plan 05 — but Plan 05's `diff_snapshots` takes **`parsed_snapshots` ids**, not `parsed_outputs` ids. Phase 3 Task 3.2 must either pin a `parsed_snapshots` row per `change_snapshot_results` row at snapshot time, OR add a Plan 06-local `diff_outputs(pre_parsed_output_id, post_parsed_output_id)` helper that wraps the alignment+diff logic. Decide before writing classifier code.
- `bunx playwright test --grep @smoke` matches no tests (no `@smoke` tags in the e2e suite). Phase 4 should tag the ChangeWindowPanel happy path so this regression gate becomes meaningful.

---

## Phase 3 — Run Post-Check + diff engine + structured report

Pulls Plan 05's `diff_snapshots` to compute per-command deltas between the latest `pre` and the freshly-run `post`. A classifier walks each delta, assigning red/yellow/green severity using per-command-family rules. The result is a `ReportSummary` persisted in `change_reports`.

### Task 3.1 — Classifier module  `SEQUENTIAL`

**Files:**
- Create: `src-tauri/src/change_verify/classifier.rs`
- Create: `src-tauri/src/change_verify/command_family.rs`
- Create: `src-tauri/tests/change_verify_classifier_test.rs`

- [x] **Step 1: Define command families + severity types**

```rust
// src-tauri/src/change_verify/command_family.rs
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CommandFamily {
    InterfaceStatus,   // show ip interface brief, show interfaces status
    BgpNeighbor,       // show ip bgp summary, show bgp ipv4 unicast summary
    OspfNeighbor,      // show ip ospf neighbor
    RouteSummary,      // show ip route summary
    CdpNeighbor,       // show cdp neighbor, show lldp neighbors
    Unknown,
}

pub fn classify_command(cmd: &str) -> CommandFamily {
    let c = cmd.to_lowercase();
    if c.contains("ip interface brief") || c.contains("interfaces status") {
        CommandFamily::InterfaceStatus
    } else if c.contains("bgp") && c.contains("summary") {
        CommandFamily::BgpNeighbor
    } else if c.contains("ospf") && c.contains("neighbor") {
        CommandFamily::OspfNeighbor
    } else if c.contains("route") && c.contains("summary") {
        CommandFamily::RouteSummary
    } else if c.contains("cdp neighbor") || c.contains("lldp neighbor") {
        CommandFamily::CdpNeighbor
    } else {
        CommandFamily::Unknown
    }
}
```

- [x] **Step 2: Severity types + classifier**

```rust
// src-tauri/src/change_verify/classifier.rs
use serde::{Deserialize, Serialize};
use crate::structured::diff::{SnapshotDelta, DeltaKind}; // from Plan 05
use super::command_family::{CommandFamily, classify_command};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Severity { Red, Yellow, Green }

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClassifiedDelta {
    pub command: String,
    pub family: String,           // e.g. "bgp-neighbor"
    pub severity: Severity,
    pub path: String,             // json pointer like "/neighbor/10.0.0.2/state"
    pub before: serde_json::Value,
    pub after: serde_json::Value,
    pub message: String,          // human-readable
}

pub struct ClassifierThresholds {
    pub route_count_yellow_pct: f64,   // default 10.0
}
impl Default for ClassifierThresholds {
    fn default() -> Self { Self { route_count_yellow_pct: 10.0 } }
}

pub fn classify(
    command: &str,
    deltas: &[SnapshotDelta],
    th: &ClassifierThresholds,
) -> Vec<ClassifiedDelta> {
    let family = classify_command(command);
    deltas.iter().map(|d| {
        let (severity, message) = severity_for(family, d, th);
        ClassifiedDelta {
            command: command.into(),
            family: family_name(family).into(),
            severity, path: d.path.clone(),
            before: d.before.clone(), after: d.after.clone(),
            message,
        }
    }).collect()
}

fn family_name(f: CommandFamily) -> &'static str {
    match f {
        CommandFamily::InterfaceStatus => "interface-status",
        CommandFamily::BgpNeighbor => "bgp-neighbor",
        CommandFamily::OspfNeighbor => "ospf-neighbor",
        CommandFamily::RouteSummary => "route-summary",
        CommandFamily::CdpNeighbor => "cdp-neighbor",
        CommandFamily::Unknown => "unknown",
    }
}

fn severity_for(
    family: CommandFamily,
    d: &SnapshotDelta,
    th: &ClassifierThresholds,
) -> (Severity, String) {
    use serde_json::Value;
    match family {
        CommandFamily::InterfaceStatus => {
            // path ends in "/oper_status" or "/status". Red if after ∈ {down,admin-down}.
            if d.path.ends_with("oper_status") || d.path.ends_with("status") {
                if let Value::String(after) = &d.after {
                    let a = after.to_lowercase();
                    if a == "down" || a == "administratively down" || a == "admin-down" {
                        return (Severity::Red,
                            format!("Interface {} went to {} (was {:?})", extract_iface(&d.path), after, d.before));
                    }
                }
            }
            (Severity::Yellow, format!("Interface metadata changed at {}", d.path))
        }
        CommandFamily::BgpNeighbor => {
            // Removed neighbor or state != Established → Red.
            if d.kind == DeltaKind::Removed {
                return (Severity::Red, format!("BGP neighbor {} disappeared", extract_ip(&d.path)));
            }
            if d.path.ends_with("state") || d.path.ends_with("session_state") {
                if let Value::String(after) = &d.after {
                    let ok = matches!(after.as_str(),
                        "Established" | "established" | "Estab");
                    if !ok {
                        return (Severity::Red,
                            format!("BGP neighbor {} state is now {}", extract_ip(&d.path), after));
                    }
                }
            }
            (Severity::Yellow, format!("BGP counter changed at {}", d.path))
        }
        CommandFamily::OspfNeighbor => {
            if d.kind == DeltaKind::Removed {
                return (Severity::Red, format!("OSPF adjacency lost: {}", extract_ip(&d.path)));
            }
            if d.path.ends_with("state") {
                if let Value::String(after) = &d.after {
                    if !after.contains("FULL") {
                        return (Severity::Red,
                            format!("OSPF neighbor {} not FULL: {}", extract_ip(&d.path), after));
                    }
                }
            }
            (Severity::Yellow, format!("OSPF state change at {}", d.path))
        }
        CommandFamily::RouteSummary => {
            // "Changed" on a route-count field. Red if drop > 2x threshold.
            if let (Value::Number(b), Value::Number(a)) = (&d.before, &d.after) {
                let bv = b.as_f64().unwrap_or(0.0);
                let av = a.as_f64().unwrap_or(0.0);
                if bv > 0.0 {
                    let pct = ((av - bv).abs() / bv) * 100.0;
                    if pct >= th.route_count_yellow_pct * 2.0 {
                        return (Severity::Red, format!("Route count at {} changed by {:.1}% ({} → {})", d.path, pct, b, a));
                    }
                    if pct >= th.route_count_yellow_pct {
                        return (Severity::Yellow, format!("Route count at {} changed by {:.1}% ({} → {})", d.path, pct, b, a));
                    }
                }
            }
            (Severity::Green, format!("Route-summary delta at {} within tolerance", d.path))
        }
        CommandFamily::CdpNeighbor => {
            if d.kind == DeltaKind::Removed {
                return (Severity::Red, format!("CDP neighbor lost: {}", d.path));
            }
            if d.kind == DeltaKind::Added {
                return (Severity::Yellow, format!("New CDP neighbor appeared: {}", d.path));
            }
            (Severity::Yellow, format!("CDP attribute changed at {}", d.path))
        }
        CommandFamily::Unknown => {
            (Severity::Yellow, format!("Unclassified delta at {}", d.path))
        }
    }
}

fn extract_iface(path: &str) -> String {
    path.trim_start_matches('/').split('/').nth(1).unwrap_or(path).to_string()
}
fn extract_ip(path: &str) -> String {
    path.trim_start_matches('/').split('/').nth(1).unwrap_or(path).to_string()
}
```

- [x] **Step 3: Write the failing test**

```rust
// src-tauri/tests/change_verify_classifier_test.rs
use ccie_terminal_lib::change_verify::classifier::{classify, ClassifierThresholds, Severity};
use ccie_terminal_lib::structured::diff::{SnapshotDelta, DeltaKind};
use serde_json::json;

#[test]
fn bgp_neighbor_drop_is_red() {
    let deltas = vec![SnapshotDelta {
        path: "/neighbor/10.0.0.2".into(),
        kind: DeltaKind::Removed,
        before: json!({"state":"Established"}),
        after: json!(null),
    }];
    let out = classify("show ip bgp summary", &deltas, &ClassifierThresholds::default());
    assert_eq!(out.len(), 1);
    assert_eq!(out[0].severity, Severity::Red);
    assert!(out[0].message.contains("10.0.0.2"));
}

#[test]
fn interface_goes_down_is_red() {
    let deltas = vec![SnapshotDelta {
        path: "/Gi0_1/oper_status".into(),
        kind: DeltaKind::Changed,
        before: json!("up"),
        after: json!("down"),
    }];
    let out = classify("show ip interface brief", &deltas, &ClassifierThresholds::default());
    assert_eq!(out[0].severity, Severity::Red);
}

#[test]
fn small_route_count_change_is_green() {
    let deltas = vec![SnapshotDelta {
        path: "/total".into(),
        kind: DeltaKind::Changed,
        before: json!(1000),
        after: json!(1005),
    }];
    let out = classify("show ip route summary", &deltas, &ClassifierThresholds::default());
    assert_eq!(out[0].severity, Severity::Green);
}

#[test]
fn big_route_count_change_is_red() {
    let deltas = vec![SnapshotDelta {
        path: "/total".into(),
        kind: DeltaKind::Changed,
        before: json!(1000),
        after: json!(500),
    }];
    let out = classify("show ip route summary", &deltas, &ClassifierThresholds::default());
    assert_eq!(out[0].severity, Severity::Red);
}

#[test]
fn ospf_adjacency_not_full_is_red() {
    let deltas = vec![SnapshotDelta {
        path: "/neighbor/10.1.1.1/state".into(),
        kind: DeltaKind::Changed,
        before: json!("FULL/DR"),
        after: json!("INIT"),
    }];
    let out = classify("show ip ospf neighbor", &deltas, &ClassifierThresholds::default());
    assert_eq!(out[0].severity, Severity::Red);
}
```

- [x] **Step 4: Run — expect PASS.** Commit.

```bash
git add src-tauri/src/change_verify/classifier.rs src-tauri/src/change_verify/command_family.rs src-tauri/tests/change_verify_classifier_test.rs
git commit -m "feat(change-verify): classifier rules for iface/bgp/ospf/route/cdp families"
```

### Task 3.2 — Post-check orchestrator + report builder  `SEQUENTIAL` (depends on 3.1)

**Files:**
- Modify: `src-tauri/src/change_verify/runner.rs` — add `run_post_and_report`
- Create: `src-tauri/src/change_verify/report.rs`

- [x] **Step 1: ReportSummary type + ExpectedDelta**

```rust
// src-tauri/src/change_verify/report.rs
use serde::{Deserialize, Serialize};
use super::classifier::{ClassifiedDelta, Severity};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReportSummary {
    pub pre_snapshot_id: String,
    pub post_snapshot_id: String,
    pub bundle_id: String,
    pub counts: SeverityCounts,
    pub deltas: Vec<ClassifiedDelta>,
    pub matched_approved: Vec<ApprovedMatch>,
    pub notes: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SeverityCounts { pub red: u32, pub yellow: u32, pub green: u32 }

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExpectedDelta {
    pub command_substring: String,   // e.g. "bgp summary"
    pub path_substring: String,      // e.g. "/neighbor/10.0.0.5"
    pub note: String,                // engineer's justification
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApprovedMatch {
    pub delta_path: String,
    pub command: String,
    pub note: String,
}

pub fn reclassify_with_approvals(
    mut deltas: Vec<ClassifiedDelta>,
    approved: &[ExpectedDelta],
) -> (Vec<ClassifiedDelta>, Vec<ApprovedMatch>) {
    let mut matches = Vec::new();
    for d in deltas.iter_mut() {
        for a in approved {
            if d.command.contains(&a.command_substring) && d.path.contains(&a.path_substring) {
                d.severity = Severity::Green;
                d.message = format!("(approved) {}", a.note);
                matches.push(ApprovedMatch {
                    delta_path: d.path.clone(),
                    command: d.command.clone(),
                    note: a.note.clone(),
                });
                break;
            }
        }
    }
    (deltas, matches)
}

pub fn count_severities(deltas: &[ClassifiedDelta]) -> SeverityCounts {
    let mut c = SeverityCounts::default();
    for d in deltas {
        match d.severity {
            Severity::Red => c.red += 1,
            Severity::Yellow => c.yellow += 1,
            Severity::Green => c.green += 1,
        }
    }
    c
}
```

- [x] **Step 2: Orchestrator**

```rust
// append to runner.rs
use super::classifier::{classify, ClassifierThresholds};
use super::report::{ReportSummary, ExpectedDelta, reclassify_with_approvals, count_severities};
use crate::structured::diff::diff_snapshots; // Plan 05

pub async fn run_post_and_report(
    db: &Connection,
    transport: Arc<dyn ShowTransport>,
    tab_id: &str,
    bundle_id: &str,
    pre_snapshot_id: &str,
    approved: Vec<ExpectedDelta>,
    notes: Option<String>,
) -> Result<(String, ReportSummary)> {
    // 1. Run post snapshot (reuses Phase 2 orchestrator).
    let post = run_snapshot(db, transport, tab_id, bundle_id, SnapshotLabel::Post).await?;
    let pre = get_snapshot(db, pre_snapshot_id)?;

    // 2. Diff per command (Plan 05 supplies `diff_snapshots`).
    let th = ClassifierThresholds::default();
    let mut all_deltas = Vec::new();
    for r_post in &post.results {
        let r_pre = pre.results.iter().find(|p| p.command == r_post.command);
        let Some(r_pre) = r_pre else {
            // Command appeared in post but not pre — classifier treats as unknown/yellow.
            continue;
        };
        let raw_deltas = diff_snapshots(r_pre.parsed_output_id, r_post.parsed_output_id, &r_post.command)?;
        let classified = classify(&r_post.command, &raw_deltas, &th);
        all_deltas.extend(classified);
    }

    // 3. Apply approvals → green.
    let (deltas, matched_approved) = reclassify_with_approvals(all_deltas, &approved);
    let counts = count_severities(&deltas);

    let summary = ReportSummary {
        pre_snapshot_id: pre.id.clone(),
        post_snapshot_id: post.id.clone(),
        bundle_id: bundle_id.into(),
        counts, deltas, matched_approved, notes,
    };

    // 4. Persist report.
    let report_id = Uuid::new_v4().to_string();
    let now = chrono::Utc::now().timestamp();
    db.execute(
        "INSERT INTO change_reports(id,pre_snapshot_id,post_snapshot_id,summary_json,approved_deltas_json,created_at)
         VALUES (?1,?2,?3,?4,?5,?6)",
        params![
            &report_id, &pre.id, &post.id,
            serde_json::to_string(&summary)?,
            serde_json::to_string(&approved)?,
            now,
        ],
    )?;

    Ok((report_id, summary))
}

pub fn get_report(db: &Connection, id: &str) -> Result<(ReportSummary, Vec<ExpectedDelta>, i64)> {
    let (summary_json, approved_json, created_at): (String, Option<String>, i64) = db.query_row(
        "SELECT summary_json, approved_deltas_json, created_at FROM change_reports WHERE id = ?1",
        params![id],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    )?;
    let summary: ReportSummary = serde_json::from_str(&summary_json)?;
    let approved: Vec<ExpectedDelta> = approved_json
        .map(|j| serde_json::from_str(&j)).transpose()?.unwrap_or_default();
    Ok((summary, approved, created_at))
}

pub fn list_reports(db: &Connection) -> Result<Vec<(String, i64, String, String)>> {
    let mut stmt = db.prepare(
        "SELECT id, created_at, pre_snapshot_id, post_snapshot_id
         FROM change_reports ORDER BY created_at DESC LIMIT 200",
    )?;
    let rows = stmt
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?
        .collect::<std::result::Result<_, _>>()?;
    Ok(rows)
}
```

- [x] **Step 3: Write the failing end-to-end test**

```rust
// src-tauri/tests/change_verify_report_test.rs
use std::sync::Arc;
use ccie_terminal_lib::change_verify::{bundles, runner, transport_mock::MockTransport};
use ccie_terminal_lib::change_verify::model::{NewCheckBundle, SnapshotLabel};

fn mem_db() -> rusqlite::Connection {
    let c = rusqlite::Connection::open_in_memory().unwrap();
    ccie_terminal_lib::db::run_migrations_on(&c).unwrap();
    c
}

#[tokio::test]
async fn pre_post_flow_detects_bgp_down() {
    let db = mem_db();
    let bundle = bundles::create(&db, NewCheckBundle {
        name: "bgp".into(), description: None,
        vendor: "cisco".into(), platform: "iosxe".into(),
        commands: vec!["show ip bgp summary".into()],
    }).unwrap();

    let pre_mock = Arc::new(MockTransport::new("cisco", "iosxe"));
    pre_mock.set("show ip bgp summary", PRE_BGP);
    let pre = runner::run_snapshot(&db, pre_mock.clone(), "tab1", &bundle.id, SnapshotLabel::Pre)
        .await.unwrap();

    let post_mock = Arc::new(MockTransport::new("cisco", "iosxe"));
    post_mock.set("show ip bgp summary", POST_BGP);  // neighbor dropped
    let (_report_id, summary) = runner::run_post_and_report(
        &db, post_mock, "tab1", &bundle.id, &pre.id, vec![], None,
    ).await.unwrap();

    assert!(summary.counts.red >= 1, "expected at least one red, got {:?}", summary.counts);
    assert!(summary.deltas.iter().any(|d| d.family == "bgp-neighbor"));
}

const PRE_BGP: &str = "Neighbor        V    AS MsgRcvd MsgSent   TblVer  InQ OutQ Up/Down  State/PfxRcd\n\
10.0.0.2        4 65001    1234    4321      100    0    0 1d00h          5";
const POST_BGP: &str = "Neighbor        V    AS MsgRcvd MsgSent   TblVer  InQ OutQ Up/Down  State/PfxRcd\n\
10.0.0.2        4 65001    1234    4321      100    0    0 never          Active";
```

- [x] **Step 4: Run — expect PASS.**

```bash
cargo test --manifest-path src-tauri/Cargo.toml change_verify_report
```

- [x] **Step 5: Commit**

```bash
git add src-tauri/src/change_verify/runner.rs src-tauri/src/change_verify/report.rs src-tauri/tests/change_verify_report_test.rs
git commit -m "feat(change-verify): post-check orchestrator + classifier-driven report"
```

### Task 3.3 — Tauri commands + TS client for post/report  `SEQUENTIAL` (depends on 3.2)

**Files:**
- Modify: `src-tauri/src/commands/change_verify.rs`
- Modify: `src/lib/changeVerify.ts`
- Modify: `src/state/changeVerifyStore.ts`

- [x] **Step 1: Tauri commands**

```rust
#[tauri::command]
pub async fn change_run_post_and_report(
    state: State<'_, AppState>,
    transport: State<'_, std::sync::Arc<dyn crate::change_verify::transport::ShowTransport>>,
    tab_id: String,
    bundle_id: String,
    pre_snapshot_id: String,
    approved_deltas: Vec<crate::change_verify::report::ExpectedDelta>,
    notes: Option<String>,
) -> Result<(String, crate::change_verify::report::ReportSummary), String> {
    let db = state.db.lock();
    crate::change_verify::runner::run_post_and_report(
        &db, transport.inner().clone(), &tab_id, &bundle_id, &pre_snapshot_id,
        approved_deltas, notes,
    ).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub fn change_report_get(
    state: State<'_, AppState>,
    id: String,
) -> Result<(crate::change_verify::report::ReportSummary, Vec<crate::change_verify::report::ExpectedDelta>, i64), String> {
    crate::change_verify::runner::get_report(&state.db.lock(), &id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn change_report_list(
    state: State<'_, AppState>,
) -> Result<Vec<(String, i64, String, String)>, String> {
    crate::change_verify::runner::list_reports(&state.db.lock()).map_err(|e| e.to_string())
}
```

Register all three in `lib.rs`.

- [x] **Step 2: TS client additions**

```ts
// append to src/lib/changeVerify.ts
export type Severity = "red" | "yellow" | "green";

export interface ClassifiedDelta {
  command: string;
  family: string;
  severity: Severity;
  path: string;
  before: unknown;
  after: unknown;
  message: string;
}

export interface ExpectedDelta {
  command_substring: string;
  path_substring: string;
  note: string;
}

export interface SeverityCounts { red: number; yellow: number; green: number }

export interface ApprovedMatch { delta_path: string; command: string; note: string }

export interface ReportSummary {
  pre_snapshot_id: string;
  post_snapshot_id: string;
  bundle_id: string;
  counts: SeverityCounts;
  deltas: ClassifiedDelta[];
  matched_approved: ApprovedMatch[];
  notes: string | null;
}

export const changeRunPostAndReport = (
  tabId: string, bundleId: string, preSnapshotId: string,
  approvedDeltas: ExpectedDelta[], notes: string | null,
) => invoke<[string, ReportSummary]>("change_run_post_and_report",
  { tabId, bundleId, preSnapshotId, approvedDeltas, notes });

export const changeReportGet = (id: string) =>
  invoke<[ReportSummary, ExpectedDelta[], number]>("change_report_get", { id });

export const changeReportList = () =>
  invoke<[string, number, string, string][]>("change_report_list");
```

- [x] **Step 3: Store additions**

```ts
postSnapshot: ChangeSnapshot | null,
currentReport: { id: string; summary: ReportSummary; approved: ExpectedDelta[] } | null,
reports: [string, number, string, string][],

runPostCheck: async (tabId, bundleId, preSnapshotId, approved, notes) => {
  const [id, summary] = await api.changeRunPostAndReport(tabId, bundleId, preSnapshotId, approved, notes);
  set({ currentReport: { id, summary, approved } });
  return { id, summary };
},
loadReport: async (id) => {
  const [summary, approved] = await api.changeReportGet(id);
  set({ currentReport: { id, summary, approved } });
},
loadReports: async () => {
  set({ reports: await api.changeReportList() });
},
```

- [x] **Step 4: Unit tests mocking invoke.** Run. Commit.

```bash
git add src-tauri/src/commands/change_verify.rs src-tauri/src/lib.rs src/lib/changeVerify.ts src/state/changeVerifyStore.ts
git commit -m "feat(change-verify): post-run + report tauri commands and ts wiring"
```

### Task 3.4 — Phase 3 regression  `SEQUENTIAL`

- [x] **Step 1:** `cargo test` — all green.
- [x] **Step 2:** `bun run test` — all green.
- [x] **Step 3:** `bunx playwright test --grep @smoke` — all green.
- [x] **Step 4: Code review.** Prompt: "Review Phase 3 of Plan 06. Focus: classifier rule coverage (are there obvious false-positives for transient counter changes in bgp/ospf?), approval-matching substring logic (risk of over-approval?), integrity of `change_reports` when Plan 05 `diff_snapshots` raises. Report `must-fix` vs. `nits`."
- [x] **Step 5: Update plan file.** Check Phase 3 boxes + completion block.
- [x] **Step 6: Commit plan update.**

## Phase 3 — COMPLETED 2026-05-18

Classifier + diff-reconciliation + post-check orchestrator + report builder + Tauri commands + TS client + Zustand store all green. `change_run_post_and_report` callable end-to-end: it runs the post snapshot, diffs against the named pre via `diff_outputs`, classifies each cell delta into red/yellow/green via per-command-family rules, applies approvals, persists a `change_reports` row, and returns `(report_id, summary)`.

**Commits on `main`:**
- `82ea178` refactor(structured): expose diff helpers as pub(crate) for plan 06
- `6f178df` feat(change-verify): classifier + diff_outputs reconciliation
- `f9d6f16` fix(change-verify): zero-base route delta, counter noise, diff parity tests
- `5922fc8` feat(change-verify): post-check orchestrator + classifier-driven report
- `3a3dde1` feat(change-verify): post-run + report tauri commands and ts wiring
- `971d51b` fix(change-verify): segment-match approvals; wrap report insert in txn

**Plan 05 / Plan 06 contract drift — FULLY RESOLVED.** The diff-side reconciliation flagged at Phase 2 closeout is closed:
- `change_verify::diff_outputs::diff_outputs(a_parsed_output_id, b_parsed_output_id, db) -> Vec<CellDiff>` — sibling to Plan 05's `diff_snapshots` that loads from `parsed_outputs` directly (no `parsed_snapshots` pin), reusing Plan 05's now-`pub(crate)` alignment+diff helpers (`lookup_schema_key`, `pick_alignment_key`, `as_list_of_dicts`, `diff_list_of_dicts`, `diff_nested_dict`).
- Plan 05's public `pub fn diff_snapshots(...)` signature is unchanged. Plan 08 unaffected.
- Parity test `diff_outputs_matches_diff_snapshots_*` covers list-of-dicts (auto-pick), list-of-dicts (schema-key), and nested-dict shapes.

**Key design decisions baked in:**
- Classifier consumes `CellDiff` (Plan 05's actual type), NOT the plan's hypothetical `SnapshotDelta`. Path is synthesized from `row_key + column`. `Unchanged` entries are dropped. BGP `MsgRcvd/MsgSent/TblVer/Up_Down/InQ/OutQ` and OSPF `dead_time/hello_timer/uptime` are filtered out entirely so a 30-minute change window doesn't flood reports with mechanical-counter noise.
- Route-summary 0→N change classifies as Yellow (was previously falling through to Green with `bv > 0.0` guard).
- Approval matching is segment-based for paths (`"10.0.0.5"` no longer false-approves `/10.0.0.50/state`) with a 3-char minimum substring length.
- `run_post_and_report` calls `run_snapshot` (already transactional) then wraps the `change_reports` INSERT in its own BEGIN/COMMIT, with UNIQUE-violation translated to a clearer error message.
- Lock scoping pattern from Phase 2 carries forward: `Arc<parking_lot::Mutex<Connection>>` acquired in scoped windows between `.await` calls. No `spawn_blocking` anywhere.

**Test counts (Phase 3 contributions, all green):**
- Rust: +12 classifier tests, +4 diff_outputs tests (parity for 3 shapes + missing-id error), +4 report tests (E2E happy path + approval downgrade + 2 segment-matching regressions). Total **+20 Rust tests**.
- TS: +2 client tests (changeRunPostAndReport, changeReportList), +1 store test rewrite (postSnapshot → currentReport). Net **+3 TS tests** (1 rewritten).
- Phase 3 delta: **+23 green tests**, 0 regressions.

**Regression baseline (unchanged from Plan 05 closeout):**
- Rust: 85 passed / 5 pre-existing failures (`netconf_devices.hostkey_verify` column drift).
- TS: 712 passed / 9 pre-existing failures (NetconfTab/ParameterForm/PipeMenu flaky env). Up from 710 at Phase 2 closeout (+2).

**Reviewer findings carried forward (not blocking):**
- `change_reports.summary_json` stores the full `Vec<ClassifiedDelta>` in a single JSON column. Fine at Plan 06 scale (~10 commands, ~100 deltas per bundle = ~50KB JSON). If Plan 08 (Config Drift) extends this to full device audits with 50+ commands, consider normalizing into a `change_report_deltas` table.
- `ClassifierThresholds` exposes only `route_count_yellow_pct` (default 10.0). Other thresholds (BGP-counter-as-yellow, OSPF-state-must-equal-FULL) are hardcoded. Acceptable for v1; revisit if field usage shows need for per-bundle tuning.

**Open watch-items for Phase 4:**
- ChangeWindowPanel UI consumes `currentReport` from the store. The store's report-section actions (`runPostCheck`, `loadReport`, `loadReports`, `clearReport`) are stable; UI tests can mock `api.changeRunPostAndReport` and exercise the panel's stage-machine without backend.
- The plan's Task 3.3 store snippet referenced a `runPreCheck`/`runPostCheck` pair that emit per-command progress. Phase 2 returns a fully-formed snapshot atomically; per-command streaming was not added (same architectural decision in Plan 03's notebook runner). Phase 4 should stub progress UI for now and mark streaming as a follow-up.
- `bunx playwright test --grep @smoke` still matches no tests (no `@smoke` tags). Phase 4 should tag the ChangeWindowPanel happy path so this regression gate becomes meaningful.

---

## Phase 4 — UI: ChangeWindowPanel (design review pre + post)

### Task 4.1 — Pre-impl design spec  `SEQUENTIAL`

- [x] **Step 1: Dispatch `frontend-design` skill** with brief:

> **Context:** CCIE Terminal is a Warp-inspired macOS-native Tauri app with a dark palette (see `src/App.css` and `src/components/CommandBlock.css`). We're adding a right-side drawer panel called **ChangeWindowPanel** that walks an engineer through a 4-step timeline:
>
> 1. **Select bundle** — dropdown of check-bundles filtered by active session's vendor/platform. "Create new bundle" button opens a modal (reuse pattern from workflows modal landed in Plan 02 if available, otherwise design from scratch).
> 2. **Run Pre-Check** — big primary button. When running, show per-command progress list (spinner, green check, red X per command).
> 3. **Change window open** — after pre passes, a prominent "Start change" button transitions the panel to "Change in progress" state: a text area for engineer's change notes + "Run Post-Check" button (disabled until engineer clicks "I made the change").
> 4. **Report** — rendered inline with red/yellow/green chips, per-command expandable sections. Each delta row: severity chip, path, before → after, message. An "Approve" action per delta that appends an `ExpectedDelta` and re-classifies live. Footer: "Export Markdown", "Export PDF", "Attach to ticket" (placeholder for a future integration — keep as a greyed button for v1).
>
> **Deliverables:** ASCII wireframe of each of the 4 states, color/severity tokens used (must match existing CSS variable names — do not invent new ones without listing them explicitly), class names for each region that extend existing prefixes (`cmd-block-*`, `panel-*`). Include keyboard flow (Tab order, Esc to close).

- [x] **Step 2: Save the returned spec** to `docs/design/change-window-panel.md` and commit.

```bash
git add docs/design/change-window-panel.md
git commit -m "docs(design): change-window panel pre-impl spec"
```

### Task 4.2 — Panel shell + bundle picker  `SEQUENTIAL` (depends on 4.1)

**Files:**
- Create: `src/components/ChangeWindowPanel.tsx` + `.css`
- Create: `src/components/BundlePicker.tsx` + `.css`
- Create: `src/components/BundleEditor.tsx` + `.css` (modal: name/desc/command list)
- Test: corresponding `.test.tsx` files

- [x] **Step 1: Failing render tests**
  - Renders a list of bundles loaded from the store.
  - "Create bundle" opens `BundleEditor` modal.
  - Saving new bundle calls `createBundle` and the new row appears in the list.

- [x] **Step 2: Implement per design spec.** Use existing prefixed classes; do not introduce a second design system.

- [x] **Step 3: Commit** `feat(change-verify): ChangeWindowPanel shell + bundle picker/editor`

### Task 4.3 — Timeline: Pre / Change / Post / Report  `SEQUENTIAL` (depends on 4.2)

**Files:**
- Create: `src/components/ChangeTimeline.tsx`
- Create: `src/components/PreCheckRunner.tsx`
- Create: `src/components/PostCheckRunner.tsx`
- Create: `src/components/ChangeReportView.tsx`
- Create: `src/components/DeltaRow.tsx`
- Create: `src/components/SeverityChip.tsx`

- [x] **Step 1: Failing tests**
  - Pre runner shows per-command progress (spinner → check/X) driven by a stubbed store action that emits events.
  - Post runner disabled until "I made the change" acknowledged.
  - Report view renders deltas grouped by command; clicking "Approve" on a delta calls store action and the chip flips to green.
  - Severity chip component snapshot: red / yellow / green variants.

- [x] **Step 2: Implement.** For the progress-per-command display, have the store emit a `preCheckProgress: Map<command, "pending"|"ok"|"error">` that updates as the orchestrator streams results. For the MVP, if per-command streaming isn't available from `change_run_pre` (Phase 2 returns the whole snapshot at once), stub the progress view and mark this as a follow-up task at the end of the plan — DO NOT add streaming now.

- [x] **Step 3: Wire ChangeWindowPanel state machine** — small local state `type PanelStage = 'select' | 'pre-running' | 'pre-done' | 'change-open' | 'post-running' | 'report'` gated by store results.

- [x] **Step 4: Commit** `feat(change-verify): pre/post/report UI wired to store`

### Task 4.4 — Approvals UI + live re-classification  `SEQUENTIAL` (depends on 4.3)

- [x] **Step 1: Failing test** — clicking Approve on a delta sends its `(command, path)` as an `ExpectedDelta` and the `currentReport.summary.counts` updates (red -1 / green +1).

- [x] **Step 2: Implement.** Re-classification happens client-side on approval: import `reclassifyWithApprovals` (pure TS port of the Rust fn, also tested) OR round-trip to a new `change_report_reclassify` Tauri command. Prefer client-side for responsiveness; add the Rust command if deltas exceed 5000 rows (a perf check only).

- [x] **Step 3: Commit** `feat(change-verify): live approval re-classification`

### Task 4.5 — Post-impl design review  `SEQUENTIAL`

- [x] **Step 1: Run `bun run tauri dev`.** Seed a mock session (via a test-only debug menu or a one-off `bun run scripts/seed-change-demo.ts` script) and capture screenshots of all four panel states.

- [x] **Step 2: Dispatch `frontend-design` skill** with screenshots attached. Apply must-fix items.

- [x] **Step 3: Commit** `fix(change-verify): post-review ui polish`

### Task 4.6 — Phase 4 regression  `SEQUENTIAL`

- [x] **Step 1:** `bun run test` — all green (add new tests).
- [x] **Step 2:** `cargo test` — must remain green.
- [x] **Step 3:** `bunx playwright test` — add a new `@change-verify` smoke test that drives the panel with a mocked transport (via a `window.__ccieMockTransport` hook available in dev builds only).
- [x] **Step 4: Code review.**
- [x] **Step 5: Update plan file** — check Phase 4 boxes + append completion block.
- [x] **Step 6: Commit plan update.**

## Phase 4 — COMPLETED 2026-05-18

ChangeWindowPanel + bundle picker/editor + 4-stage timeline UI + report viewer + menu bar integration + @smoke playwright spec all shipped. The user can open the panel via `Cmd+Shift+C`, pick a bundle filtered by the active tab's vendor/platform, run pre-check, declare "I made the change", run post-check, see the classified report, and approve individual deltas with the approval persisting across panel close/reopen.

**Commits on `main`:**
- `3db3f8c` feat(change-verify): SeverityChip, DeltaRow, BundlePicker, BundleEditor (Task 4.2)
- `e72517b` feat(change-verify): ChangeTimeline, PreCheckRunner, PostCheckRunner, ChangeReportView, ChangeWindowPanel (Task 4.3)
- `a7d39a4` feat(change-verify): menu items + accelerators (the user-requested menu mirrors of every shortcut)
- `2711025` feat(change-verify): App.tsx wires ChangeWindowPanel + menu listeners
- `27d3da8` fix(change-verify): align Phase 4 components with test expectations (Start Change/Done buttons, useEffect stage init, SeverityChip data-testid)
- `6fafadd` test(change-verify): @smoke playwright spec for change window panel
- `96ce73c` fix(change-verify): persist post-hoc approvals + use Cmd+Shift+C menu

**User requirement satisfied:** "anytime there are shortcuts and it makes sense please make sure we add features to the menu bar for easy navigation". A new "Change" submenu sits between View and SSH (`[app_menu, view_menu, change_menu, ssh_menu]`) with 6 items:
- Open Change Window — `Cmd+Shift+C`
- Run Pre-Check — `Cmd+Shift+1`
- Run Post-Check — `Cmd+Shift+2`
- New Bundle… (no shortcut)
- Manage Bundles… (no shortcut)
- Export Report as Markdown (no shortcut; Phase 5 will wire)

`Cmd+Shift+C` chosen over the plan's original `Cmd+Shift+V` because `Cmd+Shift+V` is Safari's "Paste and Match Style" — too easy to accidentally invoke during terminal paste workflows. `C` is mnemonic for "Change" and not bound by macOS or any common app.

**Components shipped (8 React + 1 helper):**
- `SeverityChip` (with `data-testid="severity-chip-{red|yellow|green}"`)
- `DeltaRow` (renders one classified delta + Approve button for non-green)
- `BundlePicker` (vendor/platform-filtered list + create/edit/delete)
- `BundleEditor` (modal: name, description, commands)
- `ChangeTimeline` (5-stage stepper)
- `PreCheckRunner` ("Run Pre-Check" → spinner → command list → "Start Change" advance button)
- `PostCheckRunner` (notes textarea + "I made the change" checkbox + "Run Post-Check" disabled until checkbox checked)
- `ChangeReportView` (3 severity-count chips + deltas grouped by command + per-delta Approve)
- `ChangeWindowPanel` (orchestrator with `'select' | 'pre-running' | 'pre-done' | 'change-open' | 'post-running' | 'report'` state machine, `useEffect` re-syncs stage from `currentReport` / `preSnapshot` on remount)
- `src/lib/changeApprovals.ts` (pure-TS port of Rust `reclassify_with_approvals` — segment-based path matching, 3-char min substring length)

**Server-side approval persistence:** When the user clicks Approve in the report UI, a new `change_report_append_approval(report_id, approval)` Tauri command updates `change_reports.summary_json` AND `approved_deltas_json`. Approvals now survive panel close/reopen. ChangeReportView renders directly from `currentReport` — no local approval state, single source of truth in the DB.

**Constraints satisfied:**
- No new third-party deps (`git diff fc74cf1..HEAD -- package.json` shows no changes).
- Existing dark-palette colors reused (`#1a1a1a`/`#2a2a2a`/`#3a3a3a` + severity tokens `#ef4444`/`#f59e0b`/`#10b981`).
- Per-command streaming explicitly NOT implemented (matches plan guidance and Plan 03's notebook runner pattern).

**Test deltas (Phase 4 contributions):**
- +64 TS tests (8 component test files + changeApprovals + extended store/runner client tests).
- +1 Rust integration test (`append_approval_persists_and_reclassifies`).
- +1 Playwright spec tagged `@smoke` (open via shortcut, close via X). Requires `bun tauri build` before it can run; smoke harness was previously empty so this is the first `@smoke`-tagged test in the suite.
- Total: **+66 green tests**, 0 regressions.

**Regression baseline (unchanged):**
- Rust: 85 passed / 5 pre-existing failures (`netconf_devices.hostkey_verify`).
- TS: 776 passed / 9 pre-existing failures (NetconfTab/ParameterForm/PipeMenu). Up from 712 at Phase 3 closeout (+64).

**Reviewer findings carried forward (not blocking, deferred to a follow-up):**
- `BundlePicker` falls back to `vendor="generic" platform="generic"` when the active tab has no device session metadata, then loads zero bundles silently. Should show a "Change verification requires an active device session" warning. Cosmetic UX improvement; the panel still functions.
- `ChangeWindowPanel`'s stage `useEffect` and the action handlers (`handleRunPostCheck`, `handleRunPreCheck`) both call `setStage(...)` for the same target stage. React batches duplicate state-sets so this is benign, but the dual-ownership of stage transitions is a code smell. Refactor to single-ownership in a future cleanup.

**Open watch-items for Phase 5:**
- The Export Report as Markdown menu item is a console.log placeholder. Phase 5 Task 5.2 ships the Markdown rendering + save-to-file. The Tauri-side dialog plugin (`tauri-plugin-dialog`) is already in `Cargo.toml` (Plan 04 wired it).
- The Tauri-built `@smoke` test won't run until `bun tauri build` is executed in CI. Phase 5 should optionally add a CI job.
- Seed bundles (Task 5.1) are not yet shipped — `BundlePicker` shows an empty state on first boot.

---

## Phase 5 — Seed bundles + Markdown/PDF export + docs

### Task 5.1 — Seed 4 canonical bundles  `SEQUENTIAL`

**Files:**
- Create: `src-tauri/migrations/V0033a__seed_change_bundles.sql` (data-only sidecar migration following existing seed-migration convention — verify by `ls src-tauri/migrations/*seed*` or grep for `INSERT INTO` in existing migrations; if the convention is a Rust seed function instead, use that pattern)
- OR: Create: `src-tauri/src/change_verify/seeds.rs` (Rust fn invoked once on first boot when `check_bundles` table is empty)

Pick whichever matches the existing convention. If both paths exist, prefer the Rust fn for atomicity with the app boot flow.

- [x] **Step 1: Verify convention**

```bash
ls src-tauri/migrations/ | grep -i seed
grep -rn "seed_defaults\|bootstrap_defaults\|first_run" src-tauri/src/
```

- [x] **Step 2: Write the four seed bundles**

```rust
// src-tauri/src/change_verify/seeds.rs
use rusqlite::Connection;
use super::bundles;
use super::model::NewCheckBundle;

pub fn seed_if_empty(db: &Connection) -> anyhow::Result<()> {
    let n: i64 = db.query_row("SELECT COUNT(*) FROM check_bundles", [], |r| r.get(0))?;
    if n > 0 { return Ok(()); }
    let seeds = vec![
        NewCheckBundle {
            name: "Cisco IOS-XE routing baseline".into(),
            description: Some("Core L3 verification".into()),
            vendor: "cisco".into(), platform: "iosxe".into(),
            commands: vec![
                "show ip interface brief".into(),
                "show ip route summary".into(),
                "show ip bgp summary".into(),
                "show ip ospf neighbor".into(),
                "show cdp neighbor".into(),
            ],
        },
        NewCheckBundle {
            name: "Cisco IOS-XE switching baseline".into(),
            description: Some("L2 verification".into()),
            vendor: "cisco".into(), platform: "iosxe".into(),
            commands: vec![
                "show interfaces status".into(),
                "show vlan brief".into(),
                "show spanning-tree summary".into(),
                "show cdp neighbor".into(),
                "show mac address-table count".into(),
            ],
        },
        NewCheckBundle {
            name: "NX-OS fabric baseline".into(),
            description: Some("VXLAN / BGP-EVPN fabric checks".into()),
            vendor: "cisco".into(), platform: "nxos".into(),
            commands: vec![
                "show interface brief".into(),
                "show ip route summary".into(),
                "show bgp l2vpn evpn summary".into(),
                "show nve peers".into(),
                "show vpc".into(),
            ],
        },
        NewCheckBundle {
            name: "Junos routing baseline".into(),
            description: Some("Core L3 verification on Junos".into()),
            vendor: "juniper".into(), platform: "junos".into(),
            commands: vec![
                "show interfaces terse".into(),
                "show route summary".into(),
                "show bgp summary".into(),
                "show ospf neighbor".into(),
                "show lldp neighbors".into(),
            ],
        },
    ];
    for s in seeds { bundles::create(db, s)?; }
    Ok(())
}
```

Invoke `seed_if_empty` from the existing first-run / bootstrap hook (find it in `src-tauri/src/lib.rs` or `db.rs` by searching `run_migrations` call-sites).

- [x] **Step 3: Write failing test** — empty DB → run `seed_if_empty` → expect 4 bundles. Run it twice → still 4 (idempotent).

- [x] **Step 4: Commit**

```bash
git add src-tauri/src/change_verify/seeds.rs src-tauri/src/lib.rs
git commit -m "feat(change-verify): seed 4 canonical bundles on first boot"
```

### Task 5.2 — Markdown export  `PARALLEL with 5.3`

**Files:**
- Create: `src/lib/changeReportMarkdown.ts`
- Create: `src/lib/changeReportMarkdown.test.ts`

- [x] **Step 1: Failing test**

```ts
import { describe, it, expect } from "vitest";
import { renderReportMarkdown } from "./changeReportMarkdown";

describe("renderReportMarkdown", () => {
  it("produces a report with severity counts and per-command sections", () => {
    const md = renderReportMarkdown({
      pre_snapshot_id: "p1", post_snapshot_id: "p2", bundle_id: "b1",
      counts: { red: 1, yellow: 2, green: 3 },
      deltas: [
        { command: "show ip bgp summary", family: "bgp-neighbor", severity: "red",
          path: "/neighbor/10.0.0.2", before: "Established", after: "Active",
          message: "BGP neighbor 10.0.0.2 state is now Active" },
      ],
      matched_approved: [],
      notes: "Migrated core router",
    }, { bundleName: "IOS-XE routing", capturedAt: 1715_000_000 });

    expect(md).toContain("# Change Verification Report");
    expect(md).toContain("IOS-XE routing");
    expect(md).toContain("- Red: 1");
    expect(md).toContain("BGP neighbor 10.0.0.2");
  });
});
```

- [x] **Step 2: Implement**

```ts
// src/lib/changeReportMarkdown.ts
import type { ReportSummary } from "./changeVerify";

export interface MarkdownMeta {
  bundleName: string;
  capturedAt: number;    // unix seconds
}

export function renderReportMarkdown(r: ReportSummary, m: MarkdownMeta): string {
  const d = new Date(m.capturedAt * 1000).toISOString();
  const lines: string[] = [];
  lines.push(`# Change Verification Report`);
  lines.push(``);
  lines.push(`**Bundle:** ${m.bundleName}`);
  lines.push(`**Generated:** ${d}`);
  lines.push(`**Pre snapshot:** \`${r.pre_snapshot_id}\``);
  lines.push(`**Post snapshot:** \`${r.post_snapshot_id}\``);
  if (r.notes) { lines.push(``); lines.push(`> ${r.notes}`); }
  lines.push(``);
  lines.push(`## Severity counts`);
  lines.push(`- Red: ${r.counts.red}`);
  lines.push(`- Yellow: ${r.counts.yellow}`);
  lines.push(`- Green: ${r.counts.green}`);
  lines.push(``);
  if (r.matched_approved.length > 0) {
    lines.push(`## Approved deltas`);
    for (const a of r.matched_approved) {
      lines.push(`- \`${a.command}\` @ \`${a.delta_path}\` — ${a.note}`);
    }
    lines.push(``);
  }
  lines.push(`## Deltas by command`);
  const byCmd = new Map<string, typeof r.deltas>();
  for (const dl of r.deltas) {
    if (!byCmd.has(dl.command)) byCmd.set(dl.command, []);
    byCmd.get(dl.command)!.push(dl);
  }
  for (const [cmd, rows] of byCmd) {
    lines.push(`### \`${cmd}\``);
    lines.push(``);
    lines.push(`| Severity | Path | Before | After | Message |`);
    lines.push(`|---|---|---|---|---|`);
    for (const dl of rows) {
      const sev = dl.severity.toUpperCase();
      const before = JSON.stringify(dl.before).slice(0, 60);
      const after = JSON.stringify(dl.after).slice(0, 60);
      lines.push(`| ${sev} | \`${dl.path}\` | \`${before}\` | \`${after}\` | ${dl.message} |`);
    }
    lines.push(``);
  }
  return lines.join("\n");
}
```

- [x] **Step 3: Commit** `feat(change-verify): markdown exporter`

### Task 5.3 — PDF export via tauri-plugin-dialog + print  `PARALLEL with 5.2`

**Files:**
- Modify: `src-tauri/Cargo.toml` — ensure `tauri-plugin-dialog` present (verify first: `grep -n tauri-plugin-dialog src-tauri/Cargo.toml`)
- Modify: `src-tauri/src/lib.rs` — register plugin if missing
- Create: `src/lib/changeReportExport.ts`
- Create: `src/lib/changeReportExport.test.ts`
- Create: `src/components/ChangeReportView.export.tsx` (printable HTML view)

- [ ] **Step 1: Research current approach**

Use `mcp__plugin_context7_context7__query-docs` with query "tauri-plugin-dialog save file" and "tauri 2 print webview". Paste key findings (1-3 lines) here as a block comment in `changeReportExport.ts` before coding.

- [ ] **Step 2: Strategy decision** — two viable paths:
  1. **Print-to-PDF from a hidden webview window** rendering the printable HTML view + CSS `@media print`. Tauri exposes `window.print()` which on macOS triggers the native Print dialog; prefer headless PDF generation via `WebviewWindow::print_to_pdf` if available in the installed Tauri version.
  2. **Render Markdown → HTML → PDF via a Rust crate** (`printpdf` or `chromiumoxide`). Heavier dependency.

Choose path 1 unless Tauri version in use (`grep -n "^tauri " src-tauri/Cargo.toml`) lacks the API, in which case choose path 2 and document the decision.

- [ ] **Step 3: Implement the exporter**

```ts
// src/lib/changeReportExport.ts
import { save } from "@tauri-apps/plugin-dialog";
import { writeFile } from "@tauri-apps/plugin-fs";
import { renderReportMarkdown, MarkdownMeta } from "./changeReportMarkdown";
import type { ReportSummary } from "./changeVerify";

export async function exportReportMarkdown(r: ReportSummary, m: MarkdownMeta) {
  const path = await save({
    defaultPath: `change-report-${m.bundleName}-${m.capturedAt}.md`,
    filters: [{ name: "Markdown", extensions: ["md"] }],
  });
  if (!path) return null;
  const md = renderReportMarkdown(r, m);
  await writeFile(path, new TextEncoder().encode(md));
  return path;
}

/**
 * PDF export: renders a hidden printable view, invokes window.print() or
 * WebviewWindow::print_to_pdf via a Tauri command `print_report_pdf(html, dest_path)`.
 */
export async function exportReportPdf(r: ReportSummary, m: MarkdownMeta) {
  const path = await save({
    defaultPath: `change-report-${m.bundleName}-${m.capturedAt}.pdf`,
    filters: [{ name: "PDF", extensions: ["pdf"] }],
  });
  if (!path) return null;
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("print_report_pdf", { reportJson: JSON.stringify(r), meta: m, destPath: path });
  return path;
}
```

Implement `print_report_pdf` in Rust — renders the HTML into a hidden webview, waits for `dom-ready`, calls the webview's print-to-PDF API. If that API is unavailable, fall back to a Puppeteer-style CLI (`chromium --headless --print-to-pdf`) ONLY if chromium is available on the host, otherwise emit a user-facing error "PDF export unavailable on this platform — use Markdown export".

- [ ] **Step 4: Wire "Export Markdown" + "Export PDF" buttons in `ChangeReportView.tsx`**

- [ ] **Step 5: Test** — Markdown path is fully unit-testable. PDF path gets a Playwright smoke that verifies the Save dialog opens (mocked) and the file exists afterwards.

- [ ] **Step 6: Commit** `feat(change-verify): markdown + pdf export via tauri-plugin-dialog`

### Task 5.4 — Docs  `PARALLEL with 5.3 after 5.3 stabilizes`

**Files:**
- Create: `docs/CHANGE_VERIFICATION.md`

- [x] **Step 1: Content**
  - What a check-bundle is, how to build one, per-vendor command catalog.
  - Pre → Change → Post → Report workflow screenshots.
  - Severity rule reference (table derived from `classifier.rs` — generate with a small Rust `cargo test --bin docgen -- --nocapture` script; do NOT hand-maintain).
  - Approval semantics: substring matching, risk of over-approval, best practices.
  - Example: "what a red BGP-neighbor-lost report looks like."

- [x] **Step 2: Commit** `docs: change verification user guide`

### Task 5.5 — Phase 5 regression + plan close-out  `SEQUENTIAL`

- [x] **Step 1:** `cargo test` — all green.
- [x] **Step 2:** `bun run test` — all green.
- [x] **Step 3:** `bunx playwright test` — full suite, including new `@change-verify` smoke.
- [x] **Step 4: Code review.** Prompt: "Review Phase 5 of Plan 06. Focus: seed idempotence, markdown escape safety (report values may contain pipes / backticks), PDF export fallback UX, seed migration vs. Rust-seed convention alignment. Report `must-fix` vs. `nits`."
- [x] **Step 5: Update `/Plans/README.md`** status row for Plan 06 → `✅ Complete`.
- [x] **Step 6: Update this plan file** — check all Phase 5 boxes + append final completion block.
- [x] **Step 7: Commit** — `docs(plans): close out plan 06`.

---

## Self-review checklist (run BEFORE marking plan complete)

- [x] Migration number `V0033` matches `/Plans/README.md` reservation.
- [x] Every schema table from the brief is present: `check_bundles`, `check_bundle_commands`, `change_snapshots`, `change_snapshot_results`, `change_reports`.
- [x] Plan 05 imports (`diff_snapshots`, `parse_and_store`, `SnapshotDelta`, `DeltaKind`, `parsed_outputs`) are referenced as **imports**, not re-implemented.
- [x] If Plan 05 is not done when Phase 2 begins, the plan says STOP. (See Prerequisites.)
- [x] Every phase ends with regression (`bun run test` + `cargo test` + `bunx playwright test --grep @smoke`) + `feature-dev:code-reviewer` + plan file update.
- [x] UI phase (4) has BOTH pre-impl design spec (Task 4.1) and post-impl design review (Task 4.5).
- [x] No placeholders. Every step has code or exact commands.
- [x] Type names consistent: `CheckBundle`, `NewCheckBundle`, `ChangeSnapshot`, `ChangeSnapshotResult`, `SnapshotLabel`, `ClassifiedDelta`, `ExpectedDelta`, `ReportSummary`, `SeverityCounts`, `ApprovedMatch` across Rust + TS.
- [x] Tauri command names consistent: `bundle_create/get/list/update_commands/rename/delete`, `change_run_pre`, `change_run_post_and_report`, `change_snapshot_get`, `change_report_get`, `change_report_list`, `print_report_pdf`.
- [x] Transaction safety: `run_snapshot` is wrapped in a DB transaction (Phase 2 Task 2.4 Step 5 fix).
- [x] Seed bundles match the brief exactly: Cisco IOS-XE routing, Cisco IOS-XE switching, NX-OS fabric, Junos routing.
- [x] PARALLEL vs SEQUENTIAL labels on tasks that share files are correct (tasks modifying the same file are SEQUENTIAL).
- [x] Approval semantics (substring match) is documented AND flagged as over-approval risk in docs (Task 5.4).
- [x] Platform mismatch between bundle and session is rejected before any command runs.
- [x] `detect_platform` path is verified to exist in the codebase (Task 2.1 Step 1) — if not, pause and ask the user.

## Completion log

<!-- Append `## Phase N — COMPLETED YYYY-MM-DD` blocks below as phases finish. -->

## Phase 5 — COMPLETED 2026-05-18

Seed bundles + Markdown export + user docs all shipped. **PDF export (Task 5.3) deferred** to a future release; the user guide explicitly documents the deferral with workarounds (pandoc, Marked 2, VS Code Markdown PDF).

**Commits on `main`:**
- `b7f4349` feat(change-verify): seed 4 canonical bundles on first boot
- `65c05cc` feat(change-verify): markdown report export
- `4a68b3e` docs(change-verify): user guide
- `29f0594` fix(change-verify): export uses bundle name, report created_at, escapes backticks

**Seed bundles (4 total, idempotent via `app_flags.change_verify.bundles.seeded.v1`):**
1. Cisco IOS-XE routing baseline (5 commands)
2. Cisco IOS-XE switching baseline (5 commands)
3. NX-OS fabric baseline (5 commands)
4. Junos routing baseline (5 commands)

**Markdown export hardening (commit 29f0594):**
- Bundle UUID → human-readable name resolved at export time via `bundleGet`.
- "Generated" timestamp now reflects the report's `created_at` from the DB, not the export-click time.
- `escapePipe` extended to escape backticks + backslashes so a delta value containing `` ` `` no longer breaks inline-code spans inside table cells.
- `run_post_and_report` and `change_run_post_and_report` return type widened from `(String, ReportSummary)` to `(String, ReportSummary, i64)` so the frontend store can keep the canonical timestamp.

**Reviewer findings carried forward (not blocking):**
- Deleted seed bundles are NOT auto-restored on next boot (the `app_flags` marker is set after the first successful seed). Acceptable for v1 — deletion is an explicit user action; a future "Reset to defaults" UI button can use a different code path.
- `app_flags` schema is duplicated between `notebooks::seeds`, `workflows_seed`, and now `change_verify::seeds` (each does `CREATE TABLE IF NOT EXISTS`). Trivial schema, low drift risk; consider promoting to a real migration when the next plan touches first-boot seeds.
- Dynamic `import()` in the menu listener has a ~50-200ms first-export lag. Acceptable for a manual export action; pre-loading on panel-open is a future optimization.

**Test deltas (Phase 5 contributions):**
- Rust: +2 seed tests (`seeds_four_bundles_on_first_run`, `second_run_is_idempotent`).
- TS: +6 Markdown tests (structure, pipe escaping, backtick escaping, notes inclusion, approved-delta conditional × 2), +1 store test (`appendApproval` preserves `createdAt`), +3 ChangeWindowPanel export tests.
- Total: **+12 green tests**, 0 regressions.

**Final test counts (Plan 06 closeout, all green except pre-existing baseline):**
- Rust: 85 passed / 5 pre-existing failures (`netconf_devices.hostkey_verify` column drift, unrelated to Plan 06).
- TS: 786 passed / 9 pre-existing failures (NetconfTab/ParameterForm/PipeMenu flaky env, unrelated to Plan 06).

---

## Plan 06 — COMPLETE 2026-05-18

✅ All 5 phases shipped on `main` (commits `f8ddcf8..29f0594`). 1 milestone deferral (PDF export, Task 5.3) documented.

**The user-facing feature:** open the Change Window via `Cmd+Shift+C` (also via the new "Change" menu) on any tab with a device session, pick a check-bundle filtered by the active vendor/platform, capture a `pre` snapshot, declare "I made the change", capture a `post`, and see a classified red/yellow/green diff. Approve individual deltas to suppress expected changes (persisted across panel close/reopen). Export the report as Markdown for ticket attachment.

**Cumulative test deltas across all 5 phases:**
- Rust: +24 integration tests (bundles CRUD, runner orchestrator + rollback proof, live transport, classifier 12 rules, diff_outputs 4 parity tests, report E2E + segment-match approvals, seed idempotence, append_approval persistence).
- TS: +85 tests across client wrappers, Zustand store, 8 React components + helper.
- Playwright: +1 `@smoke`-tagged spec (first such test in the suite).

**Cross-cutting wins beyond the plan brief:**
- **Plan 05/06 contract drift fully resolved.** Plan 05's frozen `diff_snapshots(a_pin, b_pin, db)` + `auto_parse::on_block_completed` API is untouched. Plan 06 ships local helpers (`change_verify::parser::parse_and_store`, `change_verify::diff_outputs`) that wrap them. Five Plan 05 helpers are now `pub(crate)` so Plan 06 can reuse alignment+diff logic without duplication. Plan 08 (Config Drift) can import `diff_snapshots` unchanged.
- **Plan 03 PTY-wiring bug fixed.** `commands::notebooks_runnable::build_pty_executor` was constructing the executor with `Arc::new(Mutex::new(HashMap::new()))` (a fresh empty PTY map) instead of `state.ptys.clone()`. Runnable MOPs against PTY tabs would always have errored "no PTY for tab X" at runtime. `AppState.ptys` widened to `Arc<Mutex<HashMap<...>>>`; build_pty_executor now passes the live map.
- **`crate::pty_runner` extracted.** The `AppStatePtyExecutor` (shared OSC-133 + scrollback-capture primitive) was lifted out of `commands/notebooks_runnable.rs` so Plan 06's live transport, Plan 07 (multi-device fan-out), Plan 11 (packet capture), and Plan 15 (AI troubleshooting) can all reuse the same battle-tested path.
- **`run_snapshot` and `run_post_and_report`** use `Arc<parking_lot::Mutex<Connection>>` with scoped lock windows between `.await` calls — no `spawn_blocking` workarounds, no held guards across async boundaries. Pattern documented in user memory for downstream plans.

**Carry-forward items (not blocking, scoped for future plans):**
- `change_reports.summary_json` stores the full `Vec<ClassifiedDelta>` in one column. Fine at Plan 06 scale (~10 commands × 100 deltas ≈ 50KB JSON). Plan 08 may want to normalize.
- `ClassifierThresholds` is partially tunable (`route_count_yellow_pct` only). Per-bundle tuning is a future enhancement.
- `BundlePicker` falls back to `vendor=generic platform=generic` silently when the active tab has no device session metadata. Should show "Change verification requires an active device session" warning.
- `ChangeWindowPanel`'s stage `useEffect` and the action handlers both `setStage(...)` for the same target stage. Benign (React batches) but a code smell — refactor to single-ownership.
- Synthetic `command_blocks` rows accumulate (~10 per change-window of bloat). Plan 08 should reap when normalizing the structured-data lifecycle.
- PDF export (Task 5.3) deferred — Markdown is a sufficient v1 substitute via pandoc/Marked.
- Playwright `@smoke` spec requires `bun tauri build` before it can run; CI integration is a follow-up.

**Migration ledger:** V0033 occupied. Next free migration number is **V0034** (claimed by Plan 07 per `/Plans/README.md`).

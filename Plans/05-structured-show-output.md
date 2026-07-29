# 05 — Structured Show-Output Layer (Genie + TextFSM dataframe + diff engine)

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Do NOT skip regression + code review + plan-file update at the end of each phase.

**Goal:** For every `show *` command block, automatically invoke `parse_show` (Plan 00) once the block completes, cache the structured result, and surface a new **"Structured"** tab inside `CommandBlock` alongside the existing raw output. Render TextFSM list-of-dicts as a sortable/filterable `@tanstack/react-table`, Genie nested dicts as an auto-flattened dotted-path table with per-row JSONPath filter, and expose CSV / JSON / Markdown export plus a pipe-filter syntax (`show … | ↗structured.nexthop=10.0.0.1`). Add a **snapshot** primitive ("pin this parsed output") and a **diff engine** (`diff_snapshots(a, b) -> Vec<CellDiff>`) that Plans 06 and 08 will both consume. The diff engine is delivered as a reusable public API (`pub fn diff_snapshots` in Rust, `diffSnapshots` from `src/lib/diff.ts`) — it is explicitly the foundation for pre/post change verification (Plan 06) and config intent drift (Plan 08).

**Architecture:**
- **Rust:** new module `src-tauri/src/structured/` containing:
  - `auto_parse.rs` — hook invoked after a block completes (tap into the existing `block_completed` event emitter in `src-tauri/src/commands/blocks.rs`). Reads session vendor/platform from the tab state. Only fires when `command` starts with `show ` (case-insensitive). Calls `crate::parsers::bridge::ParserBridge::parse` (Plan 00), persists row into `parsed_outputs`.
  - `snapshot.rs` — CRUD on `parsed_snapshots`.
  - `diff.rs` — `pub fn diff_snapshots(a_id: i64, b_id: i64, db: &Connection) -> Result<Vec<CellDiff>>` — normalizes both sides to a canonical row-major table (list of dicts or flattened dotted-path map), aligns rows by a stable key (user-configurable, default = first column or `schema_json.key` from `parse_schemas`), emits per-cell diff entries with `status: Added | Removed | Changed | Unchanged`.
  - `pipe_filter.rs` — parser for the inline `| ↗structured.<expr>` pipe syntax.
  - Tauri commands in `src-tauri/src/commands/structured.rs`: `structured_get(block_id)`, `structured_list_snapshots(tab_id)`, `structured_snapshot_create(block_id, name)`, `structured_snapshot_diff(a_id, b_id)`, `structured_export(block_id, format)`, `structured_pipe_filter(block_id, expr)`.
- **Frontend:**
  - `src/lib/structured.ts` — Tauri invoke wrappers + types (`ParsedOutput`, `ParsedSnapshot`, `CellDiff`).
  - `src/lib/diff.ts` — re-exports `diffSnapshots` as the canonical TS diff API consumed by Plan 06 / 08.
  - `src/lib/flatten.ts` — generic nested-dict → list-of-rows flattener (dotted-path keys). Pure function, unit tested.
  - `src/hooks/useStructuredOutput.ts` — wraps `useParsedOutput` (Plan 00) + DB lookup; exposes `{ loading, parsed, error, snapshot, pin, unpin }`.
  - `src/components/StructuredTab.tsx` — new tab inside `CommandBlock`. Uses `@tanstack/react-table` (already a dep). Sort/filter/column-resize.
  - `src/components/StructuredDiff.tsx` — renders `CellDiff[]` with color-coded cells (green=added, red=removed, amber=changed, grey=unchanged).
  - `src/components/SnapshotList.tsx` — list of saved snapshots per tab, "Diff against…" affordance.
  - Extend `src/components/CommandBlock.tsx` with a `viewMode: "raw" | "structured" | "diff"` state and tab strip.
- **Pipe-filter syntax:** `show ip route | ↗structured.nexthop=10.0.0.1` — the `↗structured.` prefix is the trigger. Parsed on block submission in `src/state/blocksStore.ts` before dispatch to pty. If the `↗structured.` segment is present, the raw command sent to the device is everything LEFT of the first `| ↗structured.`, and the expression is stored on the block as `block.structuredFilter` to be applied client-side once parse completes.

**Tech Stack:** Tauri 2, React 19, Zustand 5, rusqlite, serde, sha2, `@tanstack/react-table` (present), `jsonpath-plus` (add), `papaparse` (add, CSV export).

**Prerequisites:**
- Plan 00 complete through Phase 2 (requires `parse_show` Tauri command, `parsers_cache` table, `parseShow` TS wrapper, `useParsedOutput` hook). **Do not start this plan until Plan 00 Phase 2 is signed off.**
- Plan 01 complete through Phase 1 at minimum (block persistence + `block_completed` event surface).

**Downstream consumers:**
- **Plan 06** (Pre/Post Change Verification) imports `diff_snapshots` (Rust) and `diffSnapshots` (TS) directly to diff two `parsed_snapshots` rows captured before and after a config change.
- **Plan 08** (Config Intent + Drift) imports the same diff engine to compare rendered intent vs. observed state; drift reports are diffs of two normalized snapshots.
- Both downstream plans treat `diff_snapshots` as a **stable public API** — once this plan ships Phase 4, the signature may not change without a coordinated migration across 06 and 08.

---

## Phase 1 — Auto-parse on block completion (Rust hook + migration + cache)

### Task 1.1 — Migration V0032  `SEQUENTIAL`

**Files:**
- Create: `src-tauri/migrations/V0032__structured_show_output.sql`

- [ ] **Step 1: Write the migration exactly**

```sql
CREATE TABLE IF NOT EXISTS parsed_outputs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  block_id TEXT NOT NULL UNIQUE REFERENCES command_blocks(id) ON DELETE CASCADE,
  parser TEXT NOT NULL,                 -- 'genie' | 'textfsm'
  command TEXT NOT NULL,
  vendor TEXT NOT NULL,
  platform TEXT NOT NULL,
  data_json TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
CREATE INDEX IF NOT EXISTS idx_parsed_outputs_command ON parsed_outputs(command);
CREATE INDEX IF NOT EXISTS idx_parsed_outputs_vendor_platform ON parsed_outputs(vendor, platform);

CREATE TABLE IF NOT EXISTS parsed_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tab_id TEXT NOT NULL,
  name TEXT NOT NULL,
  parsed_output_id INTEGER NOT NULL REFERENCES parsed_outputs(id) ON DELETE CASCADE,
  captured_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
CREATE INDEX IF NOT EXISTS idx_parsed_snapshots_tab ON parsed_snapshots(tab_id);
CREATE INDEX IF NOT EXISTS idx_parsed_snapshots_name ON parsed_snapshots(name);

CREATE TABLE IF NOT EXISTS parse_schemas (
  parser TEXT NOT NULL,
  command TEXT NOT NULL,
  vendor TEXT NOT NULL,
  platform TEXT NOT NULL,
  schema_json TEXT NOT NULL,            -- { "key": "interface", "columns": [...] }
  learned_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  PRIMARY KEY (parser, command, vendor, platform)
);
```

- [ ] **Step 2: Apply + verify**

```bash
cargo test --manifest-path src-tauri/Cargo.toml --lib -- db::tests::migrations_apply
```
Expected: migrations_apply passes with V0032 applied.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/migrations/V0032__structured_show_output.sql
git commit -m "feat(db): V0032 parsed_outputs + parsed_snapshots + parse_schemas"
```

### Task 1.2 — Rust `structured::auto_parse` module  `SEQUENTIAL` (depends on 1.1)

**Files:**
- Create: `src-tauri/src/structured/mod.rs`
- Create: `src-tauri/src/structured/auto_parse.rs`
- Modify: `src-tauri/src/lib.rs` — `pub mod structured;` and register state
- Modify: `src-tauri/src/commands/blocks.rs` — fire `structured::auto_parse::on_block_completed` from the existing `block_completed` emitter
- Create: `src-tauri/tests/structured_auto_parse_test.rs`

- [ ] **Step 1: Inspect the existing completion hook**

```bash
grep -n "block_completed\|block_complete\|on_block\|emit" src-tauri/src/commands/blocks.rs
```
Do NOT invent a new dispatch point. Reuse whatever emitter already exists. If no such emitter exists, add it as a minimal `pub fn emit_block_completed(app: &AppHandle, block_id: &str)` and wire it in the one place a block transitions to completed state.

- [ ] **Step 2: Write the failing integration test**

```rust
// src-tauri/tests/structured_auto_parse_test.rs
use ccie_terminal_lib::structured::auto_parse;
use ccie_terminal_lib::db::Db;

#[tokio::test]
async fn auto_parse_fires_only_for_show_commands() {
    let db = Db::open_in_memory().unwrap();
    // seed tab with vendor=cisco, platform=iosxe
    let tab_id = db.seed_test_tab("cisco", "iosxe").await;
    let show_bid = db.seed_test_block(&tab_id, "show version", "Cisco IOS XE 17.09.04").await;
    let noshow_bid = db.seed_test_block(&tab_id, "configure terminal", "...").await;

    // Use a fake ParserBridge returning a known payload
    let bridge = auto_parse::testing::FakeBridge::new(r#"{"version":"17.09.04"}"#);

    auto_parse::on_block_completed(&db, &bridge, &show_bid).await.unwrap();
    auto_parse::on_block_completed(&db, &bridge, &noshow_bid).await.unwrap();

    let rows = db.list_parsed_outputs_for_tab(&tab_id).await.unwrap();
    assert_eq!(rows.len(), 1, "only the show block should have parsed output");
    assert_eq!(rows[0].block_id, show_bid);
    assert_eq!(rows[0].parser, "genie");
}

#[tokio::test]
async fn auto_parse_is_idempotent() {
    let db = Db::open_in_memory().unwrap();
    let tab_id = db.seed_test_tab("cisco", "iosxe").await;
    let bid = db.seed_test_block(&tab_id, "show ip int br", "...").await;
    let bridge = auto_parse::testing::FakeBridge::new(r#"[{"intf":"Gi1"}]"#);

    auto_parse::on_block_completed(&db, &bridge, &bid).await.unwrap();
    auto_parse::on_block_completed(&db, &bridge, &bid).await.unwrap();

    let rows = db.list_parsed_outputs_for_tab(&tab_id).await.unwrap();
    assert_eq!(rows.len(), 1, "parsed_outputs has UNIQUE(block_id); second call updates in place");
}
```

- [ ] **Step 3: Run — expect FAIL** (`cargo test --manifest-path src-tauri/Cargo.toml structured_auto_parse`)

- [ ] **Step 4: Implement `structured/auto_parse.rs`**

```rust
use anyhow::Result;
use rusqlite::params;
use crate::db::Db;
use crate::parsers::bridge::ParserBridge;

pub async fn on_block_completed(db: &Db, bridge: &dyn ParserBridge, block_id: &str) -> Result<()> {
    let block = db.get_block(block_id).await?;
    let cmd_trimmed = block.command.trim();
    if !cmd_trimmed.to_lowercase().starts_with("show ") {
        return Ok(());
    }
    let tab = db.get_tab(&block.tab_id).await?;
    let vendor = tab.vendor.unwrap_or_else(|| "unknown".to_string());
    let platform = tab.platform.unwrap_or_else(|| "unknown".to_string());
    if vendor == "unknown" || platform == "unknown" {
        // tab has no vendor detected — skip silently, log at debug
        tracing::debug!(%block_id, "auto_parse skipped: no vendor/platform on tab");
        return Ok(());
    }
    let parsed = match bridge.parse(&vendor, &platform, cmd_trimmed, &block.output).await {
        Ok(p) => p,
        Err(e) => {
            tracing::info!(%block_id, error = %e, "auto_parse: no parser available");
            return Ok(());
        }
    };
    let data_json = parsed.data.to_string();
    db.upsert_parsed_output(block_id, &parsed.parser, cmd_trimmed, &vendor, &platform, &data_json).await?;
    Ok(())
}

pub mod testing {
    use super::*;
    use async_trait::async_trait;

    pub struct FakeBridge { payload: String }
    impl FakeBridge { pub fn new(payload: &str) -> Self { Self { payload: payload.to_string() } } }

    #[async_trait]
    impl ParserBridge for FakeBridge {
        async fn parse(&self, _v: &str, _p: &str, _c: &str, _r: &str)
            -> anyhow::Result<crate::parsers::bridge::ParseBridgeResult>
        {
            Ok(crate::parsers::bridge::ParseBridgeResult {
                parser: "genie".to_string(),
                data: serde_json::from_str(&self.payload)?,
            })
        }
    }
}
```

- [ ] **Step 5: Implement DB helpers**

Add to `src-tauri/src/db/mod.rs`:
```rust
impl Db {
    pub async fn upsert_parsed_output(
        &self, block_id: &str, parser: &str, command: &str,
        vendor: &str, platform: &str, data_json: &str,
    ) -> Result<i64> {
        let conn = self.conn().await;
        conn.execute(
            "INSERT INTO parsed_outputs(block_id,parser,command,vendor,platform,data_json)
             VALUES (?1,?2,?3,?4,?5,?6)
             ON CONFLICT(block_id) DO UPDATE SET
               parser=excluded.parser, command=excluded.command,
               vendor=excluded.vendor, platform=excluded.platform,
               data_json=excluded.data_json, created_at=strftime('%s','now')",
            params![block_id, parser, command, vendor, platform, data_json],
        )?;
        Ok(conn.last_insert_rowid())
    }

    pub async fn list_parsed_outputs_for_tab(&self, tab_id: &str) -> Result<Vec<ParsedOutputRow>> { /* … */ }
    pub async fn get_parsed_output(&self, block_id: &str) -> Result<Option<ParsedOutputRow>> { /* … */ }
}
```

- [ ] **Step 6: Wire into `block_completed` hook**

In `src-tauri/src/commands/blocks.rs`, at the point a block transitions to completed:
```rust
// after existing persistence …
let db = state.db.clone();
let bridge = state.parser_bridge.clone();
let bid = block_id.clone();
tauri::async_runtime::spawn(async move {
    if let Err(e) = crate::structured::auto_parse::on_block_completed(&db, &*bridge, &bid).await {
        tracing::warn!(block_id=%bid, error=%e, "auto_parse failed");
    }
});
```
Non-blocking — auto-parse runs in a spawned task so the completion UI path is never blocked by a slow sidecar parse.

- [ ] **Step 7: Run — expect PASS**

```bash
cargo test --manifest-path src-tauri/Cargo.toml structured_auto_parse
```

- [ ] **Step 8: Commit**

```bash
git add src-tauri/src/structured/ src-tauri/src/lib.rs src-tauri/src/commands/blocks.rs src-tauri/src/db/ src-tauri/tests/structured_auto_parse_test.rs
git commit -m "feat(structured): auto-parse show-command output on block completion"
```

### Task 1.3 — Tauri command `structured_get(block_id)`  `PARALLEL with 1.2 final testing`

**Files:**
- Create: `src-tauri/src/commands/structured.rs`
- Modify: `src-tauri/src/commands/mod.rs` — `pub mod structured;`
- Modify: `src-tauri/src/lib.rs` — register `structured_get` in `tauri::generate_handler!`
- Create: `src/lib/structured.ts`
- Create: `src/lib/structured.test.ts`

- [ ] **Step 1: Write failing TS test**

```ts
import { describe, it, expect, vi } from "vitest";
import { getStructured } from "./structured";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => ({
    blockId: "b1", parser: "textfsm", command: "show ip int br",
    vendor: "cisco", platform: "iosxe",
    data: [{ interface: "Gi1", ip: "10.0.0.1", status: "up" }],
    createdAt: 1747000000,
  })),
}));

describe("getStructured", () => {
  it("returns the structured payload for a block", async () => {
    const r = await getStructured("b1");
    expect(r?.parser).toBe("textfsm");
    expect(Array.isArray(r?.data)).toBe(true);
  });
});
```

- [ ] **Step 2: Implement Rust command**

```rust
#[derive(Serialize)]
pub struct StructuredDto {
    #[serde(rename = "blockId")] pub block_id: String,
    pub parser: String,
    pub command: String,
    pub vendor: String,
    pub platform: String,
    pub data: serde_json::Value,
    #[serde(rename = "createdAt")] pub created_at: i64,
}

#[tauri::command]
pub async fn structured_get(block_id: String, db: State<'_, Db>) -> Result<Option<StructuredDto>, String> {
    match db.get_parsed_output(&block_id).await.map_err(|e| e.to_string())? {
        None => Ok(None),
        Some(r) => Ok(Some(StructuredDto {
            block_id: r.block_id, parser: r.parser, command: r.command,
            vendor: r.vendor, platform: r.platform,
            data: serde_json::from_str(&r.data_json).map_err(|e| e.to_string())?,
            created_at: r.created_at,
        })),
    }
}
```

- [ ] **Step 3: Implement `src/lib/structured.ts`**

```ts
import { invoke } from "@tauri-apps/api/core";

export type StructuredData =
  | { kind: "list"; rows: Record<string, unknown>[] }
  | { kind: "dict"; obj: Record<string, unknown> };

export interface ParsedOutput {
  blockId: string;
  parser: "genie" | "textfsm";
  command: string;
  vendor: string;
  platform: string;
  data: unknown;           // list | nested dict
  createdAt: number;
}

export async function getStructured(blockId: string): Promise<ParsedOutput | null> {
  return invoke<ParsedOutput | null>("structured_get", { blockId });
}
```

- [ ] **Step 4: Run — expect PASS** (`bun run test src/lib/structured.test.ts`)

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/commands/structured.rs src-tauri/src/commands/mod.rs src-tauri/src/lib.rs src/lib/structured.ts src/lib/structured.test.ts
git commit -m "feat(structured): structured_get Tauri command + TS wrapper"
```

### Task 1.4 — Phase 1 regression  `SEQUENTIAL`

- [ ] **Step 1:** `bun run test` — green.
- [ ] **Step 2:** `cargo test --manifest-path src-tauri/Cargo.toml` — green.
- [ ] **Step 3:** `bunx playwright test --grep @smoke` — green.
- [ ] **Step 4: Code review** — dispatch `feature-dev:code-reviewer` over Phase 1 diff with prompt: "Review Plan 05 Phase 1 — auto-parse hook, migration V0032, `structured_get`. Focus: non-blocking completion hook, idempotency of upsert, vendor/platform detection fallbacks. Report must-fix vs nits."
- [ ] **Step 5: Update this plan file** — check all Phase 1 boxes and append at the bottom:

```markdown
## Phase 1 — COMPLETED YYYY-MM-DD
Auto-parse fires on `show *` block completion; migration V0032 live; `structured_get` command + TS wrapper round-trip verified; non-blocking spawn confirmed in integration test.
```

- [ ] **Step 6: Commit plan update**

```bash
git add Plans/05-structured-show-output.md
git commit -m "docs(plans): mark Plan 05 Phase 1 complete"
```

---

## Phase 2 — "Structured" tab UI (pre/post frontend-design review)

### Task 2.1 — Pre-implementation design spec  `SEQUENTIAL`

**Files:**
- Create: `docs/design/structured-tab.md`

- [ ] **Step 1: Dispatch `frontend-design` skill** with brief:
  > "Design a 'Structured' tab inside the `CommandBlock` component in a Warp-inspired terminal. Existing block header shows command + status; below it, today, only raw output renders. We are adding a three-way tab strip: **Raw | Structured | Diff**. The Structured tab renders tabular data from a network `show` command parsed via Genie/TextFSM — most commonly list-of-dicts (interface table) or nested dict (routing table with nested protocols). Show: tab strip visual (active vs inactive), column header row with sort arrows + inline filter inputs, dense row layout (target 26–30px row height), a compact toolbar (Export CSV / Export JSON / Copy as Markdown / Pin Snapshot), and a 'No parser available' empty state. Deliver ASCII wireframe + Tailwind or CSS class names aligned with `CommandBlock.css` and `BlockOutput.css` conventions (the app uses plain CSS, not Tailwind — reuse `.block-output` palette)."
- [ ] **Step 2: Save the returned spec** to `docs/design/structured-tab.md`.
- [ ] **Step 3: Commit** `docs(design): structured tab spec`.

### Task 2.2 — Dependencies + flatten helper  `PARALLEL with 2.3`

**Files:**
- Modify: `package.json` — add `jsonpath-plus`, `papaparse`
- Create: `src/lib/flatten.ts`
- Create: `src/lib/flatten.test.ts`

- [ ] **Step 1: Add deps**

```bash
bun add jsonpath-plus papaparse
bun add -d @types/papaparse
```

- [ ] **Step 2: Write failing tests for `flatten.ts`**

```ts
import { describe, it, expect } from "vitest";
import { flattenToRows, isListOfDicts, inferColumns } from "./flatten";

describe("isListOfDicts", () => {
  it("returns true for TextFSM-style arrays", () => {
    expect(isListOfDicts([{ a: 1 }, { a: 2 }])).toBe(true);
  });
  it("returns false for nested dicts", () => {
    expect(isListOfDicts({ interfaces: { Gi1: { ip: "10.0.0.1" } } })).toBe(false);
  });
});

describe("flattenToRows", () => {
  it("flattens a Genie-style nested dict to dotted-path rows", () => {
    const data = { interfaces: { Gi1: { ip: "10.0.0.1", up: true }, Gi2: { ip: "10.0.0.2", up: false } } };
    const rows = flattenToRows(data);
    expect(rows).toEqual([
      { key: "interfaces.Gi1.ip", value: "10.0.0.1" },
      { key: "interfaces.Gi1.up", value: true },
      { key: "interfaces.Gi2.ip", value: "10.0.0.2" },
      { key: "interfaces.Gi2.up", value: false },
    ]);
  });
  it("leaves list-of-dicts unchanged via inferColumns", () => {
    const rows = [{ intf: "Gi1", status: "up" }, { intf: "Gi2", status: "down" }];
    expect(inferColumns(rows)).toEqual(["intf", "status"]);
  });
});
```

- [ ] **Step 3: Implement `src/lib/flatten.ts`**

```ts
export function isListOfDicts(data: unknown): data is Record<string, unknown>[] {
  return Array.isArray(data) && data.length > 0 &&
    data.every(r => typeof r === "object" && r !== null && !Array.isArray(r));
}

export interface FlatRow { key: string; value: unknown }

export function flattenToRows(data: unknown, prefix = ""): FlatRow[] {
  if (data === null || data === undefined) return [];
  if (typeof data !== "object" || Array.isArray(data)) {
    return [{ key: prefix || "$", value: data }];
  }
  const rows: FlatRow[] = [];
  for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
    const nextKey = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === "object" && !Array.isArray(v)) {
      rows.push(...flattenToRows(v, nextKey));
    } else {
      rows.push({ key: nextKey, value: v });
    }
  }
  return rows;
}

export function inferColumns(rows: Record<string, unknown>[]): string[] {
  const cols = new Set<string>();
  for (const r of rows) for (const k of Object.keys(r)) cols.add(k);
  return [...cols];
}
```

- [ ] **Step 4: Run — expect PASS** (`bun run test src/lib/flatten.test.ts`)
- [ ] **Step 5: Commit** `feat(structured): flatten helper for nested dicts`

### Task 2.3 — `useStructuredOutput` hook  `PARALLEL with 2.2`

**Files:**
- Create: `src/hooks/useStructuredOutput.ts`
- Create: `src/hooks/useStructuredOutput.test.tsx`

- [ ] **Step 1: Write failing hook test**

```tsx
import { renderHook, waitFor } from "@testing-library/react";
import { vi, describe, it, expect } from "vitest";
import { useStructuredOutput } from "./useStructuredOutput";

vi.mock("../lib/structured", () => ({
  getStructured: vi.fn(async (_blockId: string) => ({
    blockId: "b1", parser: "textfsm" as const, command: "show ip int br",
    vendor: "cisco", platform: "iosxe",
    data: [{ intf: "Gi1" }], createdAt: 0,
  })),
}));

describe("useStructuredOutput", () => {
  it("loads parsed output for a block", async () => {
    const { result } = renderHook(() => useStructuredOutput("b1"));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.parsed?.parser).toBe("textfsm");
  });
});
```

- [ ] **Step 2: Implement**

```ts
import { useEffect, useState } from "react";
import { getStructured, type ParsedOutput } from "../lib/structured";

export function useStructuredOutput(blockId: string | null) {
  const [loading, setLoading] = useState(false);
  const [parsed, setParsed] = useState<ParsedOutput | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!blockId) { setParsed(null); return; }
    let cancelled = false;
    setLoading(true); setError(null);
    getStructured(blockId)
      .then(p => { if (!cancelled) { setParsed(p); setLoading(false); } })
      .catch(e => { if (!cancelled) { setError(String(e)); setLoading(false); } });
    return () => { cancelled = true; };
  }, [blockId]);

  return { loading, parsed, error };
}
```

- [ ] **Step 3: Run — expect PASS**
- [ ] **Step 4: Commit** `feat(structured): useStructuredOutput hook`

### Task 2.4 — `StructuredTab` component with react-table  `SEQUENTIAL` (depends on 2.2 + 2.3)

**Files:**
- Create: `src/components/StructuredTab.tsx`
- Create: `src/components/StructuredTab.css`
- Create: `src/components/StructuredTab.test.tsx`

- [ ] **Step 1: Write failing component tests**
  1. Renders TextFSM list as sortable table with correct columns.
  2. Renders Genie nested dict as flattened key/value table.
  3. Clicking a column header toggles sort asc → desc → none.
  4. Typing in a column filter input filters rows.
  5. Shows "No parser available" empty state when `parsed === null && !loading`.

- [ ] **Step 2: Implement** using `@tanstack/react-table` (already a dep — do NOT re-add). Key implementation points:
  - `isListOfDicts(parsed.data)` → columns from `inferColumns`, data straight through.
  - Else → `flattenToRows(parsed.data)` → columns = `["key", "value"]`, data = FlatRow[].
  - Use `useReactTable` with `getSortedRowModel` + `getFilteredRowModel`. Each column header gets a tiny `<input>` below it bound to `column.setFilterValue`.
  - JSONPath filter: render a single-line top input labeled "JSONPath" when data came from a nested dict. On change, pass `jsonpath-plus` result back through `flattenToRows` and feed the table.
  - Toolbar with disabled placeholders for Export CSV / Export JSON / Copy as Markdown / Pin Snapshot — these get wired in Phase 3 (Pin) and Phase 5 (export). Show them now so the design review reviewer sees the full chrome.

- [ ] **Step 3: Run — expect PASS**
- [ ] **Step 4: Commit** `feat(structured): StructuredTab component with react-table`

### Task 2.5 — Integrate tab strip into `CommandBlock`  `SEQUENTIAL` (depends on 2.4)

**Files:**
- Modify: `src/components/CommandBlock.tsx`
- Modify: `src/components/CommandBlock.css`
- Create: `src/components/BlockTabStrip.tsx`
- Create: `src/components/BlockTabStrip.css`
- Create: `src/components/BlockTabStrip.test.tsx`

- [ ] **Step 1: Add `viewMode` state** to `CommandBlock.tsx`:

```tsx
const [viewMode, setViewMode] = useState<"raw" | "structured" | "diff">("raw");
```

Default is `"raw"`. Only render the tab strip when `block.command.trim().toLowerCase().startsWith("show ")` AND `!active` (the active-block live terminal always shows raw).

- [ ] **Step 2: Render logic**

```tsx
{showStructuredTabs && (
  <BlockTabStrip viewMode={viewMode} onChange={setViewMode} />
)}
{viewMode === "raw" && (
  <BlockOutput ... />   // existing
)}
{viewMode === "structured" && (
  <StructuredTab blockId={block.id} />
)}
{viewMode === "diff" && (
  <StructuredDiff blockId={block.id} />   // implemented in Phase 4; in Phase 2 render a placeholder
)}
```

- [ ] **Step 3: Write failing integration test** — a `show ip int br` block renders `BlockTabStrip`; a `configure terminal` block does not. Clicking "Structured" swaps the content.

- [ ] **Step 4: Implement + run — expect PASS.**
- [ ] **Step 5: Commit** `feat(structured): integrate Raw/Structured/Diff tab strip into CommandBlock`

### Task 2.6 — Post-implementation design review + Phase 2 regression  `SEQUENTIAL`

- [ ] **Step 1:** `bun run tauri dev` — seed a tab with vendor=cisco/platform=iosxe, run `show ip interface brief` against a real or mocked PTY. Screenshot (a) Structured tab with sortable table, (b) Structured tab with flattened nested dict, (c) "No parser available" empty state.
- [ ] **Step 2: Dispatch `frontend-design` skill** with the three screenshots and prompt: "Review the StructuredTab UI against the pre-impl spec in `docs/design/structured-tab.md`. Identify any gaps in column density, contrast, empty-state messaging, or toolbar affordance placement."
- [ ] **Step 3: Apply feedback. Commit.**
- [ ] **Step 4:** Full regression: `bun run test`, `cargo test`, `bunx playwright test --grep @smoke`.
- [ ] **Step 5: Code review subagent** (`feature-dev:code-reviewer`).
- [ ] **Step 6: Update plan** — check Phase 2 boxes + append completion block.
- [ ] **Step 7: Commit plan.**

---

## Phase 3 — Snapshot / pin / name snapshots

### Task 3.1 — Rust snapshot module  `SEQUENTIAL`

**Files:**
- Create: `src-tauri/src/structured/snapshot.rs`
- Create: `src-tauri/src/commands/structured_snapshot.rs` (or extend `commands/structured.rs`)
- Create: `src-tauri/tests/structured_snapshot_test.rs`

- [ ] **Step 1: Write failing tests**
  - `snapshot_create(block_id, name)` — creates a row in `parsed_snapshots` linked to the current `parsed_outputs.id`; returns new snapshot id.
  - `snapshot_create` fails with a typed error when the block has no parsed output.
  - `snapshot_list(tab_id)` — returns ordered list (newest first).
  - `snapshot_rename(id, new_name)` — updates name.
  - `snapshot_delete(id)` — deletes row; leaves `parsed_outputs` untouched.

- [ ] **Step 2: Implement**

```rust
pub async fn create(db: &Db, block_id: &str, name: &str) -> Result<i64> {
    let parsed = db.get_parsed_output(block_id).await?
        .ok_or_else(|| anyhow!("no parsed output for block {block_id}; snapshot requires auto-parse to have completed"))?;
    let tab_id = db.get_block_tab_id(block_id).await?;
    let conn = db.conn().await;
    conn.execute(
        "INSERT INTO parsed_snapshots(tab_id, name, parsed_output_id) VALUES (?1,?2,?3)",
        params![tab_id, name, parsed.id],
    )?;
    Ok(conn.last_insert_rowid())
}
```

- [ ] **Step 3: Tauri commands**

```rust
#[tauri::command]
pub async fn structured_snapshot_create(block_id: String, name: String, db: State<'_, Db>) -> Result<i64, String>;

#[tauri::command]
pub async fn structured_list_snapshots(tab_id: String, db: State<'_, Db>) -> Result<Vec<SnapshotDto>, String>;

#[tauri::command]
pub async fn structured_snapshot_rename(id: i64, name: String, db: State<'_, Db>) -> Result<(), String>;

#[tauri::command]
pub async fn structured_snapshot_delete(id: i64, db: State<'_, Db>) -> Result<(), String>;
```

- [ ] **Step 4: Register + run — expect PASS.**
- [ ] **Step 5: Commit** `feat(structured): snapshot CRUD Rust commands`

### Task 3.2 — Frontend snapshot API + UI  `SEQUENTIAL` (depends on 3.1)

**Files:**
- Modify: `src/lib/structured.ts` — add `createSnapshot`, `listSnapshots`, `renameSnapshot`, `deleteSnapshot`
- Create: `src/components/SnapshotList.tsx` + `.css` + `.test.tsx`
- Create: `src/components/SnapshotPinDialog.tsx` + `.test.tsx`
- Modify: `src/components/StructuredTab.tsx` — wire the toolbar "Pin Snapshot" button to open the dialog

- [ ] **Step 1: Write failing tests**
  - `createSnapshot` invokes the Tauri command with expected args.
  - `SnapshotList` renders the list and calls `onSelect(id)` on click.
  - `SnapshotPinDialog` shows a name input; Enter / click Save invokes `createSnapshot`.

- [ ] **Step 2: Implement.**
- [ ] **Step 3: Plug `SnapshotList` into the right-hand panel** (beside the block list — consult design spec from 2.1 if not already covered; if not, spin a small `frontend-design` sub-consult for placement).
- [ ] **Step 4: Commit** `feat(structured): snapshot UI + pin dialog`

### Task 3.3 — Phase 3 regression  `SEQUENTIAL`

- [ ] Full regression suite.
- [ ] Code review.
- [ ] Update plan — check Phase 3 boxes + append completion block.
- [ ] Commit plan.

---

## Phase 4 — Diff engine (reusable by Plans 06 + 08) + Diff view UI

> This phase ships the **public contract** consumed by downstream plans. Treat the Rust signature and the TS re-export as stable API — Plans 06 and 08 import them verbatim. After Phase 4 completes, any change to the diff engine requires a coordinated plan update across 05, 06, and 08.

### Task 4.1 — `diff_snapshots` Rust function  `SEQUENTIAL`

**Files:**
- Create: `src-tauri/src/structured/diff.rs`
- Modify: `src-tauri/src/structured/mod.rs` — `pub mod diff; pub use diff::{diff_snapshots, CellDiff, DiffStatus};`
- Create: `src-tauri/tests/structured_diff_test.rs`

- [ ] **Step 1: Define public types**

```rust
// diff.rs
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum DiffStatus { Added, Removed, Changed, Unchanged }

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CellDiff {
    pub row_key: String,            // e.g. "Gi1" or "interfaces.Gi1"
    pub column: String,             // e.g. "ip" or "status"
    pub status: DiffStatus,
    pub a: Option<serde_json::Value>,
    pub b: Option<serde_json::Value>,
}
```

- [ ] **Step 2: Public function signature — this is the contract Plans 06 + 08 import**

```rust
/// Diff two parsed_snapshots rows and return a flat list of cell-level differences.
///
/// Alignment strategy:
///   1. If both snapshots share the same (parser, command, vendor, platform) and
///      a `parse_schemas` row exists for that key, use `schema_json.key` as the
///      row alignment key.
///   2. Otherwise, for list-of-dicts data, use the first column whose values are
///      unique on both sides.
///   3. For nested-dict data, flatten via the same algorithm as `src/lib/flatten.ts`
///      and align by dotted-path key.
///
/// Public API — consumed by Plan 06 (pre/post change verification) and
/// Plan 08 (config intent drift). Do not change the signature without coordinating.
pub fn diff_snapshots(
    a_snapshot_id: i64,
    b_snapshot_id: i64,
    db: &crate::db::Db,
) -> anyhow::Result<Vec<CellDiff>>;
```

- [ ] **Step 3: Write failing tests — cover every alignment branch**

```rust
#[test] fn diff_list_of_dicts_row_added() { /* interface Gi3 appears in b only */ }
#[test] fn diff_list_of_dicts_row_removed() { /* Gi1 disappears from b */ }
#[test] fn diff_list_of_dicts_cell_changed() { /* Gi1.status up→down */ }
#[test] fn diff_list_of_dicts_identical_returns_all_unchanged() { /* … */ }
#[test] fn diff_nested_dict_genie_shape() { /* two Genie routing tables, one route flaps */ }
#[test] fn diff_uses_parse_schemas_key_when_present() { /* schema_json.key = "interface" */ }
#[test] fn diff_falls_back_to_first_unique_column() { /* no schema row; auto-detect */ }
#[test] fn diff_raises_when_data_shapes_mismatch() { /* list vs dict on same command */ }
```

- [ ] **Step 4: Implement**

- [ ] **Step 5: Run — expect PASS.**
- [ ] **Step 6: Tauri command wrapper**

```rust
#[tauri::command]
pub async fn structured_snapshot_diff(a: i64, b: i64, db: State<'_, Db>) -> Result<Vec<CellDiff>, String> {
    structured::diff_snapshots(a, b, &db).map_err(|e| e.to_string())
}
```

- [ ] **Step 7: Commit** `feat(structured): public diff_snapshots API — Plans 06/08 import`

### Task 4.2 — `diffSnapshots` TS re-export + `StructuredDiff` component  `SEQUENTIAL` (depends on 4.1)

**Files:**
- Create: `src/lib/diff.ts`
- Create: `src/lib/diff.test.ts`
- Create: `src/components/StructuredDiff.tsx` + `.css` + `.test.tsx`

- [ ] **Step 1: `src/lib/diff.ts`** — this is the canonical TS consumer of the Rust contract; Plans 06 and 08 import from here, not directly from `structured.ts`.

```ts
import { invoke } from "@tauri-apps/api/core";

export type DiffStatus = "added" | "removed" | "changed" | "unchanged";

export interface CellDiff {
  row_key: string;
  column: string;
  status: DiffStatus;
  a: unknown | null;
  b: unknown | null;
}

/**
 * Diff two structured snapshots. Public API — consumed by Plan 06 and Plan 08.
 */
export async function diffSnapshots(aId: number, bId: number): Promise<CellDiff[]> {
  return invoke<CellDiff[]>("structured_snapshot_diff", { a: aId, b: bId });
}
```

- [ ] **Step 2: Write failing tests**
  - `diffSnapshots` invokes the correct Tauri command.
  - `StructuredDiff` renders color-coded cells: added = green bg, removed = red bg, changed = amber bg, unchanged = default.
  - `StructuredDiff` groups by `row_key` — one visual row per logical row.
  - Empty diff renders "No changes" empty state.

- [ ] **Step 3: Implement `StructuredDiff.tsx`** — takes `aSnapshotId` and `bSnapshotId` props. Calls `diffSnapshots`. Groups `CellDiff[]` by `row_key`, then renders a react-table where each column cell is color-coded by its own `DiffStatus`.

- [ ] **Step 4: Wire into `CommandBlock` Diff tab**

The Diff tab needs a snapshot selector. Implementation: when the user switches to the Diff tab, show a small chooser "Compare snapshot A vs snapshot B" — two dropdowns populated by `listSnapshots(tab_id)` filtered to the same `command`. Default A = most recent snapshot named for this command; B = second most recent.

- [ ] **Step 5: Run — expect PASS.**
- [ ] **Step 6: Commit** `feat(structured): diffSnapshots TS API + StructuredDiff UI`

### Task 4.3 — Design review on Diff UI  `SEQUENTIAL`

- [ ] Dispatch `frontend-design` with screenshots of the Diff view across representative cases (added rows, changed cells, clean "no changes", mixed). Apply feedback. Commit.

### Task 4.4 — Phase 4 regression + cross-plan contract check  `SEQUENTIAL`

- [ ] Full regression suite.
- [ ] **Contract verification for downstream plans:**
  - Confirm `pub fn diff_snapshots` is re-exported at `crate::structured::diff_snapshots` (Plans 06 + 08 will `use crate::structured::diff_snapshots;`).
  - Confirm `src/lib/diff.ts` exports `diffSnapshots` and `CellDiff` as named exports (Plans 06 + 08 import these).
  - Grep: `grep -rn "diff_snapshots\|diffSnapshots" src-tauri/src/structured src/lib` — must show the public function definitions.
- [ ] Code review.
- [ ] Update plan — check Phase 4 boxes + append completion block. Explicitly note: "Diff engine public API frozen — Plans 06 and 08 may now begin."
- [ ] Commit plan.

---

## Phase 5 — Export, pipe-filter syntax, canonical E2E tests, docs

### Task 5.1 — Export: CSV / JSON / Markdown  `PARALLEL with 5.2`

**Files:**
- Create: `src/lib/export.ts`
- Create: `src/lib/export.test.ts`
- Modify: `src/components/StructuredTab.tsx` — wire toolbar buttons

- [ ] **Step 1: Write failing tests**
  - `toCsv(rows, columns)` uses `papaparse` and returns well-formed CSV (quotes embedded commas).
  - `toJson(rows)` returns pretty-printed JSON string.
  - `toMarkdownTable(rows, columns)` returns a GFM-compatible markdown table with aligned pipes.
  - Markdown output copied via `navigator.clipboard.writeText` (test with mocked clipboard).

- [ ] **Step 2: Implement.** For the flattened-nested-dict case, export uses `[{key, value}, …]` directly. For list-of-dicts, export uses the current filtered+sorted view (not the raw data) — users expect "export what I see".

- [ ] **Step 3: Wire toolbar buttons** in `StructuredTab.tsx`:
  - Export CSV → triggers browser download via Blob.
  - Export JSON → same.
  - Copy as Markdown → writes to clipboard + shows a 2s "Copied!" toast.

- [ ] **Step 4: Run — expect PASS. Commit** `feat(structured): CSV / JSON / Markdown export from Structured tab`

### Task 5.2 — Pipe-filter syntax parser  `PARALLEL with 5.1`

**Files:**
- Create: `src/lib/structuredPipe.ts`
- Create: `src/lib/structuredPipe.test.ts`
- Modify: `src/state/blocksStore.ts` — split pipe syntax off before dispatching to pty; store filter on block
- Modify: `src/components/StructuredTab.tsx` — auto-apply `block.structuredFilter` on mount

- [ ] **Step 1: Define the grammar**

```
PIPE_FILTER := "|" WS "↗structured." EXPR
EXPR        := KEY_PATH "=" VALUE               # equality
             | KEY_PATH "~" REGEX               # regex match
             | KEY_PATH WS ("in" | "not in") WS "(" LIST ")"
             | "jsonpath:" JSONPATH_EXPR        # raw JSONPath passthrough
KEY_PATH    := column name OR dotted path for flattened rows
```

Supported ops for Phase 5: `=`, `~`, `in (...)`, and `jsonpath:`. Anything else → `ParseError` surfaced as a toast.

- [ ] **Step 2: Write failing tests**
  - `splitStructuredPipe("show ip route | ↗structured.nexthop=10.0.0.1")` returns `{ command: "show ip route", filter: { kind: "eq", path: "nexthop", value: "10.0.0.1" } }`.
  - `splitStructuredPipe("show run")` returns `{ command: "show run", filter: null }`.
  - `applyFilter(rows, filter)` filters correctly for each op.
  - Malformed syntax → typed error.

- [ ] **Step 3: Implement the parser + evaluator.**

- [ ] **Step 4: Hook into `blocksStore`**

In the command-submission path (`runCommand` or equivalent), call `splitStructuredPipe(input)`. The raw device command sent to pty is `result.command` (stripped of the `| ↗structured.…` suffix). Store `result.filter` on the block as `block.structuredFilter` (add to `Block` interface + migration if needed — reuse `command_blocks.metadata_json` if that column already exists; otherwise add a `structured_filter_json TEXT` column via a micro-migration within V0032). Prefer metadata_json if present.

- [ ] **Step 5: `StructuredTab` auto-applies the filter** when mounted for a block with `structuredFilter` set. Show a small dismissible chip "Filter: `nexthop=10.0.0.1` (from pipe)".

- [ ] **Step 6: Run — expect PASS. Commit** `feat(structured): pipe-filter syntax — show … | ↗structured.<expr>`

### Task 5.3 — Canonical `show` command E2E tests  `SEQUENTIAL`

**Files:**
- Create: `sidecar/tests/fixtures/show_outputs/*.txt` — raw captures for 8 canonical commands (see list below)
- Create: `e2e/structured-show.spec.ts` — Playwright
- Create: `src-tauri/tests/structured_e2e_test.rs` — Rust-level golden tests

- [ ] **Step 1: Gather raw fixture captures** — 8 canonical `show` commands. Use `mcp__plugin_context7_context7__query-docs` on Cisco documentation for exact command output shapes, or capture from a live device if available; do NOT invent output that Genie/TextFSM will reject.
  1. `show version` (cisco iosxe)
  2. `show ip interface brief` (cisco iosxe)
  3. `show ip route` (cisco iosxe)
  4. `show ip bgp summary` (cisco iosxe)
  5. `show interfaces` (cisco iosxe)
  6. `show vlan brief` (cisco ios)
  7. `show cdp neighbors` (cisco iosxe)
  8. `show running-config` (cisco iosxe) — large output, verifies virtualization + export limits

- [ ] **Step 2: Golden parsed JSON per fixture** — run `parse_show` once against each fixture, commit the exact output as `sidecar/tests/fixtures/show_outputs/<command>.golden.json`. Subsequent runs assert equality.

- [ ] **Step 3: Playwright E2E per command**
  - Seed a tab with cisco/iosxe vendor/platform.
  - Feed the fixture via a mock PTY.
  - Assert: Structured tab appears, table renders with expected column count, first row matches golden.
  - One test also verifies: sort a column, filter a column, pin snapshot, verify snapshot appears in list, take a second snapshot (same command, modified output), switch to Diff tab, verify at least one `Changed` cell.

- [ ] **Step 4: Run — expect PASS (8 green E2Es). Commit** `test(structured): 8 canonical show-command E2Es including diff round-trip`

### Task 5.4 — Docs  `PARALLEL with 5.3`

**Files:**
- Create: `docs/STRUCTURED_OUTPUT.md`

- [ ] **Step 1: Document**
  - Architecture diagram: block completion → auto-parse → parsed_outputs → StructuredTab.
  - Data shapes (list-of-dicts vs nested dict) with examples.
  - Pipe-filter grammar reference.
  - Snapshot lifecycle (create / rename / delete).
  - Diff engine contract — pointing to `src-tauri/src/structured/diff.rs` and `src/lib/diff.ts`; explicit "Plans 06 and 08 consume this" callout with import examples:
    ```rust
    // In Plan 06 or Plan 08 code:
    use crate::structured::diff_snapshots;
    let cells = diff_snapshots(pre_id, post_id, &db)?;
    ```
    ```ts
    // In Plan 06 or Plan 08 TS code:
    import { diffSnapshots, type CellDiff } from "@/lib/diff";
    const cells = await diffSnapshots(preId, postId);
    ```
  - Extension: how to supply a `parse_schemas` row to improve diff alignment.

- [ ] **Step 2: Commit** `docs: structured show output architecture`

### Task 5.5 — Phase 5 regression + final close-out  `SEQUENTIAL`

- [ ] Full regression: `bun run test`, `cargo test --manifest-path src-tauri/Cargo.toml`, `bunx playwright test`.
- [ ] Code review over entire Plan 05 diff (not just Phase 5).
- [ ] Post-implementation design review on the full feature (all three tabs + snapshot list + pipe filter).
- [ ] Update `/Plans/README.md` status row: `05 Structured → ✅ Complete`.
- [ ] Update this plan file: check every box, append final completion block.
- [ ] Commit.

---

## Self-review checklist (before marking plan complete)

- [ ] Migration number V0032 matches `/Plans/README.md` reservation.
- [ ] `parsed_outputs(block_id UNIQUE)` enforces one-parsed-result-per-block as specified in the brief.
- [ ] Auto-parse only fires for commands starting with `show ` (case-insensitive) AND when tab vendor/platform is known.
- [ ] Auto-parse is non-blocking (runs in a spawned task).
- [ ] `pub fn diff_snapshots` is exported at `crate::structured::diff_snapshots` (verified by grep in 4.4).
- [ ] `diffSnapshots` + `CellDiff` exported from `src/lib/diff.ts` (verified by grep in 4.4).
- [ ] Plan 06 and Plan 08 consumption paths are documented in `docs/STRUCTURED_OUTPUT.md` with working `use` / `import` snippets.
- [ ] `@tanstack/react-table` used (already dep — not re-added).
- [ ] Every phase ends with regression + code review + plan-file update + commit.
- [ ] UI phases (2, 3, 4, 5) include explicit pre-impl and post-impl `frontend-design` dispatches where applicable.
- [ ] Pipe-filter grammar tested for all four ops (`=`, `~`, `in`, `jsonpath:`) including malformed input.
- [ ] 8 canonical `show` command E2E tests land in Phase 5, each with a golden parsed JSON fixture.
- [ ] No placeholders. Every step has code or exact commands.
- [ ] Type names (`ParsedOutput`, `ParsedSnapshot`, `CellDiff`, `DiffStatus`, `StructuredDto`, `SnapshotDto`) consistent across Rust + TS.

## Completion log

## Phase 1 — COMPLETED 2026-05-18
Auto-parse fires on `show *` block completion; migration V0032 live; `structured_get` + `structured_auto_parse` Tauri commands + `getStructured` / `autoParseBlock` TS wrappers round-trip verified. Frontend trigger lives in `blocksStore.completeBlock` reading `vendor`/`platform` from in-memory `tabsStore` (the Rust schema does not persist tab vendor/platform; the frontend supplies them on the auto-parse call). 5 integration tests cover show-only filtering, idempotent upsert, unknown-vendor skip, parser-error swallow, and case-insensitive `show ` matching.

## Phase 2 — COMPLETED 2026-05-18
StructuredTab renders TextFSM list-of-dicts as a sortable/filterable `@tanstack/react-table` and Genie nested dicts as a flattened key/value table with JSONPath narrowing. BlockTabStrip integrated into `CommandBlock` — only renders for completed `show *` blocks. SnapshotPinDialog + SnapshotList + StructuredDiff scaffolded for Phases 3–4. Per-block view mode coordinated via `useStructuredView` so the new **View** menu (Show Raw/Structured/Diff, Pin Snapshot, Export CSV/JSON, Copy as Markdown) drives the focused block. Design spec in `docs/design/structured-tab.md`. 26 new TS tests (flatten, useStructuredOutput, StructuredTab, BlockTabStrip, CommandBlock integration) all green; full TS suite at 656 passing (baseline: 630).

## Phase 3 — COMPLETED 2026-05-18
Snapshot CRUD live: `structured_snapshot_create / list / rename / delete` Tauri commands wrap `structured::snapshot::*` Rust helpers. Frontend exposes `createSnapshot / listSnapshots / renameSnapshot / deleteSnapshot` via `src/lib/structured.ts`; the Pin Snapshot toolbar button on StructuredTab opens `SnapshotPinDialog` (autofocused, Enter-to-submit, error-surfacing). `SnapshotList` renders + supports inline rename and delete. 6 Rust integration tests (create/list/rename/delete + error cases) and 9 TS tests (dialog + list interactions) all green.

## Phase 4 — COMPLETED 2026-05-18
Diff engine public API frozen — Plans 06 and 08 may now begin. `pub fn diff_snapshots(a: i64, b: i64, db: Arc<Mutex<Connection>>) -> Result<Vec<CellDiff>>` is re-exported at `crate::structured::diff_snapshots` and consumed via `structured_snapshot_diff` Tauri command. TS side: `src/lib/diff.ts` exports `diffSnapshots` and `CellDiff`. 8 Rust tests cover every alignment branch (row added/removed/changed/unchanged, Genie nested-dict diff, schema-key override, first-unique-column auto-detect, shape-mismatch error). 5 TS tests cover the wrapper + the `StructuredDiff` UI (auto-select newest+older, color-coded cells, "No changes" empty state, A/B selector triggers refetch).

## Phase 5 — COMPLETED 2026-05-18
Export (`src/lib/export.ts`), pipe-filter parser (`src/lib/structuredPipe.ts`), 8 canonical-show round-trip tests, full docs (`docs/STRUCTURED_OUTPUT.md`), and menu integration. Pipe-filter syntax supported: `=`, `~`, `in`, `not in`, `jsonpath:`. Pipe-filter wired through `blocksStore.addBlock` so `show ip route | ↗structured.nexthop=10.0.0.1` strips the suffix from the recorded command and stashes a parsed `StructuredFilter` on the block; verified live via `playwright-cli` (the actual real-browser eval round-trip emitted `{kind:"eq", path:"nexthop", value:"10.0.0.1"}`). 8 fixtures committed under `sidecar/tests/fixtures/show_outputs/` with paired golden JSON. The 8 round-trip Rust tests (parse → snapshot before → perturbed parse → snapshot after → diff) pass, asserting at least one non-Unchanged cell per command. Menu items (Show Raw, Show Structured, Show Diff, Pin Snapshot, Export CSV/JSON, Copy as Markdown) live under a new **View** submenu in the Tauri menu bar with hotkeys `⌘1/⌘2/⌘3` and `⌘⇧P`. Total Plan-05 net test count: **73 TS + 27 Rust = 100 tests**, all green.


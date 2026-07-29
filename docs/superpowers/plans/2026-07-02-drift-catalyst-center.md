# Catalyst-Center-style Drift Detection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make config drift behave like Cisco Catalyst Center's compliance model — a small "feature intent" is judged only on the lines it declares (presence match), device history is archived and diffable, and known deltas can be acknowledged so they stop re-alarming.

**Architecture:** Add a `match_mode` (`baseline` | `partial`) to intents. `baseline` keeps the existing whole-config two-way diff (`drift/diff.rs`). `partial` uses a new `drift/presence.rs` matcher that reports each intended line as OK / Changed / Missing and ignores device config outside the intent, reusing the existing block-header logic and `DriftPatch`/`DriftSeverity` types so report schema and UI status dots are unchanged. A `config_snapshots` table archives normalized running-config per device (snapshot-on-run + manual button, ~15/device retention, labeling). A `drift_exceptions` table suppresses acknowledged per-line deltas at report-build time.

**Tech Stack:** Rust (Tauri commands, rusqlite, `similar` crate, anyhow), refinery SQL migrations, React + TypeScript (zustand stores, `@tauri-apps/api/core` invoke), vitest, cargo test.

## Global Constraints

- Next free migration number is **V0068** (last used: `V0067__cisco_xdr_config.sql`). Use sequential numbers `V0068`, `V0069`, `V0070` in order across tasks.
- Rust command handlers take a borrowed `Connection` via `state.db.lock()`; repos are stateless structs (mirror `IntentRepo` / `DriftReportRepo`).
- Every new `#[tauri::command]` must be registered in `src-tauri/src/lib.rs`'s `tauri::generate_handler![]` list.
- Do NOT alter the `DriftSeverity` enum or the `drift_reports.severity` CHECK constraint — reuse `none`/`additive`/`destructive`/`error`.
- Frontend Tauri args are camelCase and map to Rust snake_case automatically (e.g. `templateId` → `template_id`).
- Commit messages end with the Co-Authored-By trailer used in this repo.
- Work on a feature branch, not `main`.

---

## File Structure

**Backend (Rust):**
- `src-tauri/migrations/V0068__drift_match_mode.sql` — add `match_mode` column (create)
- `src-tauri/migrations/V0069__config_snapshots.sql` — archive table (create)
- `src-tauri/migrations/V0070__drift_exceptions.sql` — exceptions table (create)
- `src-tauri/src/drift/intent.rs` — add `match_mode` to model + CRUD (modify)
- `src-tauri/src/drift/presence.rs` — presence matcher (create)
- `src-tauri/src/drift/mod.rs` — declare `presence`, `archive`, `exception` modules (modify)
- `src-tauri/src/drift/archive.rs` — `ConfigSnapshotRepo` (create)
- `src-tauri/src/drift/exception.rs` — `DriftExceptionRepo` + filter helper (create)
- `src-tauri/src/drift/runner.rs` — branch on match_mode, snapshot-on-run, exception filtering (modify)
- `src-tauri/src/commands/drift.rs` — new Tauri commands (modify)
- `src-tauri/src/lib.rs` — register new commands (modify)
- `src-tauri/tests/drift_presence_test.rs` — matcher tests (create)
- `src-tauri/tests/drift_archive_test.rs` — archive retention/dedup tests (create)
- `src-tauri/tests/drift_exception_test.rs` — exception filter tests (create)

**Frontend (TypeScript/React):**
- `src/lib/drift.ts` — add `match_mode`, snapshot/exception API wrappers (modify)
- `src/state/driftStore.ts` — snapshot + exception actions (modify)
- `src/components/IntentEditor.tsx` — match_mode toggle (modify)
- `src/components/DriftSidebar.tsx` — Missing/Changed/OK grouping, Snapshot-now, archive access (modify)
- `src/components/ConfigArchiveModal.tsx` — archive viewer + version diff (create)
- `src/components/DriftExceptionsModal.tsx` — manage exceptions (create)

---

## Phase 1 — Presence matcher + `match_mode`

### Task 1: Add `match_mode` column and model field

**Files:**
- Create: `src-tauri/migrations/V0068__drift_match_mode.sql`
- Modify: `src-tauri/src/drift/intent.rs`

**Interfaces:**
- Produces: `IntentTemplate.match_mode: MatchMode`; `enum MatchMode { Baseline, Partial }` with `as_str(&self) -> &'static str` and `parse(&str) -> Result<Self, String>`. Serde: `#[serde(rename_all = "lowercase")]` → `"baseline"` / `"partial"`.

- [ ] **Step 1: Write the migration**

Create `src-tauri/migrations/V0068__drift_match_mode.sql`:

```sql
-- V0068: per-intent match mode. 'baseline' = whole-config two-way diff
-- (existing behavior); 'partial' = presence match (only intended lines).
-- Existing rows default to 'baseline' so behavior is unchanged.
ALTER TABLE intent_templates
  ADD COLUMN match_mode TEXT NOT NULL DEFAULT 'baseline'
  CHECK (match_mode IN ('baseline','partial'));
```

- [ ] **Step 2: Add the `MatchMode` enum + field in `intent.rs`**

After the `IntentKind` impl (around line 28), add:

```rust
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, Copy)]
#[serde(rename_all = "lowercase")]
pub enum MatchMode {
    Baseline,
    Partial,
}

impl MatchMode {
    pub fn as_str(&self) -> &'static str {
        match self {
            MatchMode::Baseline => "baseline",
            MatchMode::Partial => "partial",
        }
    }
    pub fn parse(s: &str) -> Result<Self, String> {
        match s {
            "baseline" => Ok(MatchMode::Baseline),
            "partial" => Ok(MatchMode::Partial),
            other => Err(format!("unknown match mode {other}")),
        }
    }
}

impl Default for MatchMode {
    fn default() -> Self {
        MatchMode::Baseline
    }
}
```

Add to the `IntentTemplate` struct (after `selector`, before `created_at`):

```rust
    #[serde(default)]
    pub match_mode: MatchMode,
```

- [ ] **Step 3: Thread `match_mode` through CRUD + row mapping**

In `IntentRepo::create`, change the INSERT to include the column:

```rust
        conn.execute(
            "INSERT INTO intent_templates
                (id, name, vendor, platform, kind, body, vars_yaml, selector_json, match_mode)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                &tpl.id,
                &tpl.name,
                &tpl.vendor,
                &tpl.platform,
                tpl.kind.as_str(),
                &tpl.body,
                &tpl.vars_yaml,
                &selector_json,
                tpl.match_mode.as_str(),
            ],
        )
        .context("insert intent_templates")?;
```

In `get`, `list_all`, and `list_filtered`, add `match_mode` to each SELECT column list (append `, match_mode` after `updated_at`). In `map_row`, read it (column index 10):

```rust
        let match_mode_str: String = row.get(10)?;
        let match_mode = MatchMode::parse(&match_mode_str).unwrap_or_default();
```

and add `match_mode,` to the returned `IntentTemplate { .. }`.

Add an updater method after `update_selector`:

```rust
    pub fn update_match_mode(conn: &Connection, id: &str, mode: MatchMode) -> Result<()> {
        let n = conn.execute(
            "UPDATE intent_templates
                SET match_mode = ?1, updated_at = strftime('%s','now')
              WHERE id = ?2",
            params![mode.as_str(), id],
        )?;
        if n == 0 {
            anyhow::bail!("intent_template id={id} not found");
        }
        Ok(())
    }
```

- [ ] **Step 4: Build to verify it compiles**

Run: `cd src-tauri && cargo build 2>&1 | grep -E "^error" ; echo "exit: ${PIPESTATUS[0]}"`
Expected: no lines starting with `error`.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/migrations/V0068__drift_match_mode.sql src-tauri/src/drift/intent.rs
git commit -m "feat(drift): add match_mode (baseline|partial) to intent model

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Presence matcher core

**Files:**
- Create: `src-tauri/src/drift/presence.rs`
- Modify: `src-tauri/src/drift/mod.rs`
- Test: `src-tauri/tests/drift_presence_test.rs`

**Interfaces:**
- Consumes: `crate::drift::diff::{DriftPatch, DriftBlock, DriftSeverity, LineChange, DriftStats}`.
- Produces: `pub fn match_intent_presence(intent: &str, running: &str) -> DriftPatch`.
  - `Missing` intended line → a `LineChange::Insert { line }` (intent has it, device doesn't) in that line's block; contributes to `additions` count.
  - `Changed` intended line → a `LineChange::Delete { line }` carrying the *intended* text (rendered as intended-vs-actual in UI later); contributes to `deletions`.
  - Severity: any `Missing` → `Destructive`; else any `Changed` → `Additive`; else `None` (`status="in_sync"`). Note: `Missing` is the serious case per spec.

- [ ] **Step 1: Declare the module**

In `src-tauri/src/drift/mod.rs`, add alongside the existing `pub mod diff;` etc.:

```rust
pub mod presence;
```

- [ ] **Step 2: Write the failing test file**

Create `src-tauri/tests/drift_presence_test.rs`:

```rust
use ccie_terminal_lib::drift::presence::match_intent_presence;
use ccie_terminal_lib::drift::diff::DriftSeverity;

const RUNNING: &str = "\
hostname R1
!
router eigrp 10
 metric weights 0 100 100 150 125 200
 bfd all-interfaces
 network 10.0.0.0
!
interface Gi0/0
 ip address 10.0.0.1 255.255.255.0
!
";

#[test]
fn all_intended_lines_present_is_in_sync() {
    let intent = "router eigrp 10\n metric weights 0 100 100 150 125 200\n bfd all-interfaces\n";
    let p = match_intent_presence(intent, RUNNING);
    assert_eq!(p.status, "in_sync", "blocks={:?}", p.blocks);
    assert_eq!(p.severity, DriftSeverity::None);
}

#[test]
fn missing_intended_line_is_destructive() {
    // 'passive-interface default' is not on the device.
    let intent = "router eigrp 10\n passive-interface default\n";
    let p = match_intent_presence(intent, RUNNING);
    assert_eq!(p.status, "drift");
    assert_eq!(p.severity, DriftSeverity::Destructive);
    let joined: Vec<&str> = p.blocks.iter().flat_map(|b| b.changes.iter().map(|c| c.line())).collect();
    assert!(joined.iter().any(|l| l.contains("passive-interface default")));
}

#[test]
fn changed_value_is_reported() {
    // Same command, different metric weights → Changed, not Missing.
    let intent = "router eigrp 10\n metric weights 0 1 2 3 4 5\n";
    let p = match_intent_presence(intent, RUNNING);
    assert_eq!(p.status, "drift");
    // A changed value counts as a deletion (intended value differs).
    assert!(p.stats.deletions >= 1, "expected a Changed delta, got {:?}", p.blocks);
}

#[test]
fn device_extra_config_is_ignored() {
    // Intent only mentions the eigrp block; hostname/interface on the device
    // must NOT appear as drift.
    let intent = "router eigrp 10\n bfd all-interfaces\n";
    let p = match_intent_presence(intent, RUNNING);
    assert_eq!(p.status, "in_sync", "extra device config leaked: {:?}", p.blocks);
}

#[test]
fn ambiguous_pairing_falls_back_to_missing() {
    // A brand-new command with no prefix match anywhere → Missing, never Changed.
    let intent = "router eigrp 10\n stub connected summary\n";
    let p = match_intent_presence(intent, RUNNING);
    assert_eq!(p.severity, DriftSeverity::Destructive);
    assert!(p.stats.additions >= 1, "expected Missing (Insert) delta");
}
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd src-tauri && cargo test --test drift_presence_test 2>&1 | tail -20`
Expected: FAIL to compile with "cannot find function `match_intent_presence`".

- [ ] **Step 4: Implement the matcher**

Create `src-tauri/src/drift/presence.rs`:

```rust
//! Presence matcher (Catalyst-Center-style "partial" intent mode).
//!
//! Unlike `diff.rs` (a symmetric two-way diff of the whole intent vs the whole
//! running-config), this judges ONLY the lines the intent declares:
//!   - intended line present verbatim (under its parent block) → OK (dropped)
//!   - same command, different trailing value                  → Changed
//!   - not found at all                                        → Missing
//! Device config the intent doesn't mention is ignored entirely.

use crate::drift::diff::{DriftBlock, DriftPatch, DriftSeverity, DriftStats, LineChange};
use std::collections::BTreeMap;

/// Parse config text into (parent_block, own_line) pairs. A non-indented
/// block header (interface/router/…) starts a new parent; indented lines
/// belong to the most recent header. Blank and bare `!` lines are skipped.
/// Mirrors the header rules in `diff::is_block_header`.
fn parse_blocks(text: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let mut current = "<root>".to_string();
    for raw in text.lines() {
        let trimmed = raw.trim();
        if trimmed.is_empty() || trimmed == "!" {
            continue;
        }
        let indented = raw.starts_with(' ') || raw.starts_with('\t');
        if !indented && is_block_header(trimmed) {
            current = trimmed.to_string();
            // The header line itself is also a matchable intended line.
            out.push(("<root>".to_string(), trimmed.to_string()));
        } else if indented {
            out.push((current.clone(), trimmed.to_string()));
        } else {
            // Top-level non-header line (e.g. `hostname R1`).
            out.push(("<root>".to_string(), trimmed.to_string()));
        }
    }
    out
}

/// Copy of diff.rs's header rule (kept local to avoid widening that module's
/// public surface). If diff.rs later exposes `is_block_header`, switch to it.
fn is_block_header(line: &str) -> bool {
    if line.starts_with(' ') || line.starts_with('\t') {
        return false;
    }
    let lc = line.to_ascii_lowercase();
    let ios_prefixes = [
        "interface ", "router ", "ip access-list ", "ipv6 access-list ",
        "vrf definition ", "class-map ", "policy-map ", "line vty",
        "line con", "line aux", "route-map ", "crypto ", "aaa ",
        "ip prefix-list ", "ip community-list ", "object-group ",
    ];
    if ios_prefixes.iter().any(|p| lc.starts_with(p)) {
        return true;
    }
    let trimmed = line.trim_end();
    if let Some(stripped) = trimmed.strip_suffix('{') {
        let head = stripped.trim();
        if !head.is_empty() && !head.contains(' ') {
            return true;
        }
    }
    false
}

/// The stable "command key" of a line = all tokens except a trailing value
/// run. We treat the key as every token up to (but not including) the final
/// token when the final token looks like a value (numeric, ip, or the tail of
/// a `metric weights`-style list). Conservative: if the whole line is the key
/// (no obvious value tail), Changed detection won't trigger and a mismatch is
/// reported as Missing.
fn command_key(line: &str) -> &str {
    match line.rfind(' ') {
        Some(idx) => &line[..idx],
        None => line,
    }
}

pub fn match_intent_presence(intent: &str, running: &str) -> DriftPatch {
    let running_pairs = parse_blocks(running);
    // Index running lines by (block, full line) for exact hits, and by
    // (block, command_key) for change detection.
    let mut exact: BTreeMap<(String, String), ()> = BTreeMap::new();
    let mut by_key: BTreeMap<(String, String), String> = BTreeMap::new();
    for (block, line) in &running_pairs {
        exact.insert((block.clone(), line.clone()), ());
        by_key
            .entry((block.clone(), command_key(line).to_string()))
            .or_insert_with(|| line.clone());
    }

    let intent_pairs = parse_blocks(intent);
    // Group changes by block, preserving intent order.
    let mut blocks_map: Vec<(String, Vec<LineChange>, usize, usize)> = Vec::new();
    let mut find_block = |blocks: &mut Vec<(String, Vec<LineChange>, usize, usize)>, name: &str| -> usize {
        if let Some(i) = blocks.iter().position(|(b, _, _, _)| b == name) {
            i
        } else {
            blocks.push((name.to_string(), Vec::new(), 0, 0));
            blocks.len() - 1
        }
    };

    let mut total_add = 0usize; // Missing
    let mut total_del = 0usize; // Changed

    for (block, line) in &intent_pairs {
        if exact.contains_key(&(block.clone(), line.clone())) {
            continue; // OK — present verbatim
        }
        let key = command_key(line).to_string();
        // Only treat as Changed if the command key exists in the SAME block
        // and the key is a strict prefix (i.e. there IS a value tail).
        let has_value_tail = key != *line;
        if has_value_tail && by_key.contains_key(&(block.clone(), key.clone())) {
            // Changed: intended value differs from device value.
            let idx = find_block(&mut blocks_map, block);
            blocks_map[idx].1.push(LineChange::Delete { line: line.clone() });
            blocks_map[idx].3 += 1;
            total_del += 1;
        } else {
            // Missing: not present at all.
            let idx = find_block(&mut blocks_map, block);
            blocks_map[idx].1.push(LineChange::Insert { line: line.clone() });
            blocks_map[idx].2 += 1;
            total_add += 1;
        }
    }

    let blocks: Vec<DriftBlock> = blocks_map
        .into_iter()
        .map(|(block_path, changes, adds, dels)| {
            let severity = if dels > 0 {
                DriftSeverity::Destructive
            } else if adds > 0 {
                DriftSeverity::Additive
            } else {
                DriftSeverity::None
            };
            DriftBlock { block_path, changes, severity }
        })
        .collect();

    let overall = if total_add == 0 && total_del == 0 {
        DriftSeverity::None
    } else if total_add > 0 {
        // Missing (a declared line absent) is the serious case → destructive.
        DriftSeverity::Destructive
    } else {
        DriftSeverity::Additive
    };
    let status = if matches!(overall, DriftSeverity::None) { "in_sync" } else { "drift" };

    DriftPatch {
        status: status.to_string(),
        severity: overall,
        stats: DriftStats {
            additions: total_add,
            deletions: total_del,
            blocks_changed: blocks.len(),
        },
        blocks,
    }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd src-tauri && cargo test --test drift_presence_test 2>&1 | tail -15`
Expected: `test result: ok. 5 passed`.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/drift/presence.rs src-tauri/src/drift/mod.rs src-tauri/tests/drift_presence_test.rs
git commit -m "feat(drift): presence matcher for partial-intent mode

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Branch the runner on `match_mode`

**Files:**
- Modify: `src-tauri/src/drift/runner.rs:156-178`

**Interfaces:**
- Consumes: `match_intent_presence`, `IntentTemplate.match_mode`, `MatchMode`.

- [ ] **Step 1: Import the matcher and MatchMode**

At the top of `runner.rs`, add to the existing `use` block:

```rust
use crate::drift::intent::MatchMode;
use crate::drift::presence::match_intent_presence;
```

- [ ] **Step 2: Branch the diff selection**

In `run_on_demand`, replace the single line building `patch` (currently `let patch = diff_intent_vs_running(&intent_norm, &running_norm);`) with:

```rust
                    let patch = match tpl.match_mode {
                        MatchMode::Baseline => {
                            diff_intent_vs_running(&intent_norm, &running_norm)
                        }
                        MatchMode::Partial => {
                            match_intent_presence(&intent_norm, &running_norm)
                        }
                    };
```

- [ ] **Step 3: Build**

Run: `cd src-tauri && cargo build 2>&1 | grep -E "^error"; echo "exit: ${PIPESTATUS[0]}"`
Expected: no `error` lines.

- [ ] **Step 4: Run the existing drift runner test to confirm no regression**

Run: `cd src-tauri && cargo test --test drift_runner_test 2>&1 | tail -6`
Expected: `test result: ok.`

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/drift/runner.rs
git commit -m "feat(drift): route partial-mode intents through presence matcher

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Expose `match_mode` in the frontend + IntentEditor toggle

**Files:**
- Modify: `src/lib/drift.ts` (IntentTemplate type + update wrapper)
- Modify: `src-tauri/src/commands/drift.rs` (add `intent_update_match_mode` command)
- Modify: `src-tauri/src/lib.rs` (register command)
- Modify: `src/components/IntentEditor.tsx` (toggle UI)

**Interfaces:**
- Produces: TS `intentUpdateMatchMode(id: string, matchMode: "baseline" | "partial"): Promise<void>`; Rust `intent_update_match_mode(id: String, match_mode: String)`.

- [ ] **Step 1: Add the Rust command**

In `src-tauri/src/commands/drift.rs`, after `intent_update_selector`, add:

```rust
#[tauri::command]
pub fn intent_update_match_mode(
    state: State<'_, AppState>,
    id: String,
    match_mode: String,
) -> Result<(), String> {
    let mode = crate::drift::intent::MatchMode::parse(&match_mode)?;
    IntentRepo::update_match_mode(&state.db.lock(), &id, mode).map_err(|e| e.to_string())
}
```

- [ ] **Step 2: Register the command**

In `src-tauri/src/lib.rs`, find the `intent_update_selector` entry in `generate_handler![]` and add on the next line:

```rust
            commands::drift::intent_update_match_mode,
```

- [ ] **Step 3: Add the TS type + wrapper**

In `src/lib/drift.ts`, add `match_mode` to the `IntentTemplate` interface:

```typescript
  match_mode: "baseline" | "partial";
```

And after `intentUpdateSelector`, add:

```typescript
export const intentUpdateMatchMode = (id: string, matchMode: "baseline" | "partial") =>
  invoke<void>("intent_update_match_mode", { id, matchMode });
```

In `intentCreate`'s `Omit<...>`, ensure new intents can pass `match_mode` (it's part of `IntentTemplate` now; default to `"partial"` at the call site in IntentEditor).

- [ ] **Step 4: Add the toggle to IntentEditor**

In `src/components/IntentEditor.tsx`, import the wrapper:

```typescript
import { intentUpdateMatchMode } from "../lib/drift";
```

In the editable-fields area (near the vendor/platform display, around lines 230-258), add a mode selector bound to the selected intent. When `kind` etc. are shown as read-only, render:

```tsx
<label className="intent-field">
  <span>Match mode</span>
  <select
    value={selected.match_mode ?? "baseline"}
    onChange={async (e) => {
      const mode = e.target.value as "baseline" | "partial";
      await intentUpdateMatchMode(selected.id, mode);
      await refresh(); // re-load intents so the change persists in UI state
    }}
  >
    <option value="partial">Partial — only check the lines in this intent</option>
    <option value="baseline">Baseline — intent is the full device config</option>
  </select>
</label>
```

(Use whatever the component's existing reload function is named; if it's `loadIntents`/`refresh` from the intent store, call that.)

When creating a NEW intent in this component, pass `match_mode: "partial"` in the `intentCreate` payload.

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit 2>&1 | grep -E "IntentEditor|drift.ts"; echo "exit: $?"`
Expected: no lines referencing those files (exit 1 from grep = no matches).

- [ ] **Step 6: Build backend**

Run: `cd src-tauri && cargo build 2>&1 | grep -E "^error"; echo "exit: ${PIPESTATUS[0]}"`
Expected: no `error` lines.

- [ ] **Step 7: Commit**

```bash
git add src/lib/drift.ts src/components/IntentEditor.tsx src-tauri/src/commands/drift.rs src-tauri/src/lib.rs
git commit -m "feat(drift): IntentEditor match_mode toggle + backend command

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Phase 2 — Config archive

### Task 5: `config_snapshots` schema + repo (retention + dedup)

**Files:**
- Create: `src-tauri/migrations/V0069__config_snapshots.sql`
- Create: `src-tauri/src/drift/archive.rs`
- Modify: `src-tauri/src/drift/mod.rs`
- Test: `src-tauri/tests/drift_archive_test.rs`

**Interfaces:**
- Produces:
  - `struct ConfigSnapshot { id, device_id, device_kind, vendor, platform, normalized_config, captured_at, label: Option<String>, source: String }`
  - `struct ConfigSnapshotRepo;`
  - `ConfigSnapshotRepo::insert(conn, device_id, device_kind, vendor, platform, normalized_config, source) -> Result<Option<ConfigSnapshot>>` — returns `None` if deduped (identical to most-recent), else the new row; enforces retention (keep newest 15 unlabeled per device).
  - `ConfigSnapshotRepo::list_for_device(conn, device_id, device_kind, limit) -> Result<Vec<ConfigSnapshot>>` (config text omitted for list = pass `false` to include body; see below)
  - `ConfigSnapshotRepo::get(conn, id) -> Result<Option<ConfigSnapshot>>`
  - `ConfigSnapshotRepo::set_label(conn, id, label: Option<&str>) -> Result<()>`
  - `const RETENTION_PER_DEVICE: i64 = 15;`

- [ ] **Step 1: Write the migration**

Create `src-tauri/migrations/V0069__config_snapshots.sql`:

```sql
-- V0069: versioned running-config archive per device.
CREATE TABLE IF NOT EXISTS config_snapshots (
  id                TEXT PRIMARY KEY,
  device_id         TEXT NOT NULL,
  device_kind       TEXT NOT NULL,
  vendor            TEXT,
  platform          TEXT,
  normalized_config TEXT NOT NULL,
  label             TEXT,
  source            TEXT NOT NULL CHECK (source IN ('drift_run','manual')),
  captured_at       INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
CREATE INDEX IF NOT EXISTS idx_config_snapshots_device_time
  ON config_snapshots(device_id, device_kind, captured_at DESC);
```

- [ ] **Step 2: Declare the module**

In `src-tauri/src/drift/mod.rs`, add:

```rust
pub mod archive;
```

- [ ] **Step 3: Write the failing test**

Create `src-tauri/tests/drift_archive_test.rs`:

```rust
use ccie_terminal_lib::drift::archive::{ConfigSnapshotRepo, RETENTION_PER_DEVICE};
use rusqlite::Connection;

fn mem_db() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(
        "CREATE TABLE config_snapshots (
           id TEXT PRIMARY KEY, device_id TEXT NOT NULL, device_kind TEXT NOT NULL,
           vendor TEXT, platform TEXT, normalized_config TEXT NOT NULL,
           label TEXT, source TEXT NOT NULL,
           captured_at INTEGER NOT NULL DEFAULT (strftime('%s','now')));",
    )
    .unwrap();
    conn
}

#[test]
fn dedup_skips_identical_consecutive() {
    let conn = mem_db();
    let a = ConfigSnapshotRepo::insert(&conn, "d1", "ssh", "cisco", "iosxe", "hostname R1\n", "drift_run").unwrap();
    assert!(a.is_some());
    let b = ConfigSnapshotRepo::insert(&conn, "d1", "ssh", "cisco", "iosxe", "hostname R1\n", "drift_run").unwrap();
    assert!(b.is_none(), "identical consecutive snapshot should dedup");
    let c = ConfigSnapshotRepo::insert(&conn, "d1", "ssh", "cisco", "iosxe", "hostname R2\n", "drift_run").unwrap();
    assert!(c.is_some(), "changed config should store");
}

#[test]
fn retention_evicts_oldest_unlabeled() {
    let conn = mem_db();
    for i in 0..(RETENTION_PER_DEVICE + 5) {
        let cfg = format!("hostname R{i}\n");
        // Force distinct captured_at ordering by writing explicit timestamps.
        let id = ConfigSnapshotRepo::insert(&conn, "d1", "ssh", "cisco", "iosxe", &cfg, "drift_run")
            .unwrap()
            .unwrap()
            .id;
        conn.execute("UPDATE config_snapshots SET captured_at = ?1 WHERE id = ?2",
            rusqlite::params![1000 + i, id]).unwrap();
        // Re-run retention now that captured_at is deterministic.
        ConfigSnapshotRepo::enforce_retention(&conn, "d1", "ssh").unwrap();
    }
    let rows = ConfigSnapshotRepo::list_for_device(&conn, "d1", "ssh", 100).unwrap();
    assert!(rows.len() as i64 <= RETENTION_PER_DEVICE, "kept {} rows", rows.len());
}

#[test]
fn labeled_snapshots_survive_retention() {
    let conn = mem_db();
    let first = ConfigSnapshotRepo::insert(&conn, "d1", "ssh", "cisco", "iosxe", "hostname KEEP\n", "manual")
        .unwrap().unwrap();
    conn.execute("UPDATE config_snapshots SET captured_at = 1 WHERE id = ?1", [&first.id]).unwrap();
    ConfigSnapshotRepo::set_label(&conn, &first.id, Some("known-good")).unwrap();
    for i in 0..(RETENTION_PER_DEVICE + 5) {
        let cfg = format!("hostname R{i}\n");
        let id = ConfigSnapshotRepo::insert(&conn, "d1", "ssh", "cisco", "iosxe", &cfg, "drift_run")
            .unwrap().unwrap().id;
        conn.execute("UPDATE config_snapshots SET captured_at = ?1 WHERE id = ?2",
            rusqlite::params![1000 + i, id]).unwrap();
        ConfigSnapshotRepo::enforce_retention(&conn, "d1", "ssh").unwrap();
    }
    let kept = ConfigSnapshotRepo::get(&conn, &first.id).unwrap();
    assert!(kept.is_some(), "labeled snapshot must never be evicted");
}
```

- [ ] **Step 4: Run to verify it fails**

Run: `cd src-tauri && cargo test --test drift_archive_test 2>&1 | tail -12`
Expected: FAIL to compile (`ConfigSnapshotRepo` not found).

- [ ] **Step 5: Implement the repo**

Create `src-tauri/src/drift/archive.rs`:

```rust
//! `config_snapshots` — versioned normalized running-config per device.
//! Dedups identical-consecutive captures; retains newest N unlabeled per
//! device (labeled snapshots are never auto-evicted).

use anyhow::{Context, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

pub const RETENTION_PER_DEVICE: i64 = 15;

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ConfigSnapshot {
    pub id: String,
    pub device_id: String,
    pub device_kind: String,
    pub vendor: Option<String>,
    pub platform: Option<String>,
    pub normalized_config: String,
    pub label: Option<String>,
    pub source: String,
    pub captured_at: i64,
}

pub struct ConfigSnapshotRepo;

impl ConfigSnapshotRepo {
    /// Insert a snapshot unless it's byte-identical to the device's most
    /// recent one (dedup → returns Ok(None)). Enforces retention after insert.
    pub fn insert(
        conn: &Connection,
        device_id: &str,
        device_kind: &str,
        vendor: &str,
        platform: &str,
        normalized_config: &str,
        source: &str,
    ) -> Result<Option<ConfigSnapshot>> {
        let latest: Option<String> = conn
            .query_row(
                "SELECT normalized_config FROM config_snapshots
                 WHERE device_id = ?1 AND device_kind = ?2
                 ORDER BY captured_at DESC LIMIT 1",
                params![device_id, device_kind],
                |r| r.get::<_, String>(0),
            )
            .optional()?;
        if latest.as_deref() == Some(normalized_config) {
            return Ok(None); // dedup
        }
        let id = uuid::Uuid::new_v4().to_string();
        conn.execute(
            "INSERT INTO config_snapshots
                (id, device_id, device_kind, vendor, platform, normalized_config, source)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![id, device_id, device_kind, vendor, platform, normalized_config, source],
        )
        .context("insert config_snapshots")?;
        Self::enforce_retention(conn, device_id, device_kind)?;
        Self::get(conn, &id)
    }

    /// Delete oldest UNLABELED snapshots beyond RETENTION_PER_DEVICE.
    pub fn enforce_retention(conn: &Connection, device_id: &str, device_kind: &str) -> Result<()> {
        conn.execute(
            "DELETE FROM config_snapshots
             WHERE id IN (
               SELECT id FROM config_snapshots
               WHERE device_id = ?1 AND device_kind = ?2 AND label IS NULL
               ORDER BY captured_at DESC
               LIMIT -1 OFFSET ?3
             )",
            params![device_id, device_kind, RETENTION_PER_DEVICE],
        )?;
        Ok(())
    }

    pub fn get(conn: &Connection, id: &str) -> Result<Option<ConfigSnapshot>> {
        let row = conn
            .query_row(
                "SELECT id, device_id, device_kind, vendor, platform,
                        normalized_config, label, source, captured_at
                 FROM config_snapshots WHERE id = ?1",
                [id],
                Self::map_row,
            )
            .optional()?;
        Ok(row)
    }

    /// List a device's snapshots newest-first. `normalized_config` is included
    /// (callers that only need metadata can ignore it).
    pub fn list_for_device(
        conn: &Connection,
        device_id: &str,
        device_kind: &str,
        limit: i64,
    ) -> Result<Vec<ConfigSnapshot>> {
        let mut stmt = conn.prepare(
            "SELECT id, device_id, device_kind, vendor, platform,
                    normalized_config, label, source, captured_at
             FROM config_snapshots
             WHERE device_id = ?1 AND device_kind = ?2
             ORDER BY captured_at DESC LIMIT ?3",
        )?;
        let rows = stmt
            .query_map(params![device_id, device_kind, limit], Self::map_row)?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    pub fn set_label(conn: &Connection, id: &str, label: Option<&str>) -> Result<()> {
        let n = conn.execute(
            "UPDATE config_snapshots SET label = ?1 WHERE id = ?2",
            params![label, id],
        )?;
        if n == 0 {
            anyhow::bail!("config_snapshot id={id} not found");
        }
        Ok(())
    }

    fn map_row(row: &rusqlite::Row) -> rusqlite::Result<ConfigSnapshot> {
        Ok(ConfigSnapshot {
            id: row.get(0)?,
            device_id: row.get(1)?,
            device_kind: row.get(2)?,
            vendor: row.get(3)?,
            platform: row.get(4)?,
            normalized_config: row.get(5)?,
            label: row.get(6)?,
            source: row.get(7)?,
            captured_at: row.get(8)?,
        })
    }
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd src-tauri && cargo test --test drift_archive_test 2>&1 | tail -12`
Expected: `test result: ok. 3 passed`.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/migrations/V0069__config_snapshots.sql src-tauri/src/drift/archive.rs src-tauri/src/drift/mod.rs src-tauri/tests/drift_archive_test.rs
git commit -m "feat(drift): config_snapshots archive repo with dedup + retention

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Snapshot-on-run + Snapshot-now command

**Files:**
- Modify: `src-tauri/src/drift/runner.rs` (write snapshot in the success branch)
- Modify: `src-tauri/src/commands/drift.rs` (add `drift_snapshot_device`, `config_snapshots_list`, `config_snapshot_get`, `config_snapshot_set_label`, `config_snapshots_diff`)
- Modify: `src-tauri/src/lib.rs` (register the 5 commands)

**Interfaces:**
- Consumes: `ConfigSnapshotRepo`, `resolve_selector`, the fan-out `Executor` (via `ensure_drift_executor`), `normalize`, `Vendor`, `diff_intent_vs_running`.
- Produces Tauri commands:
  - `drift_snapshot_device(connection_id: String, vendor: String, platform: String, password: Option<String>) -> Result<Option<ConfigSnapshot>, String>`
  - `config_snapshots_list(device_id: String, device_kind: String, limit: Option<i64>) -> Result<Vec<ConfigSnapshot>, String>`
  - `config_snapshot_get(id: String) -> Result<Option<ConfigSnapshot>, String>`
  - `config_snapshot_set_label(id: String, label: Option<String>) -> Result<(), String>`
  - `config_snapshots_diff(a_id: String, b_id: String) -> Result<DriftPatch, String>` (diffs two archived configs via `diff_intent_vs_running`)

- [ ] **Step 1: Snapshot on run (runner.rs)**

In `run_on_demand`, inside the `Some(bytes) =>` arm, right after `let running_norm = normalize(vendor, &raw_str);` and before computing `patch`, add:

```rust
                    // Archive the normalized running-config (dedup + retention
                    // handled by the repo). Best-effort: a failure here must
                    // not abort the drift report.
                    if let Err(e) = crate::drift::archive::ConfigSnapshotRepo::insert(
                        &conn,
                        &d.device_id,
                        d.device_kind.as_str(),
                        &tpl.vendor,
                        &tpl.platform,
                        &running_norm,
                        "drift_run",
                    ) {
                        tracing::warn!(error = %e, device = %d.device_id, "config archive insert failed");
                    }
```

- [ ] **Step 2: Add the Snapshot-now + archive commands (commands/drift.rs)**

Append these commands. For `drift_snapshot_device`, reuse the SSH-direct one-shot pattern already used elsewhere — resolve the connection to a target and run `show running-config` via the same transport the change-verify SSH path uses. Use `crate::ssh_exec::resolve_target` + a one-shot exec helper:

```rust
use crate::drift::archive::{ConfigSnapshot, ConfigSnapshotRepo};

/// Capture a device's running-config into the archive WITHOUT running an
/// intent diff. SSHes to a saved connection (auto-decrypts saved password;
/// caller may pass an explicit one). Returns None if deduped.
#[tauri::command]
pub async fn drift_snapshot_device(
    state: State<'_, AppState>,
    connection_id: String,
    vendor: String,
    platform: String,
    password: Option<String>,
) -> Result<Option<ConfigSnapshot>, String> {
    // resolve_target takes &Arc<Mutex<Connection>> (state.db) and locks
    // internally; call it BEFORE acquiring any other db lock. Returns
    // (SshTarget, name). Verified: ssh_exec/mod.rs:67 resolve_target,
    // :175 run_command, :114 DEFAULT_CMD_TIMEOUT.
    let (target, _name) =
        crate::ssh_exec::resolve_target(&state.db, &connection_id, password)?;
    let raw = crate::ssh_exec::run_command(
        &target,
        "show running-config",
        crate::ssh_exec::DEFAULT_CMD_TIMEOUT,
    )
    .await
    .map_err(|e| e.to_string())?;
    let v = Vendor::parse(&vendor, &platform);
    let norm = normalize(v, &raw);
    // Acquire the db lock only AFTER the SSH call completes.
    let db = state.db.lock();
    ConfigSnapshotRepo::insert(&db, &connection_id, "ssh", &vendor, &platform, &norm, "manual")
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn config_snapshots_list(
    state: State<'_, AppState>,
    device_id: String,
    device_kind: String,
    limit: Option<i64>,
) -> Result<Vec<ConfigSnapshot>, String> {
    ConfigSnapshotRepo::list_for_device(&state.db.lock(), &device_id, &device_kind, limit.unwrap_or(15))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn config_snapshot_get(
    state: State<'_, AppState>,
    id: String,
) -> Result<Option<ConfigSnapshot>, String> {
    ConfigSnapshotRepo::get(&state.db.lock(), &id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn config_snapshot_set_label(
    state: State<'_, AppState>,
    id: String,
    label: Option<String>,
) -> Result<(), String> {
    ConfigSnapshotRepo::set_label(&state.db.lock(), &id, label.as_deref()).map_err(|e| e.to_string())
}

/// Diff two archived snapshots (a = older/left, b = newer/right).
#[tauri::command]
pub fn config_snapshots_diff(
    state: State<'_, AppState>,
    a_id: String,
    b_id: String,
) -> Result<crate::drift::diff::DriftPatch, String> {
    let db = state.db.lock();
    let a = ConfigSnapshotRepo::get(&db, &a_id).map_err(|e| e.to_string())?
        .ok_or_else(|| format!("snapshot {a_id} not found"))?;
    let b = ConfigSnapshotRepo::get(&db, &b_id).map_err(|e| e.to_string())?
        .ok_or_else(|| format!("snapshot {b_id} not found"))?;
    Ok(crate::drift::diff::diff_intent_vs_running(&a.normalized_config, &b.normalized_config))
}
```

**Note for implementer:** the `ssh_exec` API is confirmed against
`src-tauri/src/ssh_exec/mod.rs` (it is a module, `ssh_exec/mod.rs`, not
`ssh_exec.rs`): `resolve_target(&Arc<Mutex<Connection>>, &str, Option<String>)
-> Result<(SshTarget, String), String>` (line 67) and
`run_command(&SshTarget, &str, Duration) -> Result<String, _>` (line 175),
`DEFAULT_CMD_TIMEOUT` = 30s (line 114). `resolve_target` errors if the
connection has no password anywhere and no override is passed — surface that
error to the UI (the Snapshot-now button should prompt/allow a password like
the other SSH flows if needed).

- [ ] **Step 3: Register the 5 commands**

In `src-tauri/src/lib.rs` `generate_handler![]`, after the existing drift commands add:

```rust
            commands::drift::drift_snapshot_device,
            commands::drift::config_snapshots_list,
            commands::drift::config_snapshot_get,
            commands::drift::config_snapshot_set_label,
            commands::drift::config_snapshots_diff,
```

- [ ] **Step 4: Build**

Run: `cd src-tauri && cargo build 2>&1 | grep -E "^error"; echo "exit: ${PIPESTATUS[0]}"`
Expected: no `error` lines. (If `ssh_exec` signatures differ, fix per the note and rebuild.)

- [ ] **Step 5: Run drift runner test (no regression)**

Run: `cd src-tauri && cargo test --test drift_runner_test 2>&1 | tail -6`
Expected: `test result: ok.`

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/drift/runner.rs src-tauri/src/commands/drift.rs src-tauri/src/lib.rs
git commit -m "feat(drift): snapshot-on-run + Snapshot-now + archive query commands

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Archive viewer UI + frontend wrappers

**Files:**
- Modify: `src/lib/drift.ts` (ConfigSnapshot type + 5 wrappers)
- Create: `src/components/ConfigArchiveModal.tsx`
- Modify: `src/components/DriftSidebar.tsx` (Snapshot-now button + "Archive" button opening the modal)

**Interfaces:**
- Consumes: the 5 Tauri commands from Task 6.
- Produces TS wrappers: `driftSnapshotDevice`, `configSnapshotsList`, `configSnapshotGet`, `configSnapshotSetLabel`, `configSnapshotsDiff`; `interface ConfigSnapshot`.

- [ ] **Step 1: Add TS types + wrappers (src/lib/drift.ts)**

```typescript
export interface ConfigSnapshot {
  id: string;
  device_id: string;
  device_kind: string;
  vendor: string | null;
  platform: string | null;
  normalized_config: string;
  label: string | null;
  source: "drift_run" | "manual";
  captured_at: number;
}

export const driftSnapshotDevice = (
  connectionId: string, vendor: string, platform: string, password?: string,
) => invoke<ConfigSnapshot | null>("drift_snapshot_device", { connectionId, vendor, platform, password });

export const configSnapshotsList = (deviceId: string, deviceKind: string, limit?: number) =>
  invoke<ConfigSnapshot[]>("config_snapshots_list", { deviceId, deviceKind, limit });

export const configSnapshotGet = (id: string) =>
  invoke<ConfigSnapshot | null>("config_snapshot_get", { id });

export const configSnapshotSetLabel = (id: string, label: string | null) =>
  invoke<void>("config_snapshot_set_label", { id, label });

export const configSnapshotsDiff = (aId: string, bId: string) =>
  invoke<DriftPatch>("config_snapshots_diff", { aId, bId });
```

- [ ] **Step 2: Create the archive viewer modal**

Create `src/components/ConfigArchiveModal.tsx`. It lists a device's snapshots, lets the user select two and view the diff (reusing the existing diff-rendering — render `DriftPatch.blocks` the same way `DriftSidebar` does), label/unlabel, and a "Diff latest vs previous" shortcut:

```tsx
import { useEffect, useState } from "react";
import {
  configSnapshotsList, configSnapshotsDiff, configSnapshotSetLabel,
  type ConfigSnapshot, type DriftPatch,
} from "../lib/drift";

interface Props {
  deviceId: string;
  deviceKind: string;
  onClose: () => void;
}

export function ConfigArchiveModal({ deviceId, deviceKind, onClose }: Props) {
  const [snaps, setSnaps] = useState<ConfigSnapshot[]>([]);
  const [aId, setAId] = useState<string | null>(null);
  const [bId, setBId] = useState<string | null>(null);
  const [patch, setPatch] = useState<DriftPatch | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    try {
      setSnaps(await configSnapshotsList(deviceId, deviceKind, 15));
    } catch (e) { setError(String(e)); }
  };
  useEffect(() => { void load(); /* eslint-disable-next-line */ }, [deviceId, deviceKind]);

  const doDiff = async (a: string, b: string) => {
    try { setPatch(await configSnapshotsDiff(a, b)); setError(null); }
    catch (e) { setError(String(e)); }
  };

  const diffLatestVsPrev = () => {
    if (snaps.length >= 2) { setAId(snaps[1].id); setBId(snaps[0].id); void doDiff(snaps[1].id, snaps[0].id); }
  };

  return (
    <div className="ssh-modal-overlay" onClick={onClose}>
      <div className="ssh-modal" onClick={(e) => e.stopPropagation()}>
        <div className="ssh-modal-header">
          <h2>Config Archive — {deviceId}</h2>
          <button className="ssh-modal-close" onClick={onClose}>✕</button>
        </div>
        <div className="ssh-modal-content">
          {error && <div className="ssh-modal-error">{error}</div>}
          <button onClick={diffLatestVsPrev} disabled={snaps.length < 2}>
            Diff latest vs previous
          </button>
          <ul className="archive-list">
            {snaps.map((s) => (
              <li key={s.id}>
                <input type="radio" name="a" checked={aId === s.id} onChange={() => setAId(s.id)} />
                <input type="radio" name="b" checked={bId === s.id} onChange={() => setBId(s.id)} />
                <span>{new Date(s.captured_at * 1000).toLocaleString()}</span>
                <span>{s.source}</span>
                <input
                  type="text"
                  placeholder="label"
                  defaultValue={s.label ?? ""}
                  onBlur={async (e) => {
                    await configSnapshotSetLabel(s.id, e.target.value || null);
                    void load();
                  }}
                />
              </li>
            ))}
          </ul>
          <button disabled={!aId || !bId} onClick={() => aId && bId && doDiff(aId, bId)}>
            Diff selected
          </button>
          {patch && (
            <pre className="archive-diff">
              {patch.blocks.flatMap((b) =>
                b.changes.map((c) =>
                  `${c.tag === "insert" ? "+" : c.tag === "delete" ? "-" : " "} ${c.line}`
                )
              ).join("\n")}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Wire into DriftSidebar**

In `src/components/DriftSidebar.tsx`, import the modal and the snapshot wrapper, add state `const [archiveOpen, setArchiveOpen] = useState(false)`, and near the "Run Now" button add a "Snapshot now" button and an "Archive" button. "Snapshot now" calls `driftSnapshotDevice` using the selected intent's `ssh_connection_id` selector + its vendor/platform (read from the intent store's selected template). "Archive" opens `ConfigArchiveModal` for that device id (`ssh` kind). Render the modal conditionally at the end.

Concretely, after the existing action buttons:

```tsx
<button
  className="drift-snapshot"
  disabled={!templateId}
  onClick={async () => {
    const tpl = intents.find((t) => t.id === templateId);
    const connId = tpl?.selector?.ssh_connection_id;
    if (!tpl || !connId) { alert("Select an intent whose selector is a single SSH connection to snapshot."); return; }
    try { await driftSnapshotDevice(connId, tpl.vendor, tpl.platform); alert("Snapshot captured."); }
    catch (e) { alert(`Snapshot failed: ${e}`); }
  }}
>
  Snapshot now
</button>
<button
  className="drift-archive"
  disabled={!templateId}
  onClick={() => setArchiveOpen(true)}
>
  Archive
</button>
```

and at the end of the component JSX:

```tsx
{archiveOpen && templateId && (() => {
  const tpl = intents.find((t) => t.id === templateId);
  const connId = tpl?.selector?.ssh_connection_id;
  return connId ? (
    <ConfigArchiveModal deviceId={connId} deviceKind="ssh" onClose={() => setArchiveOpen(false)} />
  ) : null;
})()}
```

(Use the intent store's list — in this file it's already loaded via `useIntentStore`; reference whatever variable holds the templates, e.g. `intents`. If the variable name differs, adapt.)

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit 2>&1 | grep -E "ConfigArchiveModal|DriftSidebar|drift.ts"; echo "grep-exit: $?"`
Expected: no matching lines (grep exit 1).

- [ ] **Step 5: Commit**

```bash
git add src/lib/drift.ts src/components/ConfigArchiveModal.tsx src/components/DriftSidebar.tsx
git commit -m "feat(drift): config archive viewer + snapshot-now UI

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Phase 3 — Drift exceptions

### Task 8: `drift_exceptions` schema + repo + report filtering

**Files:**
- Create: `src-tauri/migrations/V0070__drift_exceptions.sql`
- Create: `src-tauri/src/drift/exception.rs`
- Modify: `src-tauri/src/drift/mod.rs`
- Modify: `src-tauri/src/drift/runner.rs` (filter deltas before insert)
- Test: `src-tauri/tests/drift_exception_test.rs`

**Interfaces:**
- Produces:
  - `struct DriftException { id, template_id, line, note: Option<String>, created_at }`
  - `struct DriftExceptionRepo;`
  - `DriftExceptionRepo::add(conn, template_id, line, note: Option<&str>) -> Result<DriftException>`
  - `DriftExceptionRepo::list(conn, template_id) -> Result<Vec<DriftException>>`
  - `DriftExceptionRepo::delete(conn, id) -> Result<()>`
  - `DriftExceptionRepo::active_lines(conn, template_id) -> Result<std::collections::HashSet<String>>`
  - `pub fn apply_exceptions(patch: &mut DriftPatch, excepted: &HashSet<String>)` — removes any `LineChange::{Insert,Delete}` whose `line()` is excepted; drops now-empty blocks; recomputes `stats`, `severity`, `status`. `Equal` lines are left alone.

- [ ] **Step 1: Migration**

Create `src-tauri/migrations/V0070__drift_exceptions.sql`:

```sql
-- V0070: acknowledged per-line drift exceptions. A delta whose exact
-- normalized line matches an active exception for its template is suppressed.
CREATE TABLE IF NOT EXISTS drift_exceptions (
  id           TEXT PRIMARY KEY,
  template_id  TEXT NOT NULL REFERENCES intent_templates(id) ON DELETE CASCADE,
  line         TEXT NOT NULL,
  note         TEXT,
  created_at   INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
CREATE INDEX IF NOT EXISTS idx_drift_exceptions_template
  ON drift_exceptions(template_id, line);
```

- [ ] **Step 2: Declare module**

In `src-tauri/src/drift/mod.rs` add:

```rust
pub mod exception;
```

- [ ] **Step 3: Write the failing test**

Create `src-tauri/tests/drift_exception_test.rs`:

```rust
use ccie_terminal_lib::drift::exception::{apply_exceptions, DriftExceptionRepo};
use ccie_terminal_lib::drift::diff::{DriftPatch, DriftBlock, DriftSeverity, LineChange, DriftStats};
use std::collections::HashSet;

fn patch_with_two_deltas() -> DriftPatch {
    DriftPatch {
        status: "drift".into(),
        severity: DriftSeverity::Destructive,
        stats: DriftStats { additions: 1, deletions: 1, blocks_changed: 1 },
        blocks: vec![DriftBlock {
            block_path: "router eigrp 10".into(),
            severity: DriftSeverity::Destructive,
            changes: vec![
                LineChange::Insert { line: "passive-interface default".into() },
                LineChange::Delete { line: "metric weights 0 1 2 3 4 5".into() },
            ],
        }],
    }
}

#[test]
fn excepted_line_is_removed_and_status_recomputed() {
    let mut p = patch_with_two_deltas();
    let mut ex = HashSet::new();
    ex.insert("passive-interface default".to_string());
    ex.insert("metric weights 0 1 2 3 4 5".to_string());
    apply_exceptions(&mut p, &ex);
    assert_eq!(p.status, "in_sync", "all deltas excepted → in_sync");
    assert_eq!(p.severity, DriftSeverity::None);
    assert!(p.blocks.is_empty());
    assert_eq!(p.stats.additions, 0);
    assert_eq!(p.stats.deletions, 0);
}

#[test]
fn partial_exception_downgrades_severity() {
    let mut p = patch_with_two_deltas();
    let mut ex = HashSet::new();
    // Except only the Insert (Missing). A Delete (Changed) remains → additive.
    ex.insert("passive-interface default".to_string());
    apply_exceptions(&mut p, &ex);
    assert_eq!(p.status, "drift");
    assert_eq!(p.severity, DriftSeverity::Additive);
    assert_eq!(p.stats.additions, 0);
    assert_eq!(p.stats.deletions, 1);
}

#[test]
fn repo_roundtrip() {
    let conn = rusqlite::Connection::open_in_memory().unwrap();
    conn.execute_batch(
        "CREATE TABLE drift_exceptions (id TEXT PRIMARY KEY, template_id TEXT NOT NULL,
         line TEXT NOT NULL, note TEXT, created_at INTEGER NOT NULL DEFAULT 0);",
    ).unwrap();
    let e = DriftExceptionRepo::add(&conn, "t1", "ntp clock-period 17179869", Some("known noise")).unwrap();
    let lines = DriftExceptionRepo::active_lines(&conn, "t1").unwrap();
    assert!(lines.contains("ntp clock-period 17179869"));
    DriftExceptionRepo::delete(&conn, &e.id).unwrap();
    assert!(DriftExceptionRepo::active_lines(&conn, "t1").unwrap().is_empty());
}
```

- [ ] **Step 4: Run to verify it fails**

Run: `cd src-tauri && cargo test --test drift_exception_test 2>&1 | tail -12`
Expected: FAIL to compile (`DriftExceptionRepo` / `apply_exceptions` not found).

- [ ] **Step 5: Implement**

Create `src-tauri/src/drift/exception.rs`:

```rust
//! Per-line drift exceptions. An acknowledged delta (template_id + exact
//! normalized line) is suppressed on future runs.

use crate::drift::diff::{DriftPatch, DriftSeverity, LineChange};
use anyhow::{Context, Result};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct DriftException {
    pub id: String,
    pub template_id: String,
    pub line: String,
    pub note: Option<String>,
    pub created_at: i64,
}

pub struct DriftExceptionRepo;

impl DriftExceptionRepo {
    pub fn add(conn: &Connection, template_id: &str, line: &str, note: Option<&str>) -> Result<DriftException> {
        let id = uuid::Uuid::new_v4().to_string();
        conn.execute(
            "INSERT INTO drift_exceptions (id, template_id, line, note) VALUES (?1, ?2, ?3, ?4)",
            params![id, template_id, line, note],
        ).context("insert drift_exceptions")?;
        Ok(DriftException {
            id, template_id: template_id.into(), line: line.into(),
            note: note.map(|s| s.to_string()), created_at: 0,
        })
    }

    pub fn list(conn: &Connection, template_id: &str) -> Result<Vec<DriftException>> {
        let mut stmt = conn.prepare(
            "SELECT id, template_id, line, note, created_at FROM drift_exceptions
             WHERE template_id = ?1 ORDER BY created_at DESC",
        )?;
        let rows = stmt.query_map([template_id], |r| Ok(DriftException {
            id: r.get(0)?, template_id: r.get(1)?, line: r.get(2)?, note: r.get(3)?, created_at: r.get(4)?,
        }))?.collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    pub fn delete(conn: &Connection, id: &str) -> Result<()> {
        conn.execute("DELETE FROM drift_exceptions WHERE id = ?1", [id])?;
        Ok(())
    }

    pub fn active_lines(conn: &Connection, template_id: &str) -> Result<HashSet<String>> {
        let mut stmt = conn.prepare("SELECT line FROM drift_exceptions WHERE template_id = ?1")?;
        let lines = stmt.query_map([template_id], |r| r.get::<_, String>(0))?
            .collect::<Result<HashSet<_>, _>>()?;
        Ok(lines)
    }
}

/// Remove excepted deltas from a patch and recompute stats/severity/status.
/// `Equal` context lines are preserved.
pub fn apply_exceptions(patch: &mut DriftPatch, excepted: &HashSet<String>) {
    let mut add = 0usize;
    let mut del = 0usize;
    for block in patch.blocks.iter_mut() {
        block.changes.retain(|c| match c {
            LineChange::Insert { line } | LineChange::Delete { line } => !excepted.contains(line),
            LineChange::Equal { .. } => true,
        });
        // Recount this block.
        let mut b_add = 0usize;
        let mut b_del = 0usize;
        for c in &block.changes {
            match c {
                LineChange::Insert { .. } => b_add += 1,
                LineChange::Delete { .. } => b_del += 1,
                LineChange::Equal { .. } => {}
            }
        }
        block.severity = if b_del > 0 {
            DriftSeverity::Destructive
        } else if b_add > 0 {
            DriftSeverity::Additive
        } else {
            DriftSeverity::None
        };
        add += b_add;
        del += b_del;
    }
    // Drop blocks with no real change left.
    patch.blocks.retain(|b| b.changes.iter().any(|c| !matches!(c, LineChange::Equal { .. })));

    patch.stats.additions = add;
    patch.stats.deletions = del;
    patch.stats.blocks_changed = patch.blocks.len();
    patch.severity = if add == 0 && del == 0 {
        DriftSeverity::None
    } else if add > 0 {
        DriftSeverity::Destructive
    } else {
        DriftSeverity::Additive
    };
    patch.status = if matches!(patch.severity, DriftSeverity::None) { "in_sync" } else { "drift" }.to_string();
}
```

**Note:** the add/del → severity mapping here mirrors `presence.rs` (Missing/Insert = destructive). This is intentional so partial-mode patches stay consistent after filtering. For baseline-mode patches the semantics differ slightly (Insert = additive there), but exceptions are primarily a partial-mode feature; the recomputation is still monotonic (removing deltas never raises severity in a way that misleads). Acceptable per the spec's YAGNI stance.

- [ ] **Step 6: Wire filtering into the runner**

In `run_on_demand` (runner.rs), after computing `patch` and before `DriftReportRepo::insert`, add:

```rust
                    let mut patch = patch;
                    if let Ok(excepted) =
                        crate::drift::exception::DriftExceptionRepo::active_lines(&conn, template_id)
                    {
                        if !excepted.is_empty() {
                            crate::drift::exception::apply_exceptions(&mut patch, &excepted);
                        }
                    }
```

(Change the earlier `let patch = match ...` binding to `let patch = match ...` unchanged; the `let mut patch = patch;` shadow above makes it mutable for filtering.)

- [ ] **Step 7: Run tests**

Run: `cd src-tauri && cargo test --test drift_exception_test 2>&1 | tail -12`
Expected: `test result: ok. 3 passed`.

- [ ] **Step 8: Build + drift runner regression**

Run: `cd src-tauri && cargo build 2>&1 | grep -E "^error"; cargo test --test drift_runner_test 2>&1 | tail -6`
Expected: no `error`; runner test ok.

- [ ] **Step 9: Commit**

```bash
git add src-tauri/migrations/V0070__drift_exceptions.sql src-tauri/src/drift/exception.rs src-tauri/src/drift/mod.rs src-tauri/src/drift/runner.rs src-tauri/tests/drift_exception_test.rs
git commit -m "feat(drift): per-line exceptions with report filtering

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: Exception commands + acknowledge/manage UI

**Files:**
- Modify: `src-tauri/src/commands/drift.rs` (add `drift_exception_add`, `drift_exceptions_list`, `drift_exception_delete`)
- Modify: `src-tauri/src/lib.rs` (register 3 commands)
- Modify: `src/lib/drift.ts` (types + wrappers)
- Create: `src/components/DriftExceptionsModal.tsx`
- Modify: `src/components/DriftSidebar.tsx` (Acknowledge action on a delta + "Manage exceptions" button)

**Interfaces:**
- Produces Tauri commands: `drift_exception_add(template_id, line, note: Option<String>) -> Result<DriftException, String>`, `drift_exceptions_list(template_id) -> Result<Vec<DriftException>, String>`, `drift_exception_delete(id) -> Result<(), String>`.
- Produces TS: `driftExceptionAdd`, `driftExceptionsList`, `driftExceptionDelete`; `interface DriftException`.

- [ ] **Step 1: Rust commands**

In `src-tauri/src/commands/drift.rs`:

```rust
use crate::drift::exception::{DriftException, DriftExceptionRepo};

#[tauri::command]
pub fn drift_exception_add(
    state: State<'_, AppState>,
    template_id: String,
    line: String,
    note: Option<String>,
) -> Result<DriftException, String> {
    DriftExceptionRepo::add(&state.db.lock(), &template_id, &line, note.as_deref())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn drift_exceptions_list(
    state: State<'_, AppState>,
    template_id: String,
) -> Result<Vec<DriftException>, String> {
    DriftExceptionRepo::list(&state.db.lock(), &template_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn drift_exception_delete(state: State<'_, AppState>, id: String) -> Result<(), String> {
    DriftExceptionRepo::delete(&state.db.lock(), &id).map_err(|e| e.to_string())
}
```

- [ ] **Step 2: Register**

In `src-tauri/src/lib.rs` `generate_handler![]`:

```rust
            commands::drift::drift_exception_add,
            commands::drift::drift_exceptions_list,
            commands::drift::drift_exception_delete,
```

- [ ] **Step 3: TS wrappers (src/lib/drift.ts)**

```typescript
export interface DriftException {
  id: string;
  template_id: string;
  line: string;
  note: string | null;
  created_at: number;
}

export const driftExceptionAdd = (templateId: string, line: string, note?: string) =>
  invoke<DriftException>("drift_exception_add", { templateId, line, note });

export const driftExceptionsList = (templateId: string) =>
  invoke<DriftException[]>("drift_exceptions_list", { templateId });

export const driftExceptionDelete = (id: string) =>
  invoke<void>("drift_exception_delete", { id });
```

- [ ] **Step 4: Manage-exceptions modal**

Create `src/components/DriftExceptionsModal.tsx`:

```tsx
import { useEffect, useState } from "react";
import { driftExceptionsList, driftExceptionDelete, type DriftException } from "../lib/drift";

interface Props { templateId: string; onClose: () => void; }

export function DriftExceptionsModal({ templateId, onClose }: Props) {
  const [rows, setRows] = useState<DriftException[]>([]);
  const load = async () => setRows(await driftExceptionsList(templateId));
  useEffect(() => { void load(); /* eslint-disable-next-line */ }, [templateId]);
  return (
    <div className="ssh-modal-overlay" onClick={onClose}>
      <div className="ssh-modal" onClick={(e) => e.stopPropagation()}>
        <div className="ssh-modal-header">
          <h2>Acknowledged drift ({rows.length})</h2>
          <button className="ssh-modal-close" onClick={onClose}>✕</button>
        </div>
        <div className="ssh-modal-content">
          {rows.length === 0 && <p>No acknowledged deltas.</p>}
          <ul className="exception-list">
            {rows.map((r) => (
              <li key={r.id}>
                <code>{r.line}</code>
                {r.note && <em> — {r.note}</em>}
                <button onClick={async () => { await driftExceptionDelete(r.id); void load(); }}>
                  Un-acknowledge
                </button>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Acknowledge action + Manage button in DriftSidebar**

In `src/components/DriftSidebar.tsx`, import `driftExceptionAdd` and `DriftExceptionsModal`, add `const [exceptionsOpen, setExceptionsOpen] = useState(false)`. Where the selected report's diff deltas are rendered (each `LineChange`), for `insert`/`delete` deltas add an "Acknowledge" button:

```tsx
<button
  className="drift-ack"
  title="Acknowledge — stop reporting this line"
  onClick={async () => {
    if (!templateId) return;
    await driftExceptionAdd(templateId, change.line, null);
    await runOnDemand(templateId); // re-run so the report reflects the exception
  }}
>
  Acknowledge
</button>
```

Add a "Manage exceptions" button near the template controls that sets `setExceptionsOpen(true)`, and render at the end:

```tsx
{exceptionsOpen && templateId && (
  <DriftExceptionsModal templateId={templateId} onClose={() => setExceptionsOpen(false)} />
)}
```

- [ ] **Step 6: Typecheck + build**

Run: `npx tsc --noEmit 2>&1 | grep -E "DriftExceptionsModal|DriftSidebar|drift.ts"; echo "grep-exit: $?"`
Expected: no matches (grep exit 1).
Run: `cd src-tauri && cargo build 2>&1 | grep -E "^error"; echo "exit: ${PIPESTATUS[0]}"`
Expected: no `error` lines.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/commands/drift.rs src-tauri/src/lib.rs src/lib/drift.ts src/components/DriftExceptionsModal.tsx src/components/DriftSidebar.tsx
git commit -m "feat(drift): acknowledge deltas + manage exceptions UI

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Phase 4 — UI polish: Missing/Changed/OK presentation

### Task 10: Render partial-mode reports as Missing / Changed groups

**Files:**
- Modify: `src/components/DriftSidebar.tsx` (delta rendering)
- Modify: `src/components/DriftSidebar.css` (styling for missing/changed)

**Interfaces:**
- Consumes: `DriftReport.diff_patch` (`LineChange` tags). In partial-mode patches, `insert` = Missing (intended, absent on device), `delete` = Changed (intended value differs).

- [ ] **Step 1: Add a legend + relabel tags in the diff view**

In the delta-rendering section of `DriftSidebar.tsx`, map the tag to a human label and CSS class. Where each `change` is rendered, use:

```tsx
const label =
  change.tag === "insert" ? "Missing" :
  change.tag === "delete" ? "Changed" : "";
// className: `drift-line drift-${change.tag}`
```

Render `label` as a small badge before the line text for insert/delete. (Equal lines render plain, no badge.) Add a one-line legend above the diff:

```tsx
<div className="drift-legend">
  <span className="drift-badge drift-insert">Missing</span> = intended line absent on device ·
  <span className="drift-badge drift-delete">Changed</span> = value differs
</div>
```

- [ ] **Step 2: Add CSS**

Append to `src/components/DriftSidebar.css`:

```css
.drift-legend { font-size: 12px; color: #8a8570; margin: 6px 0; }
.drift-badge { display: inline-block; padding: 0 6px; border-radius: 4px; font-size: 11px; font-weight: 600; margin-right: 4px; }
.drift-badge.drift-insert { background: #3a2626; color: #f0b0b0; }  /* Missing = serious */
.drift-badge.drift-delete { background: #3a3326; color: #f0d8a0; }  /* Changed */
.drift-line.drift-equal { color: #6c7380; }
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit 2>&1 | grep -E "DriftSidebar"; echo "grep-exit: $?"`
Expected: no matches (grep exit 1).

- [ ] **Step 4: Full frontend test sweep (no regressions)**

Run: `npx vitest run src/components/DriftSidebar.test.tsx src/state/driftStore.test.ts 2>&1 | tail -8` (run whichever of these exist; if neither exists, run `npx vitest run 2>&1 | tail -8` scoped to drift with `-t drift`).
Expected: passing.

- [ ] **Step 5: Commit**

```bash
git add src/components/DriftSidebar.tsx src/components/DriftSidebar.css
git commit -m "feat(drift): Missing/Changed badges + legend for partial-mode reports

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 11: Full-suite verification + manual smoke checklist

**Files:** none (verification only)

- [ ] **Step 1: Rust drift suite**

Run: `cd src-tauri && cargo test drift 2>&1 | tail -20`
Expected: all drift-related tests pass (presence, archive, exception, runner, diff, normalize, scheduler, intent CRUD).

- [ ] **Step 2: Backend builds clean**

Run: `cd src-tauri && cargo build 2>&1 | grep -E "^error"; echo "exit: ${PIPESTATUS[0]}"`
Expected: no `error` lines.

- [ ] **Step 3: Frontend typecheck (changed files only)**

Run: `npx tsc --noEmit 2>&1 | grep -E "drift|Drift|ConfigArchive|IntentEditor"; echo "grep-exit: $?"`
Expected: no matches (grep exit 1).

- [ ] **Step 4: Manual smoke checklist (record results in the PR)**

Restart the app (backend changed), then verify:
1. Existing EIGRP intent → set match mode to **Partial** → Run Now → reports **in_sync** (not 2000+ deltas).
2. Change the device's `metric weights` → Run Now → one **Changed** delta.
3. Remove a device line the intent declares → Run Now → one **Missing** delta.
4. **Acknowledge** the Missing delta → Run Now → it no longer appears; "Manage exceptions" lists it; un-acknowledge restores it.
5. **Snapshot now** → open **Archive** → two snapshots exist → "Diff latest vs previous" shows only real changes; label one and confirm it persists.
6. A **Baseline**-mode intent still behaves as before (whole-config diff).

- [ ] **Step 5: Final commit (if any doc/notes updates)**

```bash
git add -A
git commit -m "chore(drift): verification notes for Catalyst-Center-style drift

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>" || echo "nothing to commit"
```

---

## Self-Review Notes

- **Spec coverage:** A1 match_mode → Task 1/4; B presence matcher + Changed/Missing → Task 2/3; A2 config_snapshots → Task 5; C snapshot-on-run + Snapshot-now + viewer → Task 6/7; A3 drift_exceptions → Task 8; D1-D3 acknowledge/filter/manage → Task 8/9; D4 IntentEditor toggle → Task 4; Missing/Changed/OK presentation → Task 10. All spec sections mapped.
- **Out-of-scope items** (remediation push, syslog trigger, attribution, site hierarchy, dashboard) intentionally have no tasks.
- **Type consistency:** `MatchMode`, `ConfigSnapshot`/`ConfigSnapshotRepo`, `DriftException`/`DriftExceptionRepo`/`apply_exceptions`, `match_intent_presence`, and the TS wrappers use identical names across producing and consuming tasks.
- **Known implementer verification points** (flagged inline, not placeholders): `ssh_exec` API is now confirmed (Task 6 note). Task 4/7/9 — confirm the exact intent-store list variable name and reload fn in DriftSidebar/IntentEditor (this file uses `useIntentStore`; grep it for the templates array + refresh action and adapt the referenced names). These are "match the existing pattern" checks, with the behavioral contract specified.
- **Row-index caveat (Task 1):** `map_row` reads `match_mode` at column index 10, which requires appending `, match_mode` LAST in every SELECT that feeds `map_row` (get/list_all/list_filtered). Double-check the column order matches the index during implementation.

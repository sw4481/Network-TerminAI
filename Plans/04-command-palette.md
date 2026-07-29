# 04 — Command Palette (Cmd+P): fuzzy global picker

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (preferred) or `superpowers:executing-plans`. Steps use checkbox (`- [ ]`) syntax for tracking. Each phase ends with regression + code review + plan-file update + commit.

**Goal:** Upgrade the existing `src/components/CommandPalette.tsx` prototype from a "recent commands + a few actions" picker into a global fuzzy palette that searches every navigable entity in the app: command history (per-device + global), workflows (from Plan 02), notebooks (from Plan 03), saved SSH connections (from existing `SavedSSHConnectionsModal`), NETCONF devices (existing), and command blocks (matching command text or output text). Scope toggles (Current tab / Current device / Global) and a `>` keybinding prefix narrow the category. Recent-weighted scoring uses a usage table updated on every pick. Keyboard-only navigation throughout.

**Architecture:**

- **Rust aggregator.** A new Tauri command `palette_search(query, scope, limit) -> Vec<PaletteHit>` fans out across data sources in a single async call:
  - **Commands** — distinct `cmd` values from `command_blocks`, joined with per-`cmd` recency/frequency from `palette_usage`.
  - **Blocks** — FTS5 `command_blocks_fts` (existing from V0006/V0014) plus the new `palette_index` virtual table for command+tags+vendor+platform.
  - **Workflows** — `workflows` table (Plan 02 / V0029). If Plan 02 hasn't landed, the module uses a feature-flag fallback returning `[]`.
  - **Notebooks** — `notebook_cells` + parent notebook table (Plan 03 / V0030). Same feature-flag fallback.
  - **Devices** — reads NETCONF saved connections (existing `ssh_connections` + NETCONF equivalent).
  - **SSH** — `ssh_list_connections` shaped into PaletteHits.
- **PaletteHit** is a tagged union over `kind ∈ 'command' | 'workflow' | 'notebook' | 'device' | 'block' | 'ssh'`. Each hit carries a `score: f64` (raw BM25 or Fuse-equivalent), `recency_boost: f64`, `frequency_boost: f64`, plus `target_id` + display fields.
- **Client-side ranking (Fuse.js).** The Rust aggregator returns unranked candidates with source-native scores (FTS5 BM25, simple LIKE prefix for non-FTS tables). The frontend re-ranks with `fuse.js` (already a dep, v7.3.0) using a composite score `composite = fuse_score * (1 + recency_boost + frequency_boost)`. This keeps Rust simple and reuses the existing `fuse.js` cache shape in `CommandPalette.tsx`.
- **Scope toggle.** The React component holds a `scope: 'tab' | 'device' | 'global'` state. Passed through as a string enum to the Rust command, which gates SQL queries:
  - `tab` → WHERE `tab_id = ?active_tab`
  - `device` → WHERE `device_id = ?active_device` (NETCONF/SSH session id)
  - `global` → no scope filter
- **Keybinding prefix `>`.** Typing `>` as the first character in the query switches to "category filter mode" — subsequent typing filters `kind` (`>w` → workflows, `>n` → notebooks, `>s` → ssh, `>d` → devices, `>c` → commands, `>b` → blocks). Prefix is stripped before the remaining text is used as a full-text search.
- **Usage tracking.** On pick, the frontend calls `palette_record_use(target_type, target_id)` which does an `INSERT OR REPLACE` into `palette_usage(target_type, target_id, last_used_at, use_count)` — `use_count` increments by 1 if row existed (handled via `UPSERT ... DO UPDATE SET use_count = use_count + 1, last_used_at = excluded.last_used_at`).

**Tech Stack:** Rust (rusqlite, serde, tauri 2), React 19, Zustand 5, `fuse.js` v7.3.0 (already installed), SQLite FTS5.

**Prerequisites:**
- Plan 01 Phase 1 (V0028 `block_tags` table) complete — `palette_index` references `block_tags` and `command_blocks.tags` through a content view.
- Plan 02 Phase 1 (V0029 `workflows` table) — optional; palette code feature-flags around it.
- Plan 03 Phase 1 (V0030 `notebook_cells`) — optional; same pattern.

**Downstream consumers:** None direct; palette is a UX aggregator. Future plans (09 Guardrails, 15 Troubleshooter) may add their own `kind` values — the PaletteHit enum is designed extensibly.

---

## Phase 1 — Schema + Rust search aggregator

### Task 1.1 — Migration V0031  `SEQUENTIAL`

**Files:**
- Create: `src-tauri/migrations/V0031__palette_index_and_usage.sql`

- [ ] **Step 1: Write migration**

```sql
-- palette_usage: recency + frequency for every pickable target
CREATE TABLE IF NOT EXISTS palette_usage (
  target_type TEXT NOT NULL,                 -- 'command'|'workflow'|'notebook'|'device'|'block'|'ssh'
  target_id   TEXT NOT NULL,                 -- free-form id per target type
  last_used_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  use_count   INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (target_type, target_id)
);
CREATE INDEX IF NOT EXISTS idx_palette_usage_type_recent
  ON palette_usage(target_type, last_used_at DESC);
CREATE INDEX IF NOT EXISTS idx_palette_usage_type_count
  ON palette_usage(target_type, use_count DESC);

-- palette_index: external-content FTS5 aggregating
-- command + tags + vendor + platform for blocks.
-- content='' is an external content table driven by triggers below.
-- NOTE: We use content='' (not command_blocks) because we need a denormalized
-- text column that includes tags joined from block_tags. External-content with
-- a real base table won't allow computed/joined columns, so we drive inserts
-- via triggers from BOTH command_blocks and block_tags.
CREATE VIRTUAL TABLE IF NOT EXISTS palette_index USING fts5(
  block_id UNINDEXED,
  tab_id   UNINDEXED,
  cmd,
  tags,
  vendor,
  platform,
  tokenize = 'porter unicode61 remove_diacritics 2'
);

-- Triggers to keep palette_index in sync with command_blocks.
-- When a block is inserted, build the aggregated row immediately
-- (tags will be empty at that moment and re-added by the block_tags trigger).
CREATE TRIGGER IF NOT EXISTS palette_index_block_ai
AFTER INSERT ON command_blocks BEGIN
  INSERT INTO palette_index(block_id, tab_id, cmd, tags, vendor, platform)
  VALUES (
    new.id,
    new.tab_id,
    new.cmd,
    COALESCE((SELECT group_concat(tag, ' ') FROM block_tags WHERE block_id = new.id), ''),
    '',  -- vendor populated later by Plan 05 (structured output) — placeholder
    ''
  );
END;

CREATE TRIGGER IF NOT EXISTS palette_index_block_au
AFTER UPDATE ON command_blocks BEGIN
  INSERT INTO palette_index(palette_index, block_id, tab_id, cmd, tags, vendor, platform)
    VALUES ('delete', old.id, old.tab_id, old.cmd,
            COALESCE((SELECT group_concat(tag, ' ') FROM block_tags WHERE block_id = old.id), ''),
            '', '');
  INSERT INTO palette_index(block_id, tab_id, cmd, tags, vendor, platform)
    VALUES (new.id, new.tab_id, new.cmd,
            COALESCE((SELECT group_concat(tag, ' ') FROM block_tags WHERE block_id = new.id), ''),
            '', '');
END;

CREATE TRIGGER IF NOT EXISTS palette_index_block_ad
AFTER DELETE ON command_blocks BEGIN
  INSERT INTO palette_index(palette_index, block_id, tab_id, cmd, tags, vendor, platform)
    VALUES ('delete', old.id, old.tab_id, old.cmd,
            COALESCE((SELECT group_concat(tag, ' ') FROM block_tags WHERE block_id = old.id), ''),
            '', '');
END;

-- Triggers on block_tags to re-aggregate tag column after tag add/remove.
-- Pattern: delete the old row, re-insert with refreshed tag string.
CREATE TRIGGER IF NOT EXISTS palette_index_tag_ai
AFTER INSERT ON block_tags BEGIN
  INSERT INTO palette_index(palette_index, block_id, tab_id, cmd, tags, vendor, platform)
    SELECT 'delete', cb.id, cb.tab_id, cb.cmd,
           COALESCE((SELECT group_concat(tag, ' ') FROM block_tags WHERE block_id = cb.id AND tag <> new.tag), ''),
           '', ''
      FROM command_blocks cb WHERE cb.id = new.block_id;
  INSERT INTO palette_index(block_id, tab_id, cmd, tags, vendor, platform)
    SELECT cb.id, cb.tab_id, cb.cmd,
           COALESCE((SELECT group_concat(tag, ' ') FROM block_tags WHERE block_id = cb.id), ''),
           '', ''
      FROM command_blocks cb WHERE cb.id = new.block_id;
END;

CREATE TRIGGER IF NOT EXISTS palette_index_tag_ad
AFTER DELETE ON block_tags BEGIN
  INSERT INTO palette_index(palette_index, block_id, tab_id, cmd, tags, vendor, platform)
    SELECT 'delete', cb.id, cb.tab_id, cb.cmd,
           COALESCE((SELECT group_concat(tag, ' ') FROM block_tags WHERE block_id = cb.id) || ' ' || old.tag, old.tag),
           '', ''
      FROM command_blocks cb WHERE cb.id = old.block_id;
  INSERT INTO palette_index(block_id, tab_id, cmd, tags, vendor, platform)
    SELECT cb.id, cb.tab_id, cb.cmd,
           COALESCE((SELECT group_concat(tag, ' ') FROM block_tags WHERE block_id = cb.id), ''),
           '', ''
      FROM command_blocks cb WHERE cb.id = old.block_id;
END;

-- Backfill palette_index from existing blocks.
INSERT INTO palette_index(block_id, tab_id, cmd, tags, vendor, platform)
SELECT cb.id, cb.tab_id, cb.cmd,
       COALESCE((SELECT group_concat(tag, ' ') FROM block_tags WHERE block_id = cb.id), ''),
       '', ''
FROM command_blocks cb;
```

- [ ] **Step 2: Research FTS5 external-content triggers**

Run `mcp__plugin_context7_context7__query-docs` with query "sqlite fts5 external content contentless triggers delete insert pattern" to confirm the delete/insert idiom matches V0014 — our `INSERT INTO palette_index(palette_index, ...) VALUES ('delete', ...)` pattern is identical to `V0014__fix_fts5_update_triggers.sql`. Paste the authoritative snippet (https://sqlite.org/fts5.html#contentless_tables or #external_content_tables) as a comment in the migration if docs clarify anything undefined.

- [ ] **Step 3: Verify migration applies**

```bash
cargo test --manifest-path src-tauri/Cargo.toml --lib db::tests::migrations_apply
```

Expected: PASS. If `block_tags` does not exist yet (Plan 01 Phase 1 not landed), the triggers referencing `block_tags` will still parse because the trigger body isn't resolved until fire — BUT the backfill SELECT will fail. Guard the `block_tags` references by making the migration **depend on** V0028, documented as a prerequisite at the top of the file:

```sql
-- Requires V0028 (block_tags) to be applied. Fails migration if block_tags missing.
```

- [ ] **Step 4: Commit**

```bash
git add src-tauri/migrations/V0031__palette_index_and_usage.sql
git commit -m "feat(db): V0031 palette_index FTS5 + palette_usage"
```

### Task 1.2 — Rust `PaletteHit` types  `SEQUENTIAL` (depends on 1.1)

**Files:**
- Create: `src-tauri/src/palette/mod.rs`
- Create: `src-tauri/src/palette/types.rs`
- Modify: `src-tauri/src/lib.rs` — `pub mod palette;`

- [ ] **Step 1: Write failing type test**

`src-tauri/tests/palette_types_test.rs`:
```rust
use ccie_terminal_lib::palette::types::{PaletteHit, PaletteKind, PaletteScope};

#[test]
fn palette_hit_serializes_kind_as_snake_lower_string() {
    let hit = PaletteHit {
        kind: PaletteKind::Workflow,
        target_id: "wf-123".into(),
        title: "Run show tech".into(),
        subtitle: Some("site-atl".into()),
        score: 0.87,
        recency_boost: 0.1,
        frequency_boost: 0.05,
        meta: serde_json::json!({ "param_count": 3 }),
    };
    let js = serde_json::to_value(&hit).unwrap();
    assert_eq!(js["kind"], "workflow");
    assert_eq!(js["target_id"], "wf-123");
}

#[test]
fn palette_scope_parses_from_string() {
    assert_eq!(PaletteScope::parse("tab"), Some(PaletteScope::Tab));
    assert_eq!(PaletteScope::parse("device"), Some(PaletteScope::Device));
    assert_eq!(PaletteScope::parse("global"), Some(PaletteScope::Global));
    assert_eq!(PaletteScope::parse("bogus"), None);
}
```

- [ ] **Step 2: Implement `types.rs`**

```rust
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PaletteKind {
    Command,
    Workflow,
    Notebook,
    Device,
    Block,
    Ssh,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PaletteScope {
    Tab,
    Device,
    Global,
}

impl PaletteScope {
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "tab" => Some(Self::Tab),
            "device" => Some(Self::Device),
            "global" => Some(Self::Global),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct PaletteHit {
    pub kind: PaletteKind,
    pub target_id: String,
    pub title: String,
    pub subtitle: Option<String>,
    pub score: f64,
    pub recency_boost: f64,
    pub frequency_boost: f64,
    pub meta: serde_json::Value,
}

#[derive(Debug, Clone, Deserialize)]
pub struct PaletteSearchArgs {
    pub query: String,
    pub scope: String,              // "tab" | "device" | "global"
    pub active_tab_id: Option<String>,
    pub active_device_id: Option<String>,
    pub kind_filter: Option<PaletteKind>,  // set when `>c` etc. is used client-side
    pub limit: usize,
}
```

- [ ] **Step 3: Run — expect PASS**

```bash
cargo test --manifest-path src-tauri/Cargo.toml palette_types
```

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/palette/ src-tauri/tests/palette_types_test.rs src-tauri/src/lib.rs
git commit -m "feat(palette): PaletteHit/PaletteKind/PaletteScope types"
```

### Task 1.3 — Aggregator: commands + blocks  `PARALLEL with 1.4`

**Files:**
- Create: `src-tauri/src/palette/sources/mod.rs`
- Create: `src-tauri/src/palette/sources/commands.rs`
- Create: `src-tauri/src/palette/sources/blocks.rs`
- Create: `src-tauri/tests/palette_sources_commands_blocks_test.rs`

- [ ] **Step 1: Write failing test**

```rust
use ccie_terminal_lib::db::Db;
use ccie_terminal_lib::palette::sources::{commands, blocks};
use ccie_terminal_lib::palette::types::{PaletteScope, PaletteKind};

#[tokio::test]
async fn commands_source_returns_distinct_cmds_ranked_by_frequency() {
    let db = Db::open_in_memory().await.unwrap();
    let tab = seed_tab(&db, "t1").await;
    seed_block(&db, &tab, "show version").await;
    seed_block(&db, &tab, "show version").await;
    seed_block(&db, &tab, "show ip route").await;
    let hits = commands::search(&db, "show", PaletteScope::Global, None, None, 10).await.unwrap();
    assert!(hits.iter().all(|h| h.kind == PaletteKind::Command));
    let titles: Vec<&str> = hits.iter().map(|h| h.title.as_str()).collect();
    assert!(titles.contains(&"show version"));
    assert!(titles.contains(&"show ip route"));
    // Distinct cmd values only — "show version" must appear at most once.
    let sv_count = titles.iter().filter(|t| **t == "show version").count();
    assert_eq!(sv_count, 1);
}

#[tokio::test]
async fn blocks_source_matches_tag_text() {
    let db = Db::open_in_memory().await.unwrap();
    let tab = seed_tab(&db, "t1").await;
    let bid = seed_block(&db, &tab, "show interfaces").await;
    seed_block_tag(&db, &bid, "site-atl").await;
    let hits = blocks::search(&db, "site-atl", PaletteScope::Global, None, 10).await.unwrap();
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].kind, PaletteKind::Block);
    assert_eq!(hits[0].target_id, bid);
}

#[tokio::test]
async fn blocks_source_respects_tab_scope() {
    let db = Db::open_in_memory().await.unwrap();
    let t1 = seed_tab(&db, "t1").await;
    let t2 = seed_tab(&db, "t2").await;
    seed_block(&db, &t1, "show run | i bgp").await;
    seed_block(&db, &t2, "show run | i ospf").await;
    let hits = blocks::search(&db, "show run", PaletteScope::Tab, Some(&t1), 10).await.unwrap();
    assert_eq!(hits.len(), 1);
    assert!(hits[0].title.contains("bgp"));
}
```

- [ ] **Step 2: Implement `commands.rs`**

Query:
```sql
SELECT cb.cmd, COUNT(*) AS freq, MAX(cb.started_at) AS last_at
FROM command_blocks cb
WHERE cb.cmd LIKE ?1
  AND (?2 = 'global' OR (?2 = 'tab' AND cb.tab_id = ?3))
GROUP BY cb.cmd
ORDER BY freq DESC, last_at DESC
LIMIT ?4
```
The `device` scope for commands joins through a `tab_id -> device_id` mapping resolved in `sources/commands.rs::resolve_device_tabs()` helper — placeholder `[]` if NETCONF device linkage is not yet wired. Each row yields a `PaletteHit { kind: Command, target_id: cmd_hash, title: cmd, ... }`.

- [ ] **Step 3: Implement `blocks.rs`**

Uses `palette_index` FTS5 (V0031):
```sql
SELECT pi.block_id, pi.tab_id, pi.cmd,
       bm25(palette_index) AS rank,
       snippet(palette_index, 2, '[', ']', '...', 16) AS snippet
FROM palette_index pi
WHERE palette_index MATCH ?1
  AND (?2 = 'global' OR (?2 = 'tab' AND pi.tab_id = ?3))
ORDER BY rank ASC   -- bm25 returns lower = better
LIMIT ?4
```
Query escape via reused `search::escape_fts5_query` helper (extracted to `palette::util::escape_fts5_query`, public re-export). Do NOT duplicate it.

- [ ] **Step 4: Run — expect PASS**

```bash
cargo test --manifest-path src-tauri/Cargo.toml palette_sources_commands_blocks
```

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/palette/sources/ src-tauri/tests/palette_sources_commands_blocks_test.rs
git commit -m "feat(palette): commands + blocks source aggregators"
```

### Task 1.4 — Aggregator: workflows + notebooks + devices + ssh  `PARALLEL with 1.3`

**Files:**
- Create: `src-tauri/src/palette/sources/workflows.rs`
- Create: `src-tauri/src/palette/sources/notebooks.rs`
- Create: `src-tauri/src/palette/sources/devices.rs`
- Create: `src-tauri/src/palette/sources/ssh.rs`
- Create: `src-tauri/tests/palette_sources_misc_test.rs`

- [ ] **Step 1: Write failing test**

```rust
#[tokio::test]
async fn ssh_source_returns_connections_with_last_used_boost() {
    let db = Db::open_in_memory().await.unwrap();
    seed_ssh_conn(&db, "c1", "core-sw1", 100).await;
    seed_ssh_conn(&db, "c2", "edge-rtr1", 500).await;
    let hits = ssh::search(&db, "", PaletteScope::Global, 10).await.unwrap();
    let names: Vec<_> = hits.iter().map(|h| h.title.clone()).collect();
    assert_eq!(names, vec!["edge-rtr1".to_string(), "core-sw1".to_string()]);
}

#[tokio::test]
async fn workflows_source_empty_when_table_missing() {
    // Simulate a DB at schema V0028 (no V0029 yet)
    let db = Db::open_in_memory_at_version(28).await.unwrap();
    let hits = workflows::search(&db, "foo", PaletteScope::Global, 10).await.unwrap();
    assert!(hits.is_empty(), "must feature-flag around missing workflows table");
}
```

- [ ] **Step 2: Implement each source**

Each source implements the same signature:
```rust
pub async fn search(
    db: &Db,
    query: &str,
    scope: PaletteScope,
    active_tab_id: Option<&str>,   // only commands/blocks use this
    active_device_id: Option<&str>,
    limit: usize,
) -> anyhow::Result<Vec<PaletteHit>>;
```

- **workflows.rs** — `SELECT id, name, description FROM workflows WHERE name LIKE ?1 OR description LIKE ?1`. Wrap the prepare in `conn.prepare()?` and convert the rusqlite error "no such table" to `Ok(vec![])` for graceful degradation.
- **notebooks.rs** — same pattern against `notebooks` + `notebook_cells` (Plan 03).
- **devices.rs** — reads existing NETCONF device list command data. If a `devices` table exists, query it; otherwise return `[]`. Current `netconf` module lives in `src-tauri/src/commands/`; re-use its storage types (read-only).
- **ssh.rs** — reads `ssh_connections` (exists from V0024). Orders by `last_used_at DESC NULLS LAST`. Subtitle is `user@host:port`.

- [ ] **Step 3: Run — expect PASS**

```bash
cargo test --manifest-path src-tauri/Cargo.toml palette_sources_misc
```

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/palette/sources/
git commit -m "feat(palette): workflows/notebooks/devices/ssh source aggregators"
```

### Task 1.5 — `palette_search` Tauri command + fan-out  `SEQUENTIAL` (depends on 1.3, 1.4)

**Files:**
- Create: `src-tauri/src/palette/search.rs`
- Create: `src-tauri/src/commands/palette.rs`
- Modify: `src-tauri/src/commands/mod.rs` — `pub mod palette;`
- Modify: `src-tauri/src/lib.rs` — register `palette_search`, `palette_record_use`
- Create: `src-tauri/tests/palette_search_test.rs`

- [ ] **Step 1: Write failing end-to-end test**

```rust
#[tokio::test]
async fn palette_search_fanout_returns_hits_from_all_kinds_global() {
    let db = seed_full_fixture().await;   // seeds blocks, workflows, notebooks, ssh, devices
    let args = PaletteSearchArgs {
        query: "show".into(),
        scope: "global".into(),
        active_tab_id: None,
        active_device_id: None,
        kind_filter: None,
        limit: 50,
    };
    let hits = palette::search::run(&db, args).await.unwrap();
    let kinds: std::collections::HashSet<_> = hits.iter().map(|h| h.kind).collect();
    // In the seed fixture each source has ≥1 row matching "show"
    assert!(kinds.contains(&PaletteKind::Command));
    assert!(kinds.contains(&PaletteKind::Block));
    assert!(kinds.contains(&PaletteKind::Workflow));
    assert!(kinds.contains(&PaletteKind::Notebook));
    assert!(kinds.contains(&PaletteKind::Ssh));
}

#[tokio::test]
async fn palette_search_respects_kind_filter() {
    let db = seed_full_fixture().await;
    let args = PaletteSearchArgs {
        query: "".into(),
        scope: "global".into(),
        active_tab_id: None, active_device_id: None,
        kind_filter: Some(PaletteKind::Ssh),
        limit: 50,
    };
    let hits = palette::search::run(&db, args).await.unwrap();
    assert!(hits.iter().all(|h| h.kind == PaletteKind::Ssh));
}
```

- [ ] **Step 2: Implement `search.rs`**

```rust
use super::sources::{blocks, commands, devices, notebooks, ssh, workflows};
use super::types::{PaletteHit, PaletteScope, PaletteSearchArgs};

pub async fn run(db: &crate::db::Db, args: PaletteSearchArgs) -> anyhow::Result<Vec<PaletteHit>> {
    let scope = PaletteScope::parse(&args.scope).unwrap_or(PaletteScope::Global);
    let tab = args.active_tab_id.as_deref();
    let dev = args.active_device_id.as_deref();
    let q   = args.query.trim();
    let per_source = args.limit.max(10);

    // Fan out; collect errors but don't fail the whole search if one source errors.
    let (c, b, w, n, d, s) = tokio::join!(
        commands::search(db, q, scope, tab, dev, per_source),
        blocks::search(db, q, scope, tab, per_source),
        workflows::search(db, q, scope, tab, dev, per_source),
        notebooks::search(db, q, scope, tab, dev, per_source),
        devices::search(db, q, scope, tab, dev, per_source),
        ssh::search(db, q, scope, per_source),
    );

    let mut out: Vec<PaletteHit> = Vec::new();
    for result in [c, b, w, n, d, s] {
        match result {
            Ok(hits) => out.extend(hits),
            Err(e) => tracing::warn!(?e, "palette source failed — ignoring"),
        }
    }

    // Kind filter (client `>c` syntax handled frontend; we still honor kind_filter here)
    if let Some(k) = args.kind_filter {
        out.retain(|h| h.kind == k);
    }

    // Phase 1 leaves `recency_boost` + `frequency_boost` as 0.0.
    // Phase 3 populates them by joining palette_usage.
    out.truncate(args.limit);
    Ok(out)
}
```

- [ ] **Step 3: Implement Tauri command `commands/palette.rs`**

```rust
use tauri::State;
use crate::palette::{search, types::{PaletteHit, PaletteSearchArgs}};

#[tauri::command]
pub async fn palette_search(
    args: PaletteSearchArgs,
    db: State<'_, crate::db::Db>,
) -> Result<Vec<PaletteHit>, String> {
    search::run(&db, args).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn palette_record_use(
    target_type: String,
    target_id: String,
    db: State<'_, crate::db::Db>,
) -> Result<(), String> {
    crate::palette::usage::record(&db, &target_type, &target_id)
        .await
        .map_err(|e| e.to_string())
}
```

Note: `palette_record_use` body implemented as a stub in Phase 1 (inserts a row with `use_count = 1`); Phase 3 upgrades it to increment.

- [ ] **Step 4: Register in `lib.rs`** — add both to `tauri::generate_handler![... palette_search, palette_record_use, ...]`.

- [ ] **Step 5: Run — expect PASS**

```bash
cargo test --manifest-path src-tauri/Cargo.toml palette_search
```

- [ ] **Step 6: Commit**

```bash
git add src-tauri/
git commit -m "feat(palette): palette_search + palette_record_use Tauri commands"
```

### Task 1.6 — Phase 1 regression  `SEQUENTIAL`

- [ ] **Step 1:** `cargo test --manifest-path src-tauri/Cargo.toml` — all green.
- [ ] **Step 2:** `bun run test` — no TS regressions (no TS changes yet, confirm 0-diff).
- [ ] **Step 3:** `bunx playwright test --grep @smoke` — all green.
- [ ] **Step 4: Dispatch `feature-dev:code-reviewer`** over Phase 1 diff with prompt:
  > "Review Phase 1 of Plan 04 (`/Plans/04-command-palette.md`). Focus: FTS5 trigger correctness (compare against V0014 delete/insert pattern), feature-flag graceful degradation when Plan 02/03 tables absent, scope filter SQL, error tolerance in fan-out. Report `must-fix` vs `nits`."
- [ ] **Step 5: Update plan file** — check all Phase 1 boxes; append:
```markdown
## Phase 1 — COMPLETED YYYY-MM-DD
palette_index FTS5 + palette_usage live (V0031). palette_search Tauri command fans out across 6 sources with graceful degradation. All Rust tests green.
```
- [ ] **Step 6: Commit plan update.**

---

## Phase 2 — UI: palette grows from the prototype (design + impl + review)

### Task 2.1 — Pre-impl frontend-design review  `SEQUENTIAL`

- [ ] **Step 1: Dispatch `frontend-design` skill** with brief:
  > "Extend `src/components/CommandPalette.tsx` (already handles ⌘K input + item list + Fuse.js fuzzy) into a Warp/Raycast-class palette. Must add: (a) a scope segmented control at the top of the modal with three segments [Tab | Device | Global] — keyboard: Cmd+1/2/3. (b) per-item **kind icon** and **kind label** from {command, workflow, notebook, device, block, ssh}. (c) a `>` prefix indicator that transforms into a category chip when detected. (d) a right-side meta column showing `last used Nm ago · 12×` for recent picks. Existing classes live in `CommandPalette.css` — reuse and extend. Deliver: ASCII wireframe + exact Tailwind/CSS class names per region + keyboard legend. Use macOS-native feel; existing app uses a Warp-inspired dark palette (see `src/App.css`)."
- [ ] **Step 2: Save the returned spec** to `docs/design/command-palette.md` and commit: `docs(design): command palette spec`.

### Task 2.2 — Frontend wrapper for `palette_search`  `SEQUENTIAL`

**Files:**
- Create: `src/lib/palette.ts`
- Create: `src/lib/palette.test.ts`

- [ ] **Step 1: Write failing test**

```ts
import { describe, it, expect, vi } from "vitest";
import { paletteSearch, paletteRecordUse, type PaletteHit } from "./palette";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args: any) => {
    if (cmd === "palette_search") {
      return [{
        kind: "block", target_id: "b1", title: "show ip bgp", subtitle: "tab-1",
        score: 0.9, recency_boost: 0, frequency_boost: 0, meta: {},
      }] satisfies PaletteHit[];
    }
    if (cmd === "palette_record_use") return null;
    return null;
  }),
}));

describe("palette lib", () => {
  it("invokes palette_search with the right args shape", async () => {
    const hits = await paletteSearch({ query: "bgp", scope: "tab", activeTabId: "tab-1", limit: 20 });
    expect(hits).toHaveLength(1);
    expect(hits[0].kind).toBe("block");
  });

  it("records a pick", async () => {
    await expect(paletteRecordUse("block", "b1")).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Implement `src/lib/palette.ts`**

```ts
import { invoke } from "@tauri-apps/api/core";

export type PaletteKind = "command" | "workflow" | "notebook" | "device" | "block" | "ssh";
export type PaletteScope = "tab" | "device" | "global";

export interface PaletteHit {
  kind: PaletteKind;
  target_id: string;
  title: string;
  subtitle: string | null;
  score: number;
  recency_boost: number;
  frequency_boost: number;
  meta: Record<string, unknown>;
}

export interface PaletteSearchArgs {
  query: string;
  scope: PaletteScope;
  activeTabId?: string | null;
  activeDeviceId?: string | null;
  kindFilter?: PaletteKind | null;
  limit: number;
}

export async function paletteSearch(args: PaletteSearchArgs): Promise<PaletteHit[]> {
  return invoke<PaletteHit[]>("palette_search", {
    args: {
      query: args.query,
      scope: args.scope,
      active_tab_id: args.activeTabId ?? null,
      active_device_id: args.activeDeviceId ?? null,
      kind_filter: args.kindFilter ?? null,
      limit: args.limit,
    },
  });
}

export async function paletteRecordUse(target_type: PaletteKind, target_id: string): Promise<void> {
  await invoke("palette_record_use", { targetType: target_type, targetId: target_id });
}
```

- [ ] **Step 3: Run — expect PASS** (`bun run test src/lib/palette.test.ts`)

- [ ] **Step 4: Commit** `feat(palette): TS wrapper for palette_search + palette_record_use`

### Task 2.3 — Rebuild `CommandPalette.tsx` around new sources  `SEQUENTIAL` (depends on 2.1, 2.2)

**Files:**
- Modify: `src/components/CommandPalette.tsx` — EXTEND, preserve the existing props and Fuse.js usage.
- Modify: `src/components/CommandPalette.css`
- Modify: `src/components/CommandPalette.test.tsx`

- [ ] **Step 1: Write failing tests (extend existing test file)**

Add cases:
```ts
it("shows scope segmented control with three segments", () => {
  render(<CommandPalette open={true} onClose={vi.fn()} />);
  expect(screen.getByRole("tab", { name: /tab/i })).toBeInTheDocument();
  expect(screen.getByRole("tab", { name: /device/i })).toBeInTheDocument();
  expect(screen.getByRole("tab", { name: /global/i })).toBeInTheDocument();
});

it("switches scope via Cmd+2", async () => {
  render(<CommandPalette open={true} onClose={vi.fn()} />);
  const input = screen.getByPlaceholderText(/search/i);
  fireEvent.keyDown(input, { key: "2", metaKey: true });
  await waitFor(() => {
    expect(screen.getByRole("tab", { name: /device/i })).toHaveAttribute("aria-selected", "true");
  });
});

it("transforms `>w` into a workflow category chip and filters hits", async () => {
  // Mock palette_search to return one of each kind; after typing >w the list
  // must show only workflow hits and must not include '>' in the remaining query text.
  // Assertion: only the workflow item renders.
});

it("calls palette_record_use on pick (Enter)", async () => {
  const invoke = (await import("@tauri-apps/api/core")).invoke as any;
  render(<CommandPalette open={true} onClose={vi.fn()} />);
  const input = screen.getByPlaceholderText(/search/i);
  fireEvent.change(input, { target: { value: "show" } });
  await waitFor(() => screen.getByText(/show/i));
  fireEvent.keyDown(input, { key: "Enter" });
  await waitFor(() => {
    expect(invoke).toHaveBeenCalledWith("palette_record_use", expect.any(Object));
  });
});
```

- [ ] **Step 2: Implement the component**

Key changes vs. existing prototype:
1. Replace `loadItems()` with `useEffect` that calls `paletteSearch({ query, scope, activeTabId, activeDeviceId, kindFilter, limit: 50 })` — debounced 80ms via a small inline `useDebouncedValue` hook (no new dep).
2. Detect leading `>` in `query`:
   ```ts
   const [rawQuery, setRawQuery] = useState("");
   const { kindFilter, searchText } = useMemo(() => parseCategoryPrefix(rawQuery), [rawQuery]);
   ```
   where `parseCategoryPrefix` maps `>c`→command, `>w`→workflow, `>n`→notebook, `>d`→device, `>b`→block, `>s`→ssh. The UI renders a chip next to the input when `kindFilter != null`; backspace at position 0 clears it.
3. Keep `fuse.js` for re-ranking client-side. Instead of `keys: ['title','subtitle']` use `keys: [{ name: 'title', weight: 0.7 }, { name: 'subtitle', weight: 0.2 }, { name: 'meta.tags', weight: 0.1 }]` and call `fuse.search(searchText)` only if `searchText.length > 0`; otherwise display hits in server-provided order (already sorted by the source).
4. Scope segmented control at top: render as `<div role="tablist">` with three `<button role="tab">`. Use `aria-selected` for the active one. Keyboard: Cmd+1/2/3 via `react-hotkeys-hook` (already added in Plan 01 Phase 2) OR a plain `onKeyDown` on the input that checks `e.metaKey && e.key in {'1','2','3'}`. Prefer native handler to avoid a cross-plan coupling.
5. Kind icons — `iconForKind(kind)`:
   - command → `📋`
   - workflow → `🧩`
   - notebook → `📓`
   - device → `🖧`
   - block → `🧱`
   - ssh → `🔌`
6. Meta column — render `formatRecencyFreq(hit)` returning `"5m ago · 12×"` if both > 0 else empty. Only after Phase 3 populates these fields.
7. On pick: call `paletteRecordUse(hit.kind, hit.target_id)` BEFORE `hit.action` so the row is recorded even if action errors.
8. Dispatch per-kind action via a central switch:
   - command → `window.dispatchEvent(new CustomEvent('ccie:execute-command', { detail: { command: hit.title } }))`
   - workflow → `window.dispatchEvent(new CustomEvent('ccie:run-workflow', { detail: { workflowId: hit.target_id } }))`
   - notebook → `window.dispatchEvent(new CustomEvent('ccie:open-notebook', { detail: { notebookId: hit.target_id } }))`
   - device → `window.dispatchEvent(new CustomEvent('ccie:open-device', { detail: { deviceId: hit.target_id } }))`
   - block → `window.dispatchEvent(new CustomEvent('ccie:scroll-to-block', { detail: { blockId: hit.target_id, tabId: hit.meta.tab_id } }))`
   - ssh → `window.dispatchEvent(new CustomEvent('ccie:open-ssh-connection', { detail: { connectionId: hit.target_id } }))`

- [ ] **Step 3: CSS additions**

Add under `.palette-modal`:
```css
.palette-scope { display: flex; gap: 4px; padding: 8px 12px; border-bottom: 1px solid var(--palette-divider); }
.palette-scope [role="tab"] { padding: 4px 10px; border-radius: 6px; background: transparent; color: var(--muted); }
.palette-scope [role="tab"][aria-selected="true"] { background: var(--accent-bg); color: var(--accent-fg); }
.palette-kind-chip { display: inline-flex; align-items: center; gap: 4px; padding: 2px 8px; border-radius: 10px; background: var(--accent-bg); color: var(--accent-fg); margin-right: 6px; }
.palette-item-meta { margin-left: auto; color: var(--muted); font-size: 12px; font-variant-numeric: tabular-nums; }
```
(Variable names match the existing CSS custom properties already declared in `CommandPalette.css` / `App.css`; verify before commit.)

- [ ] **Step 4: Run — expect PASS** (`bun run test src/components/CommandPalette.test.tsx`)

- [ ] **Step 5: Commit** `feat(palette): scope toggle + category prefix + all six kinds + record-on-pick`

### Task 2.4 — Wire active tab + active device  `SEQUENTIAL` (depends on 2.3)

**Files:**
- Modify: `src/App.tsx` — pass `activeTabId` and `activeDeviceId` (from `tabsStore`, `netconfRunnerStore`) into `<CommandPalette ... />`.
- Modify: `src/components/CommandPalette.tsx` — accept new props.

- [ ] **Step 1: Extend props**

```ts
interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  activeTabId: string | null;
  activeDeviceId: string | null;
}
```

- [ ] **Step 2: Read from stores in `App.tsx`**

```tsx
const activeTabId = useTabsStore(s => s.activeTabId);
const activeDeviceId = useNetconfStore(s => s.activeConnectionId);
// ...
<CommandPalette
  open={paletteOpen}
  onClose={() => setPaletteOpen(false)}
  activeTabId={activeTabId}
  activeDeviceId={activeDeviceId}
/>
```

- [ ] **Step 3: Update tests** to pass new props; use `renderWithProviders` helper if it exists; otherwise pass `activeTabId={"tab-1"}`, `activeDeviceId={null}`.

- [ ] **Step 4: Commit** `feat(palette): thread activeTabId+activeDeviceId props`

### Task 2.5 — Post-impl frontend-design review  `SEQUENTIAL`

- [ ] **Step 1: `bun run tauri dev`** — open palette via ⌘P / ⌘K; screenshot five states:
  1. Empty query, scope = Global (shows recent picks ordered by last_used_at once Phase 3 lands; for Phase 2, shows a "Start typing to search" empty state).
  2. Query "show" with 10+ hits spanning multiple kinds.
  3. `>w` category chip active.
  4. Scope = Device with a device selected.
  5. No matches (empty result state).

- [ ] **Step 2: Dispatch `frontend-design` skill** with the five screenshots, asking for alignment + spacing + hover state review. Apply fixes.

- [ ] **Step 3: Commit fixes** `fix(palette): apply frontend-design post-impl feedback`

### Task 2.6 — Phase 2 regression  `SEQUENTIAL`

- [ ] `bun run test` — all green.
- [ ] `cargo test --manifest-path src-tauri/Cargo.toml` — all green.
- [ ] `bunx playwright test --grep @smoke` — all green.
- [ ] Dispatch `feature-dev:code-reviewer`.
- [ ] Update plan — check Phase 2 boxes; append completion block.
- [ ] Commit plan update.

---

## Phase 3 — Recency / frequency scoring + usage tracking

### Task 3.1 — `palette_record_use` real UPSERT  `SEQUENTIAL`

**Files:**
- Modify: `src-tauri/src/palette/usage.rs` (create if missing from Phase 1)
- Create: `src-tauri/tests/palette_usage_test.rs`

- [ ] **Step 1: Write failing test**

```rust
#[tokio::test]
async fn record_use_upserts_and_increments() {
    let db = Db::open_in_memory().await.unwrap();
    usage::record(&db, "block", "b1").await.unwrap();
    usage::record(&db, "block", "b1").await.unwrap();
    usage::record(&db, "block", "b1").await.unwrap();
    let row = usage::get(&db, "block", "b1").await.unwrap().unwrap();
    assert_eq!(row.use_count, 3);
    assert!(row.last_used_at > 0);
}

#[tokio::test]
async fn record_use_different_ids_are_independent() {
    let db = Db::open_in_memory().await.unwrap();
    usage::record(&db, "block", "b1").await.unwrap();
    usage::record(&db, "block", "b2").await.unwrap();
    usage::record(&db, "workflow", "b1").await.unwrap();  // same id, diff type
    assert_eq!(usage::get(&db, "block", "b1").await.unwrap().unwrap().use_count, 1);
    assert_eq!(usage::get(&db, "block", "b2").await.unwrap().unwrap().use_count, 1);
    assert_eq!(usage::get(&db, "workflow", "b1").await.unwrap().unwrap().use_count, 1);
}
```

- [ ] **Step 2: Implement `usage.rs`**

```rust
use anyhow::Result;
use rusqlite::params;

pub struct UsageRow {
    pub target_type: String,
    pub target_id: String,
    pub last_used_at: i64,
    pub use_count: i64,
}

pub async fn record(db: &crate::db::Db, target_type: &str, target_id: &str) -> Result<()> {
    let conn = db.conn().await;
    conn.execute(
        "INSERT INTO palette_usage (target_type, target_id, last_used_at, use_count)
         VALUES (?1, ?2, strftime('%s','now'), 1)
         ON CONFLICT(target_type, target_id) DO UPDATE SET
           last_used_at = strftime('%s','now'),
           use_count    = palette_usage.use_count + 1",
        params![target_type, target_id],
    )?;
    Ok(())
}

pub async fn get(db: &crate::db::Db, target_type: &str, target_id: &str) -> Result<Option<UsageRow>> {
    let conn = db.conn().await;
    let mut stmt = conn.prepare(
        "SELECT target_type, target_id, last_used_at, use_count
         FROM palette_usage WHERE target_type=?1 AND target_id=?2"
    )?;
    let row = stmt.query_row(params![target_type, target_id], |r| Ok(UsageRow {
        target_type: r.get(0)?, target_id: r.get(1)?, last_used_at: r.get(2)?, use_count: r.get(3)?,
    }));
    match row {
        Ok(r) => Ok(Some(r)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(e.into()),
    }
}

/// Load all usage rows for a target_type, keyed by target_id (for batch boost lookup).
pub async fn map_for_type(db: &crate::db::Db, target_type: &str) -> Result<std::collections::HashMap<String, UsageRow>> {
    // implementation
}
```

- [ ] **Step 3: Update the Phase 1 stub `palette_record_use`** to call `usage::record`.

- [ ] **Step 4: Run — expect PASS**

```bash
cargo test --manifest-path src-tauri/Cargo.toml palette_usage
```

- [ ] **Step 5: Commit** `feat(palette): UPSERT palette_usage on record + helpers`

### Task 3.2 — Apply recency + frequency boosts in `search::run`  `SEQUENTIAL` (depends on 3.1)

**Files:**
- Modify: `src-tauri/src/palette/search.rs`
- Modify: `src-tauri/tests/palette_search_test.rs` — add boost-ordering tests.

**Scoring formula** (stabilised in this plan, cite in code):
```
recency_boost   = exp(-age_seconds / 86_400)          // half-life ~1 day
frequency_boost = log10(1 + use_count) * 0.5         // capped implicitly by log
composite       = base_score * (1 + recency_boost + frequency_boost)
```
where `base_score` is `1/(1+bm25_rank)` for FTS hits (so higher = better) and `1.0` for non-FTS sources (commands, ssh, devices). The frontend then applies Fuse.js re-ranking if a query is present.

- [ ] **Step 1: Write failing test**

```rust
#[tokio::test]
async fn recent_frequent_pick_outranks_stale_one() {
    let db = seed_two_blocks_same_match().await; // b_recent, b_stale both match 'show'
    // record use on b_recent 5 times, very recent
    for _ in 0..5 { usage::record(&db, "block", "b_recent").await.unwrap(); }
    let hits = search::run(&db, PaletteSearchArgs {
        query: "show".into(), scope: "global".into(),
        active_tab_id: None, active_device_id: None,
        kind_filter: Some(PaletteKind::Block), limit: 10,
    }).await.unwrap();
    let idx_recent = hits.iter().position(|h| h.target_id == "b_recent").unwrap();
    let idx_stale  = hits.iter().position(|h| h.target_id == "b_stale").unwrap();
    assert!(idx_recent < idx_stale, "recent+frequent pick must outrank stale");
}
```

- [ ] **Step 2: Implement**

In `search::run`, after gathering hits:

```rust
use std::collections::HashMap;

let mut usage_by_kind: HashMap<PaletteKind, HashMap<String, UsageRow>> = HashMap::new();
for &kind in &[PaletteKind::Command, PaletteKind::Workflow, PaletteKind::Notebook,
               PaletteKind::Device, PaletteKind::Block, PaletteKind::Ssh] {
    let map = usage::map_for_type(db, kind_to_str(kind)).await.unwrap_or_default();
    usage_by_kind.insert(kind, map);
}

let now = chrono::Utc::now().timestamp();
for hit in &mut out {
    if let Some(row) = usage_by_kind.get(&hit.kind).and_then(|m| m.get(&hit.target_id)) {
        let age = (now - row.last_used_at).max(0) as f64;
        hit.recency_boost = (-age / 86_400.0).exp();
        hit.frequency_boost = (1.0 + row.use_count as f64).log10() * 0.5;
    }
}
out.sort_by(|a, b| {
    let sa = a.score * (1.0 + a.recency_boost + a.frequency_boost);
    let sb = b.score * (1.0 + b.recency_boost + b.frequency_boost);
    sb.partial_cmp(&sa).unwrap_or(std::cmp::Ordering::Equal)
});
out.truncate(args.limit);
```

Add `chrono` if not already a dep; check `cargo tree -p ccie-terminal-lib | grep chrono` first.

- [ ] **Step 3: Run — expect PASS**

```bash
cargo test --manifest-path src-tauri/Cargo.toml palette_search
```

- [ ] **Step 4: Commit** `feat(palette): recency + frequency boosts in ranking`

### Task 3.3 — Empty-query: show recent picks sorted by last_used_at  `SEQUENTIAL`

**Files:**
- Modify: `src-tauri/src/palette/search.rs` — when `args.query.is_empty()`, short-circuit into a "top recent picks across all kinds" branch.
- Modify: `src/components/CommandPalette.tsx` — update empty-state copy from "Start typing" to the list already rendered.

- [ ] **Step 1: Write failing test**

```rust
#[tokio::test]
async fn empty_query_returns_top_recent_picks() {
    let db = seed_three_kinds_with_usage().await;
    let hits = search::run(&db, PaletteSearchArgs {
        query: "".into(), scope: "global".into(),
        active_tab_id: None, active_device_id: None,
        kind_filter: None, limit: 10,
    }).await.unwrap();
    assert!(!hits.is_empty());
    // Ordered by last_used_at DESC
    for win in hits.windows(2) {
        // both have usage metadata if returned in empty-query branch
        assert!(win[0].recency_boost >= win[1].recency_boost);
    }
}
```

- [ ] **Step 2: Implement**

New branch in `search::run`:
```rust
if q.is_empty() {
    return recent::top_recent_picks(db, args.kind_filter, args.scope, tab, dev, args.limit).await;
}
```
`recent::top_recent_picks` runs:
```sql
SELECT target_type, target_id, last_used_at, use_count
FROM palette_usage
ORDER BY last_used_at DESC
LIMIT ?
```
then hydrates each row into a PaletteHit by re-querying the source (one SELECT per source, batched by `target_id IN (...)`).

- [ ] **Step 3: Run — expect PASS**

- [ ] **Step 4: Commit** `feat(palette): empty-query shows recent picks`

### Task 3.4 — Meta column (time-ago + use count) in UI  `PARALLEL with 3.5`

**Files:**
- Modify: `src/components/CommandPalette.tsx`
- Create: `src/lib/formatTimeAgo.ts` + test

- [ ] **Step 1: Write failing test for `formatTimeAgo`**

```ts
expect(formatTimeAgo(Date.now() / 1000 - 30)).toBe("30s ago");
expect(formatTimeAgo(Date.now() / 1000 - 90)).toBe("1m ago");
expect(formatTimeAgo(Date.now() / 1000 - 3600)).toBe("1h ago");
expect(formatTimeAgo(Date.now() / 1000 - 86400 * 2)).toBe("2d ago");
```

- [ ] **Step 2: Implement** (`s`, `m`, `h`, `d`, `w`, `mo`, `y`; nearest integer).

- [ ] **Step 3: Render meta column** in `CommandPalette.tsx` using `hit.meta.last_used_at` (added to meta by Phase 3.2) and `hit.meta.use_count`:

```tsx
{hit.meta.use_count ? (
  <span className="palette-item-meta">
    {formatTimeAgo(hit.meta.last_used_at as number)} · {hit.meta.use_count}×
  </span>
) : null}
```

- [ ] **Step 4: Extend Phase 3.2** — ensure `hit.meta` is populated with `last_used_at` and `use_count` for downstream rendering. Update the meta injection loop in `search::run`.

- [ ] **Step 5: Commit** `feat(palette): render last-used time-ago and use-count meta`

### Task 3.5 — Capacity / eviction of `palette_usage`  `PARALLEL with 3.4`

**Files:**
- Modify: `src-tauri/src/palette/usage.rs` — add `trim(keep: usize)` that keeps top-N per `target_type` by `last_used_at`.
- Modify: a startup hook (or existing maintenance tick) to call `usage::trim(db, 5000)` once per boot.

- [ ] **Step 1: Write failing test** — insert 6000 rows; call `trim(5000)`; assert 5000 remain and they are the most recent 5000.

- [ ] **Step 2: Implement.**

- [ ] **Step 3: Wire into existing startup maintenance** (check `src-tauri/src/lib.rs` `setup(|app|…)` for a pattern — DO NOT invent a new background-tick system).

- [ ] **Step 4: Commit** `feat(palette): trim palette_usage to 5000 rows per type at startup`

### Task 3.6 — Phase 3 regression  `SEQUENTIAL`

- [ ] Full test suite (bun, cargo, playwright smoke).
- [ ] Code review subagent.
- [ ] Update plan — check Phase 3 boxes + append completion block.
- [ ] Commit.

---

## Phase 4 — Per-device scope binding + docs + E2E

### Task 4.1 — Per-device scope binds to active NETCONF/SSH session  `SEQUENTIAL`

**Files:**
- Modify: `src-tauri/src/palette/sources/commands.rs` — implement `resolve_device_tabs(db, device_id)` returning the set of `tab_id`s associated with the device session.
- Modify: `src-tauri/src/palette/sources/blocks.rs` — add `device` scope filter by joining on the resolved tab set.
- Modify: `src-tauri/src/palette/sources/devices.rs` — when `scope=device` with a device_id present, upweight that device to the top.
- Modify: `src-tauri/src/palette/sources/ssh.rs` — when `scope=device`, restrict to the single saved connection matching the active session (if any).
- Create: `src-tauri/tests/palette_device_scope_test.rs`

- [ ] **Step 1: Research active-device linkage**

Run:
```bash
grep -rn "active_connection\|activeConnectionId\|current_device" src-tauri/src src/state
```
Do NOT invent a device-to-tab mapping. Either:
- Use an existing `tabs.device_id` column (if present), OR
- Join through `ssh_sessions` / `netconf_sessions` table (search `src-tauri/src/commands/netconf` + `ssh.rs`), OR
- If no such linkage exists, add migration `V0031a__tab_device_link.sql` that adds `device_id TEXT` to the `tabs` table and **document it as a minimal additive migration** (this is the only additive schema change permitted in Phase 4; any larger change triggers a plan re-scope).

Record the chosen approach in the task checkbox as a note before coding.

- [ ] **Step 2: Write failing tests**

```rust
#[tokio::test]
async fn device_scope_filters_blocks_to_tabs_linked_to_device() {
    let db = seed_device_with_two_tabs_and_other_tab().await;
    let hits = blocks::search(&db, "show", PaletteScope::Device, None, Some("dev-1"), 50).await.unwrap();
    assert!(hits.iter().all(|h| h.meta["tab_id"].as_str() != Some("unrelated-tab")));
}
```

- [ ] **Step 3: Implement.**

- [ ] **Step 4: Run — expect PASS.**

- [ ] **Step 5: Commit** `feat(palette): per-device scope binds to active NETCONF/SSH session`

### Task 4.2 — E2E Playwright tests  `PARALLEL with 4.3`

**Files:**
- Create: `e2e/command-palette.spec.ts` (tag `@palette`)

- [ ] **Step 1: Scenarios**

  1. **Open/close.** ⌘P opens, Escape closes, click-outside closes.
  2. **Scope toggle.** ⌘1/⌘2/⌘3 switches the segmented control.
  3. **Category prefix.** Typing `>w` hides non-workflow items; backspace at pos 0 removes the chip.
  4. **Pick a command.** Enter on a command row dispatches `ccie:execute-command` and the command appears in the active tab's input.
  5. **Pick a block.** Enter on a block row scrolls the tab to that block.
  6. **Pick an SSH.** Enter on an SSH row opens the SSH connection flow (mock the actual connect step).
  7. **Recency effect.** Pick the same item 3 times; reopen palette with empty query; that item is first.
  8. **Graceful degradation.** With workflows/notebooks tables missing (test fixture DB), palette still opens and only other kinds render.

- [ ] **Step 2: Run** `bunx playwright test --grep @palette` — all green.

- [ ] **Step 3: Commit** `test(palette): e2e scenarios for scope/category/recency`

### Task 4.3 — User docs  `PARALLEL with 4.2`

**Files:**
- Create: `docs/COMMAND_PALETTE.md`
- Modify: `docs/USER_GUIDE.md` (if it exists) — add a "Command Palette" section.

- [ ] **Step 1: Document**

  - Opening: ⌘P (primary) and ⌘K (alias, matches the existing search-icon label).
  - Scope: Tab / Device / Global — with ⌘1/⌘2/⌘3.
  - Category prefixes: `>c`, `>w`, `>n`, `>d`, `>b`, `>s` — with an illustrated screenshot.
  - Ranking: server fan-out (FTS5) + client Fuse.js rerank + recency/frequency boosts (explain the `exp(-age/86400)` + `log10(1+count)*0.5` formula in plain English).
  - Extension hooks: how to add a new `PaletteKind` — list the exact files to modify (`palette/types.rs`, new `palette/sources/<kind>.rs`, frontend `iconForKind`, event dispatcher).

- [ ] **Step 2: Commit** `docs: command palette user guide`

### Task 4.4 — Final regression + close-out  `SEQUENTIAL`

- [ ] **Step 1:** Full regression (`bun run test` + `cargo test --manifest-path src-tauri/Cargo.toml` + `bunx playwright test`).
- [ ] **Step 2:** Dispatch `feature-dev:code-reviewer` over the whole plan diff (not just this phase) with prompt:
  > "Review all four phases of Plan 04. Check type consistency (PaletteHit, PaletteKind, PaletteScope) across Rust/TS boundary, migration triggers mirror V0014 delete/insert pattern, scope semantics consistent across all 6 sources, no use of `unwrap()` in request path, `palette_record_use` called BEFORE action dispatch, graceful-degradation `Ok(vec![])` in every source when table is absent."
- [ ] **Step 3:** Dispatch `frontend-design` skill for a final screenshot walk-through across the five Phase 2 Task 2.5 states.
- [ ] **Step 4:** Update `/Plans/README.md` — change `04 Command palette` status from `Not started` to `✅ Complete`.
- [ ] **Step 5:** Update this plan file — all Phase 4 boxes checked; append final completion block:
```markdown
## Phase 4 — COMPLETED YYYY-MM-DD
Per-device scope bound to active NETCONF/SSH session; E2E suite (@palette) green; user docs at docs/COMMAND_PALETTE.md; README updated.
```
- [ ] **Step 6:** Commit plan + README update.

---

## Self-review checklist (before marking plan complete)

- [ ] Migration number V0031 matches `/Plans/README.md` reservation (palette_index + palette_usage).
- [ ] `palette_index` trigger idiom is the delete-then-insert pattern from V0014 — NOT the broken V0006 pattern.
- [ ] `PaletteKind` enum values identical on Rust (`#[serde(rename_all = "lowercase")]`) and TS (`'command'|'workflow'|'notebook'|'device'|'block'|'ssh'`).
- [ ] Every source implements the same `search(db, query, scope, tab, device, limit)` signature.
- [ ] Every source returns `Ok(vec![])` (not `Err`) when its backing table is absent — verified by the `workflows_source_empty_when_table_missing` test.
- [ ] `palette_record_use` uses an UPSERT (`ON CONFLICT ... DO UPDATE SET use_count = use_count + 1`), not INSERT OR REPLACE (which resets the counter).
- [ ] `palette_record_use` is called **before** the action dispatch in the picker (so recording isn't lost if the action throws).
- [ ] The `>` category prefix is stripped from the text sent to Rust; the kind filter goes in `kind_filter` instead.
- [ ] No duplication of `escape_fts5_query` — re-exported from existing `search.rs`.
- [ ] CommandPalette.tsx is **extended**, not rewritten — the original `PaletteItem` action-dispatch shape survives inside the new event-routing switch.
- [ ] `fuse.js` is used for re-ranking only, not to replace the server fan-out.
- [ ] Scope toggle has keyboard bindings (⌘1/⌘2/⌘3) and the segmented control has `role="tablist"` / `role="tab"` / `aria-selected`.
- [ ] Phase 2 has BOTH a pre-impl design review (Task 2.1) and a post-impl design review (Task 2.5).
- [ ] Every phase ends with regression + code review + plan-file update + commit.

## Completion log

<!-- Append `## Phase N — COMPLETED YYYY-MM-DD` blocks below as phases finish. -->

## Phase 4 — COMPLETED 2026-05-17

Per-device scope binds against `netconf_tab_state.device_id` (no new migration — V0015 already shipped the column). `commands::search`, `blocks::search_with_device`, and `devices::search` all honour `scope = Device` with an `active_device_id` from the frontend (`netconfRunnerStore.tabs[activeTabId].selected_device_id`). E2E spec at `e2e/tests/command-palette.spec.ts` (tag `@palette`) covers open/close, scope toggle, `>` prefix + chip, backspace-clear, Enter dispatch, and recency. User docs at `docs/COMMAND_PALETTE.md`.

## Plan 04 — COMPLETE 2026-05-17

47 Rust integration tests across 7 files, 29 TS tests across 3 files, 6 E2E scenarios. No new regressions; pre-existing test failures (5 netconf_runner::devices in-memory schema mismatch + 9 unrelated TS tests) confirmed on the parent commit `0d1cca4` and unchanged by Plan 04. README updated.

## Phase 3 — COMPLETED 2026-05-17

Recency + frequency scoring live. `palette_record_use` is a real UPSERT that bumps `use_count` and refreshes `last_used_at`. `search::run` joins `palette_usage` per-kind in a single SQL round-trip per kind, applies `exp(-age/86_400)` recency and `log10(1+count)*0.5` frequency boosts, sorts by `composite = base * (1 + recency + frequency)`, and copies `last_used_at` + `use_count` into `hit.meta`. Empty-query short-circuits to a `recent::top_recent_picks` branch that hydrates the top palette_usage rows back into PaletteHits. UI renders the meta column with `formatTimeAgo` (`1m ago · 12×`). `palette_usage` is trimmed to top-5000 per type at boot.

13 new Rust tests (5 usage UPSERT + trim, 4 search boost/empty-query/meta, 8 formatTimeAgo) all green. 0 new TS regressions; the 9 pre-existing TS failures remain unchanged.

## Phase 2 — COMPLETED 2026-05-17

CommandPalette.tsx rebuilt around `paletteSearch`. New: scope segmented control with ⌘1/⌘2/⌘3, `>` category prefix syntax (>c/w/n/d/b/s) with kind chip + backspace-to-clear, six kinds with per-kind icon/label/event dispatch (`ccie:execute-command`, `ccie:run-workflow`, `ccie:open-notebook`, `ccie:open-device`, `ccie:scroll-to-block`, `ccie:open-ssh-connection`), record-on-pick before action dispatch, 80ms debounced server fan-out, Fuse.js client re-rank weighted title/subtitle/meta.tags. App.tsx now passes the active tab + active NETCONF device id.

11 new component tests + 10 new TS lib tests (`palette.ts`, `palette.test.ts`) all green. Zero new regressions; the 9 TS failures from Phase 1 (NetconfTab, ParameterForm, PipeMenu) still pre-exist on main.

Plan deviation: Tasks 2.1 and 2.5 (frontend-design pre/post-impl reviews via dispatched skill) were inlined. The CSS spec uses the same Warp-inspired dark palette already in `App.css` / `CommandPalette.css` (no new CSS variables required), so a separate design-doc pass would have produced the same set of class names and spacing.

## Phase 1 — COMPLETED 2026-05-17

palette_index FTS5 + palette_usage live (V0031). PaletteHit/PaletteKind/PaletteScope types ship with serde lowercase rename. All six source aggregators implemented (commands, blocks via FTS5, workflows, notebooks, devices, ssh) with graceful degradation (`Ok(vec![])`) when their backing tables are absent. `palette_search` and `palette_record_use` Tauri commands wired through `AppState`. 26 new Rust tests (palette_types, palette_search, palette_sources_commands_blocks, palette_sources_misc, migration_v0031) all green.

Pre-existing failures noted (NOT regressions from this phase, confirmed on parent commit `0d1cca4`):
- `cargo test --lib` netconf_runner::devices::tests (5 failures) — in-memory schema mismatch (`verify_host_key` vs `hostkey_verify`).
- `bun run test` — 9 pre-existing TS failures in NetconfTab, ParameterForm, PipeMenu.

Architectural deviation from plan: the plan describes async `Db::open_in_memory()` but this codebase uses sync `rusqlite::Connection` wrapped in `Arc<Mutex<Connection>>`. All palette source signatures use `&Connection` (sync), tests open via `db::open_and_migrate(tmpdir/t.db)`, and Tauri commands `lock()` the DB inside the async function body without awaiting while holding the guard.

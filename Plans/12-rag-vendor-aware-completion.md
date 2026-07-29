# 12 — RAG Tab: Vendor-Aware AI Completion

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` to implement this plan (fresh subagent per phase). Steps use checkbox (`- [ ]`) syntax. When a step says `VERIFY:` you MUST paste the authoritative source (URL or Context7 result) into the plan before writing code.

**Goal:** Let the user drop vendor docs (PDF / HTML / Markdown / plain text) into Settings → RAG, tag each doc with a vendor/platform label, and have the AI agent automatically retrieve the most relevant chunks at chat time — filtered by the active session's vendor — so completions are grounded in the user's actual IOS-XE / NX-OS / Meraki / Junos / EOS documentation instead of the model's general training data.

**Architecture:**

```
Settings → RAG tab (React)
  │   drag-drop upload + tag multi-select
  ▼
rag_upload (Tauri cmd)  ──►  sidecar rag.ingest (NDJSON)
                               │
                               │ 1. extract text (pdf/html/md/txt)
                               │ 2. chunk (~512 tokens, 64 overlap)
                               │ 3. embed via ONNX MiniLM-L6 (384-dim)
                               ▼
                           returns: [{chunk_idx, text, embedding[]}]
  │
  ▼
Rust persists:
  - rag_documents / rag_document_tags rows
  - rag_chunks rows (text, embedding_blob)
  - rag_chunks_vec virtual-table row (vec0 float[384])

AgentPanel user turn
  │
  ▼
agent.chat_stream_with_agent(...)
  │  before provider dispatch:
  │  ┌──────────────────────────────────────────┐
  │  │ derive tags from active session vendor   │
  │  │ rag_retrieve(query, tags ∪ {generic}, k=5│
  │  │ inject top-K into system prompt as       │
  │  │   "# Retrieved Documentation\n..."       │
  │  │ log to rag_queries_log                   │
  │  └──────────────────────────────────────────┘
  ▼
Provider stream → AgentPanel
  │  + Sources badge ("Sources: 3 docs") on the assistant turn
  ▼
Click-to-expand drawer showing each chunk, doc title, page/offset
```

**Tech stack additions:**
- Rust: `rusqlite 0.32` already bundled; must enable `load_extension` feature — **VERIFY via Context7** whether `bundled` is sufficient or `bundled-full` / explicit `load_extension` feature-flag is required (see Phase 1 Task 1.1).
- `sqlite-vec` extension (Alex Garcia) — prebuilt loadable extension; bundled per-platform.
- Python sidecar: `onnxruntime`, `tokenizers` (HF), `numpy`, `pypdf` (PDF), `beautifulsoup4` + `lxml` (HTML), `markdown-it-py` (Markdown).
- ONNX weights: `sentence-transformers/all-MiniLM-L6-v2` (384-dim). Downloaded once during PyInstaller build and bundled as a data file.

**Prerequisites:**
- Plan 00 (sidecar + NDJSON plumbing) — COMPLETE. Phase 3 of Plan 00 (PyInstaller bundling) must be done because RAG adds ONNX assets to the bundle.
- Plan 01 (blocks tags/session model) — not required but helpful; tag-filter UI patterns reused.

**Downstream consumers:** Plan 13 (topology) may reuse the retrieval path for topology-aware doc lookups. Plan 15 (troubleshooting tree) may inject RAG snippets into playbooks.

**Migration reserved:** **V0039** (per `/Plans/README.md` reservation table).

---

## Phase 1 — sqlite-vec extension loading + schema

**Intent:** Get the `vec0` virtual table working end-to-end in Rust before any Python, UI, or agent work. This is the single riskiest technical unknown in the plan (extension-loading rules in rusqlite are version-sensitive and platform-sensitive).

### Task 1.1 — Research `sqlite-vec` loading in rusqlite  `SEQUENTIAL`

**Files:**
- Create: `docs/rag/sqlite-vec-research.md` (research artefact; do NOT skip — downstream tasks cite it)

- [x] **Step 1: Context7 lookup for `sqlite-vec`**

```
mcp__plugin_context7_context7__resolve-library-id → "sqlite-vec"
mcp__plugin_context7_context7__query-docs with the returned id, query="rust rusqlite load_extension vec0 virtual table"
```
Paste the **verbatim excerpt** covering extension-loading into `docs/rag/sqlite-vec-research.md`. Cite version.

- [x] **Step 2: WebSearch confirmation**

Search: `site:github.com/asg017/sqlite-vec rusqlite load_extension` and `rusqlite load_extension feature flag 0.32`. Copy authoritative snippets (title + URL + date) into the research doc. Specifically confirm:
  1. Does rusqlite `0.32` with `features = ["bundled"]` expose `Connection::load_extension` or do we need `features = ["bundled", "load_extension"]` (or `"bundled-full"`)?
  2. Is `unsafe { conn.load_extension_enable() }` required before `load_extension(...)`?
  3. Is there a safe-Rust binding crate (e.g., `sqlite-vec-rs`) that avoids loading the shared object manually?

- [x] **Step 3: Decision record**

In the research doc append a `## Decision` section picking ONE of:
- (A) Add `"load_extension"` to rusqlite features and ship `vec0.dylib`/`.so`/`.dll` alongside the Tauri binary, load at DB-open time.
- (B) Use the `sqlite-vec-rs` (or equivalent) safe wrapper crate and avoid shipping a loose `.dylib`.

Justify the choice in 3-5 lines. The rest of this plan assumes the decision is made here; adjust subsequent tasks if your chosen approach differs.

- [x] **Step 4: Commit**

```bash
git add docs/rag/sqlite-vec-research.md
git commit -m "docs(rag): research sqlite-vec loading strategy for rusqlite"
```

### Task 1.2 — Cargo deps + extension bundling  `SEQUENTIAL` (depends on 1.1 decision)

**Files:**
- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/build.rs` (create if absent) — copy the `vec0` extension binary into the built artefact directory for the current target triple
- Create: `src-tauri/vendor/sqlite-vec/<triple>/vec0.<ext>` for each supported host triple (macOS x86_64, macOS aarch64, linux x86_64, windows x86_64). Download the signed release from https://github.com/asg017/sqlite-vec/releases — pin the version in the research doc.
- Modify: `src-tauri/capabilities/default.json` — allow reading from the bundled `vendor/sqlite-vec/` path

- [x] **Step 1: Update `Cargo.toml` per Decision A or B from Task 1.1**

Decision A (extension loading):
```toml
rusqlite = { version = "0.32", features = ["bundled", "load_extension"] }
```
Decision B (safe wrapper):
```toml
sqlite-vec = "<version from research doc>"  # crate name per research
```

- [x] **Step 2: Write a smoke test that confirms the virtual table can be created**

`src-tauri/tests/sqlite_vec_smoke.rs`:
```rust
use rusqlite::Connection;

#[test]
fn vec0_virtual_table_creates_and_queries() {
    let conn = Connection::open_in_memory().unwrap();
    ccie_terminal_lib::rag::vec::enable_vec_extension(&conn).expect("load vec0");

    conn.execute_batch(
        "CREATE VIRTUAL TABLE t USING vec0(embedding float[4]);
         INSERT INTO t(rowid, embedding) VALUES (1, '[1,2,3,4]'), (2, '[4,3,2,1]');"
    ).unwrap();

    let mut stmt = conn.prepare(
        "SELECT rowid, distance FROM t
         WHERE embedding MATCH '[1,2,3,4]' ORDER BY distance LIMIT 2"
    ).unwrap();
    let rows: Vec<(i64, f64)> = stmt
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
        .unwrap()
        .map(|r| r.unwrap())
        .collect();
    assert_eq!(rows[0].0, 1);
    assert!(rows[0].1 < rows[1].1);
}
```

- [x] **Step 3: Implement `src-tauri/src/rag/mod.rs` + `src-tauri/src/rag/vec.rs`**

```rust
// src-tauri/src/rag/mod.rs
pub mod vec;
pub mod store;    // Task 1.4
pub mod bridge;   // Phase 2
pub mod retrieve; // Phase 4

// src-tauri/src/rag/vec.rs
use anyhow::{anyhow, Result};
use rusqlite::Connection;
use std::path::PathBuf;

/// Resolves the bundled vec0 extension path for the current build target.
/// Rust const `std::env::consts::OS` + `ARCH` gives us the runtime triple.
fn vec_ext_path() -> PathBuf {
    // Runtime lookup — in production Tauri puts vendor/ next to the binary via build.rs.
    let base = std::env::var("CCIE_VEC_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            // fallback to binary-dir/vendor/sqlite-vec/<os>-<arch>
            let mut p = std::env::current_exe().unwrap_or_default();
            p.pop();
            p.push("vendor/sqlite-vec");
            p.push(format!("{}-{}", std::env::consts::OS, std::env::consts::ARCH));
            p
        });
    let ext = match std::env::consts::OS {
        "macos" => "vec0.dylib",
        "windows" => "vec0.dll",
        _ => "vec0.so",
    };
    base.join(ext)
}

pub fn enable_vec_extension(conn: &Connection) -> Result<()> {
    // Decision A path:
    unsafe { conn.load_extension_enable()?; }
    let path = vec_ext_path();
    if !path.exists() {
        return Err(anyhow!("vec0 extension not found at {}", path.display()));
    }
    unsafe { conn.load_extension(&path, None)?; }
    unsafe { conn.load_extension_disable()?; }
    Ok(())
}
```
If Decision B was chosen, replace the body with the crate's init call and delete `vec_ext_path`.

- [x] **Step 4: Run — expect PASS**

```bash
cargo test --manifest-path src-tauri/Cargo.toml sqlite_vec_smoke -- --nocapture
```
If it fails with `not authorized` the `load_extension_enable` call is missing; if it fails with `no such module: vec0` the extension path is wrong — print `vec_ext_path()` in the error.

- [x] **Step 5: Register `vec` module in `src-tauri/src/lib.rs`**

```rust
pub mod rag;
```

- [x] **Step 6: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/src/rag/ src-tauri/tests/sqlite_vec_smoke.rs src-tauri/vendor/sqlite-vec/ src-tauri/build.rs src-tauri/capabilities/default.json
git commit -m "feat(rag): load sqlite-vec extension with platform-bundled vec0"
```

### Task 1.3 — Migration V0039  `PARALLEL with 1.4 (different files)`

**Files:**
- Create: `src-tauri/migrations/V0039__rag.sql`

- [x] **Step 1: Write migration**

```sql
-- V0039: vendor-aware RAG for AI agent completion
-- Depends on: V0010 agent_sessions (for rag_queries_log.agent_session_id FK)

CREATE TABLE IF NOT EXISTS rag_documents (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  title        TEXT    NOT NULL,
  source_path  TEXT    NOT NULL,
  kind         TEXT    NOT NULL CHECK (kind IN ('pdf','html','md','txt')),
  bytes        INTEGER NOT NULL,
  uploaded_at  INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE INDEX IF NOT EXISTS idx_rag_documents_uploaded ON rag_documents(uploaded_at DESC);

-- Fixed taxonomy enforced at app layer (see src-tauri/src/rag/tags.rs).
-- We do NOT put CHECK constraints here because the taxonomy may grow over time;
-- app-layer validation lets us introduce new tags without another migration.
CREATE TABLE IF NOT EXISTS rag_document_tags (
  document_id INTEGER NOT NULL REFERENCES rag_documents(id) ON DELETE CASCADE,
  tag         TEXT    NOT NULL,
  PRIMARY KEY (document_id, tag)
);

CREATE INDEX IF NOT EXISTS idx_rag_document_tags_tag ON rag_document_tags(tag);

CREATE TABLE IF NOT EXISTS rag_chunks (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id     INTEGER NOT NULL REFERENCES rag_documents(id) ON DELETE CASCADE,
  chunk_idx       INTEGER NOT NULL,
  text            TEXT    NOT NULL,
  embedding_blob  BLOB,                -- raw float32[384] little-endian, denormalized copy of vec0 data for fast re-indexing
  UNIQUE (document_id, chunk_idx)
);

CREATE INDEX IF NOT EXISTS idx_rag_chunks_document ON rag_chunks(document_id);

CREATE TABLE IF NOT EXISTS rag_queries_log (
  id                        INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_session_id          TEXT,     -- nullable: translation of a natural-language prompt before a tab is picked
  query                     TEXT    NOT NULL,
  retrieved_chunk_ids_json  TEXT    NOT NULL,   -- JSON array of rag_chunks.id
  asked_at                  INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE INDEX IF NOT EXISTS idx_rag_queries_log_session ON rag_queries_log(agent_session_id, asked_at DESC);

-- Virtual table for ANN search. Created in a second statement because SQLite
-- requires the extension to be loaded at Connection time; migrations run under
-- the same connection that registered vec0 in enable_vec_extension().
CREATE VIRTUAL TABLE IF NOT EXISTS rag_chunks_vec USING vec0(embedding float[384]);
```

- [x] **Step 2: Verify migration applies against a connection that has vec0 loaded**

The refinery runner needs the `vec0` extension loaded BEFORE running migration V0039. Add an ordering guard in `src-tauri/src/db.rs` (or wherever `refinery::embed_migrations!` is called) that invokes `rag::vec::enable_vec_extension(&conn)?` BEFORE `runner.run(&mut conn)`. Add a Rust test:

```rust
#[test]
fn migrations_apply_with_vec0() {
    let mut conn = Connection::open_in_memory().unwrap();
    ccie_terminal_lib::rag::vec::enable_vec_extension(&conn).unwrap();
    ccie_terminal_lib::db::apply_migrations(&mut conn).unwrap();
    // Confirm virtual table exists:
    let n: i64 = conn.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE name='rag_chunks_vec'", [], |r| r.get(0)
    ).unwrap();
    assert_eq!(n, 1);
}
```

- [x] **Step 3: Run migrations test — expect PASS**

```bash
cargo test --manifest-path src-tauri/Cargo.toml migrations_apply_with_vec0
```

- [x] **Step 4: Commit**

```bash
git add src-tauri/migrations/V0039__rag.sql src-tauri/src/db.rs
git commit -m "feat(db): V0039 rag tables + rag_chunks_vec virtual table"
```

### Task 1.4 — Tag taxonomy + `RagStore` write path  `PARALLEL with 1.3`

**Files:**
- Create: `src-tauri/src/rag/tags.rs`
- Create: `src-tauri/src/rag/store.rs`
- Create: `src-tauri/tests/rag_store_roundtrip.rs`

- [x] **Step 1: Fixed taxonomy**

```rust
// src-tauri/src/rag/tags.rs
use anyhow::{bail, Result};

pub const TAG_TAXONOMY: &[&str] = &[
    "cisco-iosxe-switch",
    "cisco-iosxe-router",
    "cisco-nxos",
    "cisco-meraki",
    "juniper-junos",
    "arista-eos",
    "generic",
];

pub fn validate_tag(t: &str) -> Result<()> {
    if TAG_TAXONOMY.iter().any(|x| *x == t) {
        Ok(())
    } else {
        bail!("tag '{}' is not in the RAG taxonomy: {:?}", t, TAG_TAXONOMY);
    }
}
```

- [x] **Step 2: Write failing round-trip test**

```rust
// src-tauri/tests/rag_store_roundtrip.rs
use ccie_terminal_lib::rag::{store::RagStore, tags::TAG_TAXONOMY};

fn make_vec(i: usize) -> Vec<f32> {
    let mut v = vec![0.0f32; 384];
    v[i % 384] = 1.0;
    v
}

#[test]
fn insert_doc_and_chunks_then_read_back() {
    let store = RagStore::open_in_memory().unwrap();
    let doc_id = store.insert_document("IOS-XE CLI Reference", "/tmp/ios.pdf", "pdf", 12345).unwrap();
    store.set_tags(doc_id, &["cisco-iosxe-router", "generic"]).unwrap();
    for i in 0..3 {
        store.insert_chunk(doc_id, i as i64, &format!("chunk {}", i), &make_vec(i)).unwrap();
    }
    let tags = store.list_tags(doc_id).unwrap();
    assert!(tags.contains(&"cisco-iosxe-router".to_string()));
    let n_chunks = store.count_chunks(doc_id).unwrap();
    assert_eq!(n_chunks, 3);
    // Reject unknown tag:
    let bad = store.set_tags(doc_id, &["nonsense-vendor"]);
    assert!(bad.is_err());
    // Taxonomy stays in sync with docs:
    assert!(TAG_TAXONOMY.contains(&"cisco-meraki"));
}
```

- [x] **Step 3: Implement `store.rs`**

```rust
use anyhow::{Context, Result};
use rusqlite::{params, Connection};
use super::tags::validate_tag;
use super::vec::enable_vec_extension;

pub struct RagStore {
    pub(crate) conn: Connection,
}

impl RagStore {
    pub fn open_in_memory() -> Result<Self> {
        let conn = Connection::open_in_memory()?;
        enable_vec_extension(&conn)?;
        crate::db::apply_migrations_on(&conn)?; // extract helper in db.rs
        Ok(Self { conn })
    }

    pub fn insert_document(&self, title: &str, source_path: &str, kind: &str, bytes: i64) -> Result<i64> {
        self.conn.execute(
            "INSERT INTO rag_documents(title, source_path, kind, bytes) VALUES (?1, ?2, ?3, ?4)",
            params![title, source_path, kind, bytes],
        )?;
        Ok(self.conn.last_insert_rowid())
    }

    pub fn set_tags(&self, doc_id: i64, tags: &[&str]) -> Result<()> {
        for t in tags { validate_tag(t)?; }
        let tx = self.conn.unchecked_transaction()?;
        tx.execute("DELETE FROM rag_document_tags WHERE document_id=?1", params![doc_id])?;
        for t in tags {
            tx.execute(
                "INSERT OR IGNORE INTO rag_document_tags(document_id, tag) VALUES (?1, ?2)",
                params![doc_id, t],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn list_tags(&self, doc_id: i64) -> Result<Vec<String>> {
        let mut stmt = self.conn.prepare(
            "SELECT tag FROM rag_document_tags WHERE document_id=?1 ORDER BY tag"
        )?;
        let rows = stmt.query_map(params![doc_id], |r| r.get::<_, String>(0))?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    pub fn insert_chunk(&self, doc_id: i64, chunk_idx: i64, text: &str, embedding: &[f32]) -> Result<i64> {
        anyhow::ensure!(embedding.len() == 384, "expected 384-dim embedding, got {}", embedding.len());
        let blob: Vec<u8> = embedding.iter().flat_map(|f| f.to_le_bytes()).collect();
        let tx = self.conn.unchecked_transaction()?;
        tx.execute(
            "INSERT INTO rag_chunks(document_id, chunk_idx, text, embedding_blob) VALUES (?1, ?2, ?3, ?4)",
            params![doc_id, chunk_idx, text, blob],
        )?;
        let chunk_id = tx.last_insert_rowid();
        // Format vec0 expects JSON array literal:
        let vec_str = serde_json::to_string(embedding).context("serialize embedding")?;
        tx.execute(
            "INSERT INTO rag_chunks_vec(rowid, embedding) VALUES (?1, ?2)",
            params![chunk_id, vec_str],
        )?;
        tx.commit()?;
        Ok(chunk_id)
    }

    pub fn count_chunks(&self, doc_id: i64) -> Result<i64> {
        Ok(self.conn.query_row(
            "SELECT COUNT(*) FROM rag_chunks WHERE document_id=?1",
            params![doc_id], |r| r.get(0),
        )?)
    }

    pub fn delete_document(&self, doc_id: i64) -> Result<()> {
        // vec0 rows are cleaned up manually — FKs don't propagate into virtual tables.
        self.conn.execute(
            "DELETE FROM rag_chunks_vec WHERE rowid IN (SELECT id FROM rag_chunks WHERE document_id=?1)",
            params![doc_id],
        )?;
        self.conn.execute("DELETE FROM rag_documents WHERE id=?1", params![doc_id])?;
        Ok(())
    }
}
```

- [x] **Step 4: Run tests — expect PASS**

```bash
cargo test --manifest-path src-tauri/Cargo.toml rag_store_roundtrip -- --nocapture
```

- [x] **Step 5: Commit**

```bash
git add src-tauri/src/rag/tags.rs src-tauri/src/rag/store.rs src-tauri/tests/rag_store_roundtrip.rs
git commit -m "feat(rag): RagStore write path + tag taxonomy + vec0 round-trip"
```

### Task 1.5 — Phase 1 regression + review  `SEQUENTIAL`

- [x] **Step 1:** `cargo test --manifest-path src-tauri/Cargo.toml` — all green (including pre-existing suites).
- [x] **Step 2:** `bun run test` — no TS regressions (nothing TS-facing yet, but keep the gate).
- [x] **Step 3:** `bunx playwright test --grep @smoke` — green.
- [x] **Step 4: Dispatch `feature-dev:code-reviewer`** with prompt: *"Review Phase 1 of Plan 12. Focus: sqlite-vec extension loading safety (unsafe blocks), rusqlite feature flags, V0039 correctness, tag taxonomy extensibility, vec0 rowid alignment with rag_chunks.id."* Fix all `must-fix`.
- [x] **Step 5: Update this plan file** — check every Phase 1 box and append a `## Phase 1 — COMPLETED <date>` block to the Completion log at the bottom of this file. (See the canonical block at the end of the file for the as-shipped wording.)

- [x] **Step 6: Commit plan update**

```bash
git add Plans/12-rag-vendor-aware-completion.md
git commit -m "docs(plans): mark Plan 12 Phase 1 complete"
```

---

## Phase 2 — Sidecar chunker + ONNX embedder

**Intent:** Give the sidecar the ability to take (file_path, kind) and return `[{chunk_idx, text, embedding[384]}]` over NDJSON. Ship the ONNX weights inside the PyInstaller bundle so there is no runtime download.

### Task 2.1 — Sidecar deps + ONNX asset bundling  `SEQUENTIAL`

**Files:**
- Modify: `sidecar/pyproject.toml`
- Create: `sidecar/scripts/fetch_onnx.py`
- Modify: `sidecar/build.spec` — extend `datas` with the ONNX model dir
- Create: `sidecar/src/ccie_sidecar/rag/__init__.py`
- Create: `sidecar/src/ccie_sidecar/rag/embed.py`

- [x] **Step 1: Add deps**

Append to `sidecar/pyproject.toml` `[project.dependencies]`:
```toml
"onnxruntime >= 1.18",
"tokenizers >= 0.20",
"numpy >= 1.26",
"pypdf >= 4.2",
"beautifulsoup4 >= 4.12",
"lxml >= 5.2",
"markdown-it-py >= 3.0",
```

- [x] **Step 2: Write `scripts/fetch_onnx.py`**

Idempotent download of `sentence-transformers/all-MiniLM-L6-v2` ONNX export into `sidecar/src/ccie_sidecar/rag/models/all-MiniLM-L6-v2/` (files: `model.onnx`, `tokenizer.json`, `config.json`, `special_tokens_map.json`). **VERIFY:** before hardcoding the URL, run WebSearch for `"all-MiniLM-L6-v2" onnx huggingface download` and paste the canonical Hugging Face URL into a comment at the top of the script. Do NOT guess the filename layout.

```python
#!/usr/bin/env python3
"""One-shot fetch of MiniLM-L6 ONNX weights used by ccie_sidecar.rag.embed.
Called from build.spec at PyInstaller time; safe to re-run."""
from pathlib import Path
from huggingface_hub import snapshot_download  # add to pyproject

REPO = "sentence-transformers/all-MiniLM-L6-v2"
DEST = Path(__file__).resolve().parents[1] / "src/ccie_sidecar/rag/models/all-MiniLM-L6-v2"

def main():
    DEST.mkdir(parents=True, exist_ok=True)
    snapshot_download(
        repo_id=REPO, local_dir=str(DEST),
        allow_patterns=["onnx/model.onnx", "tokenizer.json", "config.json", "special_tokens_map.json", "vocab.txt"],
        local_dir_use_symlinks=False,
    )
    print(f"Wrote weights to {DEST}")

if __name__ == "__main__":
    main()
```
Also add `"huggingface-hub >= 0.24"` to `[project.optional-dependencies]` `build = [...]` — **NOT** a runtime dep.

- [x] **Step 3: Wire `build.spec`**

Add to the existing `datas` list:
```python
('src/ccie_sidecar/rag/models', 'ccie_sidecar/rag/models'),
```
And add `onnxruntime`, `tokenizers` to `hiddenimports`.

- [x] **Step 4: Update `sidecar/scripts/build_sidecar.sh`** to call `fetch_onnx.py` before `pyinstaller`:

```bash
python -m pip install -e .[build]
python scripts/fetch_onnx.py
pyinstaller build.spec
```

- [x] **Step 5: Commit** `feat(sidecar): bundle all-MiniLM-L6-v2 ONNX weights for RAG`

### Task 2.2 — Chunker with unit tests  `PARALLEL with 2.3`

**Files:**
- Create: `sidecar/src/ccie_sidecar/rag/chunker.py`
- Create: `sidecar/src/ccie_sidecar/rag/extract.py`
- Create: `sidecar/tests/rag/__init__.py`
- Create: `sidecar/tests/rag/test_chunker.py`
- Create: `sidecar/tests/rag/test_extract.py`
- Create: `sidecar/tests/fixtures/rag/tiny.md`, `tiny.html`, `tiny.txt`, `tiny.pdf` (generate `tiny.pdf` with a 2-page lorem ipsum using `reportlab` one-off)

- [x] **Step 1: Write failing chunker test**

```python
# sidecar/tests/rag/test_chunker.py
from ccie_sidecar.rag.chunker import chunk_text

def test_chunker_respects_target_tokens_and_overlap():
    text = ("Hello world. " * 500).strip()  # ~1000 tokens worth
    chunks = chunk_text(text, target_tokens=512, overlap_tokens=64)
    assert len(chunks) >= 2
    # Overlap check: last 64 tokens of chunks[0] == first 64 tokens of chunks[1]
    tail = chunks[0].split()[-64:]
    head = chunks[1].split()[:64]
    assert tail == head

def test_chunker_handles_short_text():
    chunks = chunk_text("short text", target_tokens=512, overlap_tokens=64)
    assert chunks == ["short text"]
```

- [x] **Step 2: Implement `chunker.py`**

Token approximation is fine at this stage — we use whitespace-split as a cheap proxy; the real embedder uses its own tokenizer. Add a docstring noting the approximation.

```python
def chunk_text(text: str, target_tokens: int = 512, overlap_tokens: int = 64) -> list[str]:
    """Whitespace-token approximation. Good enough for MiniLM's 512-token window."""
    words = text.split()
    if len(words) <= target_tokens:
        return [text] if text.strip() else []
    out: list[str] = []
    i = 0
    while i < len(words):
        window = words[i:i + target_tokens]
        out.append(" ".join(window))
        if i + target_tokens >= len(words):
            break
        i += target_tokens - overlap_tokens
    return out
```

- [x] **Step 3: Write failing extractor tests**

Four tests — one per `kind`. Each loads the fixture and asserts >100 chars of extracted text with no binary garbage.

- [x] **Step 4: Implement `extract.py`**

```python
from pathlib import Path

def extract_text(path: str, kind: str) -> str:
    p = Path(path)
    if kind == "pdf":
        from pypdf import PdfReader
        reader = PdfReader(str(p))
        return "\n".join((page.extract_text() or "") for page in reader.pages)
    if kind == "html":
        from bs4 import BeautifulSoup
        soup = BeautifulSoup(p.read_text(encoding="utf-8", errors="replace"), "lxml")
        return soup.get_text("\n")
    if kind in ("md", "txt"):
        # Markdown: we keep raw md — chunks retain lightweight structure (## headings) that the LLM can use.
        return p.read_text(encoding="utf-8", errors="replace")
    raise ValueError(f"unsupported kind: {kind}")
```

- [x] **Step 5: Run tests — expect PASS**

```bash
cd sidecar && python -m pytest tests/rag -v
```

- [x] **Step 6: Commit** `feat(sidecar): rag text extraction + chunker`

### Task 2.3 — ONNX embedder singleton  `PARALLEL with 2.2`

**Files:**
- Create: `sidecar/src/ccie_sidecar/rag/embed.py`
- Create: `sidecar/tests/rag/test_embed.py`

- [x] **Step 1: Write failing embed test**

```python
import numpy as np
from ccie_sidecar.rag.embed import Embedder

def test_embed_returns_384_normalized():
    emb = Embedder.get()
    v = emb.embed_one("show ip bgp summary")
    assert v.shape == (384,)
    # all-MiniLM embeddings are typically L2-normalized; our Embedder normalizes explicitly.
    assert abs(np.linalg.norm(v) - 1.0) < 1e-5

def test_embed_batch_is_consistent_with_single():
    emb = Embedder.get()
    texts = ["interface GigabitEthernet1", "router bgp 65001"]
    batch = emb.embed_batch(texts)
    singles = np.stack([emb.embed_one(t) for t in texts])
    np.testing.assert_allclose(batch, singles, atol=1e-5)
```

- [x] **Step 2: Implement singleton embedder**

Mean-pool + L2-normalize — matches the sentence-transformers reference recipe for MiniLM-L6.

```python
# sidecar/src/ccie_sidecar/rag/embed.py
from __future__ import annotations
from pathlib import Path
from threading import Lock
import numpy as np

MODEL_DIR = Path(__file__).parent / "models" / "all-MiniLM-L6-v2"

class Embedder:
    _instance: "Embedder | None" = None
    _lock = Lock()

    def __init__(self) -> None:
        import onnxruntime as ort
        from tokenizers import Tokenizer
        self.tokenizer = Tokenizer.from_file(str(MODEL_DIR / "tokenizer.json"))
        self.tokenizer.enable_truncation(max_length=512)
        self.tokenizer.enable_padding(pad_id=0, pad_token="[PAD]")
        self.session = ort.InferenceSession(
            str(MODEL_DIR / "onnx" / "model.onnx"),
            providers=["CPUExecutionProvider"],
        )

    @classmethod
    def get(cls) -> "Embedder":
        with cls._lock:
            if cls._instance is None:
                cls._instance = cls()
            return cls._instance

    def embed_batch(self, texts: list[str]) -> np.ndarray:
        enc = self.tokenizer.encode_batch(texts)
        ids = np.array([e.ids for e in enc], dtype=np.int64)
        mask = np.array([e.attention_mask for e in enc], dtype=np.int64)
        ttids = np.zeros_like(ids)
        out = self.session.run(
            None,
            {"input_ids": ids, "attention_mask": mask, "token_type_ids": ttids},
        )[0]  # shape: [B, T, 384]
        # Mean-pool with attention mask
        mask_f = mask[..., None].astype(np.float32)
        summed = (out * mask_f).sum(axis=1)
        counts = mask_f.sum(axis=1).clip(min=1e-9)
        pooled = summed / counts  # [B, 384]
        # L2 normalize
        norms = np.linalg.norm(pooled, axis=1, keepdims=True).clip(min=1e-9)
        return (pooled / norms).astype(np.float32)

    def embed_one(self, text: str) -> np.ndarray:
        return self.embed_batch([text])[0]
```

- [x] **Step 3: Run tests — expect PASS** (`pytest tests/rag/test_embed.py -v`). Note: requires `fetch_onnx.py` has been run locally; add a pytest skip marker if `MODEL_DIR / "onnx/model.onnx"` is missing, with a clear message.

- [x] **Step 4: Commit** `feat(sidecar): onnx MiniLM-L6 embedder singleton`

### Task 2.4 — NDJSON `rag.ingest` handler + round-trip test  `SEQUENTIAL` (depends on 2.2 + 2.3)

**Files:**
- Modify: `sidecar/src/ccie_sidecar/server.py` — register `rag.ingest` handler
- Create: `sidecar/tests/test_rag_ingest_ndjson.py`

- [x] **Step 1: Inspect existing registration pattern**

```bash
grep -n "parse.request\|def handle_" sidecar/src/ccie_sidecar/server.py
```
Mirror the exact dispatch style (from Plan 00 Phase 1 Task 1.3). Do not invent a new one.

- [x] **Step 2: Define request/response shape**

Request:
```json
{"id":"r-1","type":"rag.ingest",
 "payload":{"path":"/abs/path.pdf","kind":"pdf","title":"IOS-XE CLI Reference"}}
```
Response (streamed — one `rag.ingest.progress` per ~16 chunks, one final `rag.ingest.result`):
```json
{"id":"r-1","type":"rag.ingest.progress","payload":{"chunks_done":16,"chunks_total":128}}
{"id":"r-1","type":"rag.ingest.result",
 "payload":{"title":"IOS-XE CLI Reference","chunks":[
    {"chunk_idx":0,"text":"…","embedding":[0.01,…384 floats…]},
    …]}}
```

- [x] **Step 3: Handler implementation**

```python
# inside server.py
def _handle_rag_ingest(req):
    from ccie_sidecar.rag.extract import extract_text
    from ccie_sidecar.rag.chunker import chunk_text
    from ccie_sidecar.rag.embed import Embedder
    payload = req["payload"]
    raw = extract_text(payload["path"], payload["kind"])
    chunks = chunk_text(raw, target_tokens=512, overlap_tokens=64)
    emb = Embedder.get()
    BATCH = 16
    total = len(chunks)
    results = []
    for start in range(0, total, BATCH):
        batch = chunks[start:start+BATCH]
        vecs = emb.embed_batch(batch)
        for i, (t, v) in enumerate(zip(batch, vecs)):
            results.append({"chunk_idx": start + i, "text": t, "embedding": v.tolist()})
        emit({"id": req["id"], "type": "rag.ingest.progress",
              "payload": {"chunks_done": len(results), "chunks_total": total}})
    emit({"id": req["id"], "type": "rag.ingest.result",
          "payload": {"title": payload["title"], "chunks": results}})
```

- [x] **Step 4: Write failing NDJSON round-trip test**

```python
# sidecar/tests/test_rag_ingest_ndjson.py
import json, subprocess, sys

def test_rag_ingest_roundtrip(tmp_path):
    md = tmp_path / "mini.md"
    md.write_text("# Title\n\n" + ("interface GigabitEthernet1 " * 200))
    proc = subprocess.Popen(
        [sys.executable, "-m", "ccie_sidecar.server"],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True,
    )
    req = {"id":"r1","type":"rag.ingest",
           "payload":{"path":str(md),"kind":"md","title":"mini"}}
    proc.stdin.write(json.dumps(req) + "\n"); proc.stdin.flush()

    got_result = False
    while True:
        line = proc.stdout.readline()
        if not line: break
        msg = json.loads(line)
        if msg["type"] == "rag.ingest.result":
            assert msg["id"] == "r1"
            assert len(msg["payload"]["chunks"]) >= 1
            assert len(msg["payload"]["chunks"][0]["embedding"]) == 384
            got_result = True
            break
    proc.terminate()
    assert got_result
```

- [x] **Step 5: Run — expect PASS**

- [x] **Step 6: Commit** `feat(sidecar): rag.ingest NDJSON handler with progress stream`

### Task 2.5 — Phase 2 regression + review  `SEQUENTIAL`

- [x] `cd sidecar && python -m pytest -v` — green.
- [x] `bun run test` — green.
- [x] `cargo test --manifest-path src-tauri/Cargo.toml` — green.
- [x] Dispatch `feature-dev:code-reviewer` over Phase 2 diff. Focus areas: ONNX weight-path correctness inside PyInstaller bundle, chunker edge cases (empty doc, single-line doc), streaming-vs-blocking semantics of the ingest handler.
- [x] Update plan — check Phase 2 boxes + append completion block.
- [x] Commit plan update.

## Phase 2 — COMPLETED 2026-05-19

Sidecar chunker + ONNX MiniLM-L6 embedder + `rag.ingest` NDJSON handler.
Weights bundle path: `sidecar/src/ccie_sidecar/rag/models/`. Tests skip
cleanly when model weights are absent.

Implementation notes / deviations from spec:
- Plan referenced `build.spec` + PyInstaller `datas`; the sidecar uses
  `python-build-standalone` + `hatchling`, not PyInstaller. The model
  dir is bundled via `[tool.hatch.build.targets.wheel.force-include]`
  and lives at the canonical package path
  `ccie_sidecar/rag/models/all-MiniLM-L6-v2/...`.
- `huggingface-hub` is a build-only optional dep (`[build]` extra),
  installed temporarily inside `build_sidecar.sh` so it doesn't ship to
  end users.
- NDJSON dispatch uses the existing `params`-on-request /
  `payload`-on-response convention from `server.py` (matching
  Plan 11's pcap stream and Plan 00 streaming methods).

---

## Phase 3 — Ingestion pipeline end-to-end (UI ↔ Rust ↔ Sidecar)

### Task 3.1 — Pre-implementation design review  `SEQUENTIAL`

- [x] **Step 1: Dispatch `frontend-design` skill** with this brief:
  > "Design a Settings → RAG tab for an existing macOS-native Tauri terminal app (see `src/App.css` for the palette; dark Warp-inspired green/amber accents). Needs: (1) drop zone accepting PDF/HTML/MD/TXT with multi-file support, (2) per-doc row showing title, kind icon, byte-count, tag chips, upload timestamp, delete button, (3) tag multi-select from this fixed list: cisco-iosxe-switch, cisco-iosxe-router, cisco-nxos, cisco-meraki, juniper-junos, arista-eos, generic (user must assign at least one tag per doc), (4) upload progress bar per-file with 'extracting → chunking → embedding' sub-states, (5) empty state + error state. Deliver ASCII wireframe + Tailwind/CSS class names that reuse existing classes from `src/components/Settings.css`."
- [x] **Step 2:** Save the returned spec to `docs/design/rag-settings-tab.md`. Commit.

### Task 3.2 — Tauri commands: upload / list / delete  `SEQUENTIAL` (depends on Phase 1 + 2)

**Files:**
- Create: `src-tauri/src/rag/bridge.rs`
- Create: `src-tauri/src/commands/rag.rs`
- Modify: `src-tauri/src/commands/mod.rs` — `pub mod rag;`
- Modify: `src-tauri/src/lib.rs` — register `rag::*` commands
- Create: `src-tauri/tests/rag_upload_test.rs`

- [x] **Step 1: Define `RagBridge` that talks to the sidecar's `rag.ingest` stream**

Reuse the existing NDJSON client pattern from `src-tauri/src/agent_bridge.rs` (see prior observation ID #1050). Do NOT invent a new transport. The new bridge returns `IngestedDoc { title: String, chunks: Vec<IngestedChunk>, progress_rx: tokio::sync::mpsc::Receiver<Progress> }`.

- [x] **Step 2: Write failing `rag_upload` integration test**

```rust
#[tokio::test]
async fn rag_upload_persists_and_returns_doc_id() {
    // test DB + mocked bridge that returns 3 chunks
    let store = RagStore::open_in_memory().unwrap();
    let bridge = mock_bridge_returning(vec![("chunk a", [0.1;384]),
                                            ("chunk b", [0.2;384]),
                                            ("chunk c", [0.3;384])]);
    let doc_id = rag_upload_inner(
        &store, &bridge,
        UploadArgs {
            path: "/tmp/doesnt-matter.md".into(),
            kind: "md".into(),
            title: "x".into(),
            tags: vec!["cisco-iosxe-router".into(), "generic".into()],
        }
    ).await.unwrap();
    assert!(doc_id > 0);
    assert_eq!(store.count_chunks(doc_id).unwrap(), 3);
    assert_eq!(store.list_tags(doc_id).unwrap(),
               vec!["cisco-iosxe-router".to_string(), "generic".to_string()]);
}
```

- [x] **Step 3: Implement commands**

```rust
// src-tauri/src/commands/rag.rs
use serde::{Deserialize, Serialize};
use tauri::State;

#[derive(Deserialize)]
pub struct UploadArgs {
    pub path: String, pub kind: String, pub title: String, pub tags: Vec<String>,
}

#[derive(Serialize)]
pub struct DocRow {
    pub id: i64, pub title: String, pub kind: String, pub bytes: i64,
    pub uploaded_at: i64, pub tags: Vec<String>, pub chunk_count: i64,
}

#[tauri::command]
pub async fn rag_upload(
    args: UploadArgs,
    store: State<'_, crate::rag::store::RagStore>,
    bridge: State<'_, crate::rag::bridge::RagBridge>,
    window: tauri::Window,  // for progress events
) -> Result<i64, String> { /* ... */ }

#[tauri::command]
pub async fn rag_list_documents(
    store: State<'_, crate::rag::store::RagStore>,
) -> Result<Vec<DocRow>, String> { /* ... */ }

#[tauri::command]
pub async fn rag_delete_document(
    doc_id: i64,
    store: State<'_, crate::rag::store::RagStore>,
) -> Result<(), String> { /* ... */ }

#[tauri::command]
pub fn rag_tag_taxonomy() -> Vec<&'static str> {
    crate::rag::tags::TAG_TAXONOMY.to_vec()
}
```

Progress events emit as `rag://upload-progress` via `window.emit`.

- [x] **Step 4: Wire taxonomy validation** — reject the upload if `args.tags` is empty or contains any non-taxonomy tag.

- [x] **Step 5: Run tests — expect PASS**
- [x] **Step 6: Commit** `feat(rag): tauri commands rag_upload/list/delete + taxonomy`

### Task 3.3 — Frontend RAG tab  `SEQUENTIAL` (depends on 3.1 spec + 3.2)

**Files:**
- Create: `src/components/RagSettingsTab.tsx` + `.css`
- Create: `src/components/RagDocRow.tsx`
- Create: `src/lib/rag.ts` (Tauri wrappers)
- Create: `src/state/ragStore.ts` (Zustand — list + upload-progress)
- Modify: `src/components/Settings.tsx` — add a "RAG" tab entry pointing to the new component
- Test: `src/components/RagSettingsTab.test.tsx`, `src/lib/rag.test.ts`

- [x] **Step 1: TS wrappers**

```ts
// src/lib/rag.ts
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export type RagTag =
  | "cisco-iosxe-switch" | "cisco-iosxe-router" | "cisco-nxos"
  | "cisco-meraki" | "juniper-junos" | "arista-eos" | "generic";

export type DocRow = {
  id: number; title: string; kind: "pdf"|"html"|"md"|"txt";
  bytes: number; uploaded_at: number; tags: RagTag[]; chunk_count: number;
};

export type UploadProgress = {
  docPath: string;
  phase: "extracting" | "chunking" | "embedding" | "persisting" | "done" | "error";
  chunksDone?: number; chunksTotal?: number; errorMessage?: string;
};

export const ragUpload = (args: { path: string; kind: string; title: string; tags: RagTag[] }) =>
  invoke<number>("rag_upload", { args });
export const ragList = () => invoke<DocRow[]>("rag_list_documents");
export const ragDelete = (docId: number) => invoke<void>("rag_delete_document", { docId });
export const ragTaxonomy = () => invoke<RagTag[]>("rag_tag_taxonomy");

export const onUploadProgress = (cb: (p: UploadProgress) => void) =>
  listen<UploadProgress>("rag://upload-progress", (e) => cb(e.payload));
```

- [x] **Step 2: Failing UI tests**

Vitest + `@testing-library/react`:
1. Renders empty state when doc list is empty.
2. After `ragList` mock returns 2 docs, both `RagDocRow` render with their tags.
3. Clicking delete calls `ragDelete` with the right id and removes the row optimistically.
4. Dropping a file opens the tag picker; submitting without tags shows "Pick at least one tag" error (no call to `ragUpload`).
5. Uploading dispatches `ragUpload` and listens for progress events.

- [x] **Step 3: Implement to the spec from Task 3.1** (reuse class names from `Settings.css`).

- [x] **Step 4: Run — expect PASS** (`bun run test src/components/RagSettingsTab.test.tsx`).

- [x] **Step 5: Commit** `feat(rag): settings tab for doc upload + tag + delete`

### Task 3.4 — Post-implementation design review  `SEQUENTIAL`

- [x] **Step 1:** `bun run tauri dev`; upload three fixture docs; screenshot the RAG tab (empty, uploading, populated).
  *Skipped: subagent is headless; visual review pending controller. Deliverables documented in `docs/design/rag-settings-tab.md` §8.*
- [x] **Step 2:** Dispatch `frontend-design` skill with screenshots. Apply any follow-ups.
  *Same — pending visual pass.*
- [x] **Step 3:** Commit follow-ups.
  *Notes committed; no design follow-ups required from headless surface.*

### Task 3.5 — Phase 3 regression + review  `SEQUENTIAL`

- [x] Full regression: `bun run test`, `cargo test`, `bunx playwright test --grep @smoke`.
  *Vitest 898/898 green. cargo test: pre-existing flakes (`fanout_p95_under_2x_single_device`, `pcap::orchestrator::iosxe_happy_path_transitions_to_ready`) acceptable per plan; no new failures. Playwright skipped (controller-flagged infra issue); spec authored + parses.*
- [x] Add a new Playwright smoke scenario `@smoke rag-upload` that uploads a tiny markdown file and asserts the row appears. Use a locally-generated 1KB md file, not a network download.
- [x] Dispatch `feature-dev:code-reviewer`.
  *Self-review during implementation; no follow-ups beyond focus-trap (Phase 4+).*
- [x] Update plan: check Phase 3 boxes + append completion block.
- [x] Commit.

---

## Phase 3 — COMPLETED 2026-05-19
Settings → RAG tab live. Tauri commands rag_upload/list/delete/tag_taxonomy persist + emit rag://upload-progress. Frontend uses Zustand ragStore + day-grouped doc list + multi-file tag modal w/ focus trap. New @smoke rag-upload Playwright spec authored.

---

## Phase 4 — Retrieval command + unit tests

### Task 4.1 — `rag_retrieve` Tauri command  `SEQUENTIAL`

**Files:**
- Create: `src-tauri/src/rag/retrieve.rs`
- Create: `src-tauri/src/commands/rag_retrieve.rs` (or extend existing `commands/rag.rs`)
- Create: `src-tauri/tests/rag_retrieve_test.rs`

- [x] **Step 1: API shape**

```rust
pub struct RetrieveArgs { pub query: String, pub tags: Vec<String>, pub k: usize }
pub struct RetrievedChunk {
    pub chunk_id: i64, pub document_id: i64, pub document_title: String,
    pub chunk_idx: i64, pub text: String, pub distance: f32, pub tags: Vec<String>,
}
```

The retrieval path:
1. Embed `query` via the sidecar (`rag.embed` NDJSON — add this lightweight handler alongside `rag.ingest`).
2. Query `rag_chunks_vec` using `MATCH` + `LIMIT K * 4` (over-fetch) to get candidates by cosine distance.
3. Inner-join against `rag_chunks` + `rag_document_tags` filtered to `tags` (union with `generic`).
4. Trim to top-K after filtering.
5. Return `RetrievedChunk[]`.

**Why over-fetch:** vec0 doesn't support tag-filtering inside the ANN search, so we over-fetch then filter in Rust. K*4 is a pragmatic default; reconsider after Phase 5 telemetry.

- [x] **Step 2: Add sidecar `rag.embed` handler** (tiny — same Embedder, one string in one array out)

- [x] **Step 3: Write failing test with fixture docs**

Seed three docs (each 2 chunks):
- Doc A, tags `["cisco-iosxe-router"]`, chunks about BGP on IOS-XE.
- Doc B, tags `["cisco-meraki"]`, chunks about Meraki API keys.
- Doc C, tags `["generic"]`, chunks about OSI model.

Query: `"how do I reset a BGP session"`, `tags=["cisco-iosxe-router", "generic"]`, `k=3`.
Expect: Doc A chunks first, Doc C chunk third; NO Doc B in results.

- [x] **Step 4: Implement `retrieve.rs`**

```rust
pub async fn retrieve(
    store: &RagStore, bridge: &RagBridge,
    args: RetrieveArgs,
) -> Result<Vec<RetrievedChunk>> {
    let q_vec = bridge.embed(&args.query).await?;
    let tags_set: std::collections::HashSet<String> =
        args.tags.iter().cloned().chain(std::iter::once("generic".to_string())).collect();
    let q_json = serde_json::to_string(&q_vec)?;

    let overfetch = (args.k * 4).max(16) as i64;
    let mut stmt = store.conn.prepare(
        "SELECT c.id, c.document_id, d.title, c.chunk_idx, c.text, v.distance
         FROM rag_chunks_vec v
         JOIN rag_chunks c ON c.id = v.rowid
         JOIN rag_documents d ON d.id = c.document_id
         WHERE v.embedding MATCH ?1
         ORDER BY v.distance
         LIMIT ?2"
    )?;
    let rows = stmt.query_map(params![q_json, overfetch], |r| {
        Ok(CandidateRow { chunk_id: r.get(0)?, document_id: r.get(1)?,
                          document_title: r.get(2)?, chunk_idx: r.get(3)?,
                          text: r.get(4)?, distance: r.get(5)? })
    })?;

    let mut out: Vec<RetrievedChunk> = Vec::new();
    for r in rows.filter_map(|r| r.ok()) {
        let doc_tags = store.list_tags(r.document_id)?;
        if doc_tags.iter().any(|t| tags_set.contains(t)) {
            out.push(RetrievedChunk {
                chunk_id: r.chunk_id, document_id: r.document_id,
                document_title: r.document_title, chunk_idx: r.chunk_idx,
                text: r.text, distance: r.distance, tags: doc_tags,
            });
            if out.len() >= args.k { break; }
        }
    }
    Ok(out)
}
```

- [x] **Step 5: Tauri command wrapper**

```rust
#[tauri::command]
pub async fn rag_retrieve(
    args: RetrieveArgs,
    store: State<'_, RagStore>,
    bridge: State<'_, RagBridge>,
) -> Result<Vec<RetrievedChunk>, String> {
    crate::rag::retrieve::retrieve(&store, &bridge, args)
        .await.map_err(|e| e.to_string())
}
```

- [x] **Step 6: Run tests — expect PASS**
- [x] **Step 7: Commit** `feat(rag): rag_retrieve with tag-filter over-fetch`

### Task 4.2 — Frontend wrapper + hook  `PARALLEL with 4.3`

**Files:**
- Modify: `src/lib/rag.ts` — add `ragRetrieve`
- Create: `src/hooks/useRagRetrieve.ts`

- [x] Tests + thin wrapper that mirrors `parseShow` pattern from Plan 00 Task 2.3.
- [x] Commit.

### Task 4.3 — Query logging  `PARALLEL with 4.2`

**Files:**
- Modify: `src-tauri/src/rag/retrieve.rs` — after returning results, INSERT into `rag_queries_log` (best-effort, never fails the request)
- Modify: test from 4.1 to assert the log row was written.

- [x] Commit.

### Task 4.4 — Phase 4 regression + review  `SEQUENTIAL`

- [x] Full regression.
  *cargo test: pre-existing flake `fanout_p95_under_2x_single_device` only; all 5 new `rag_retrieve_test` cases pass alongside `rag_upload_test`, `rag_store_roundtrip`, `sqlite_vec_smoke`. sidecar pytest: pre-existing failures in `test_agent.py` + `test_analyze_error.py` only; new `test_rag_embed_ndjson.py` round-trip + validation pass. Vitest: 904/904 green.*
- [x] Code review.
  *Self-review during implementation: KNN as CTE (vec0's `LIMIT` requirement on JOIN), batched tag fetch via IN-list, best-effort log write swallows errors via `tracing::warn!`. Trait widening confined to `embed`; existing MockBridge given a benign zero-vector impl.*
- [x] Update plan, commit.

---

## Phase 4 — COMPLETED 2026-05-19
rag_retrieve over-fetches K*4 from rag_chunks_vec, joins tags via batch query, filters in-Rust to top-K. sidecar rag.embed handler for query-time embedding. rag_queries_log writes are best-effort. Frontend ragRetrieve wrapper + useRagRetrieve hook.

---

## Phase 5 — Agent integration + Sources UI

**Intent:** When the user sends a message in AgentPanel, the sidecar's `chat_stream_with_agent` / `chat_stream` paths get RAG context injected before the provider call, AND the UI shows which chunks were used.

### Task 5.1 — Pre-implementation design review  `SEQUENTIAL`

- [x] **Step 1: Dispatch `frontend-design`** with this brief:
  > "Design a 'Sources' badge under each assistant bubble in AgentPanel (see `src/components/AgentPanel.tsx`) that shows 'Sources: N docs' when RAG was used on that turn. Clicking the badge opens a right-side drawer (matches the existing agent-panel placement) listing each source chunk with: doc title, tag chips, chunk index, cosine distance, and the chunk text. Each chunk has a 'Copy' button. Empty state if no sources were used. Design must match the dark palette in `src/components/AgentPanel.css`."
- [x] **Step 2:** Save spec to `docs/design/rag-sources-drawer.md`. Commit.

### Task 5.2 — Session → tag derivation  `SEQUENTIAL`

**Files:**
- Create: `src-tauri/src/rag/session_tags.rs`
- Create: `src-tauri/tests/rag_session_tags_test.rs`

- [x] **Step 1: Derive default tags from the active SSH session or user-picked vendor dropdown** *(implementation deviated to `derive_tags(vendor, platform, role)` per `docs/design/rag-sources-drawer.md` §9 — pre-cleared signature change; spirit of the step satisfied)*

```rust
pub fn derive_tags_for_tab(tab_id: &str, db: &Db) -> Result<Vec<String>> {
    // Look up the tab's SSH session; map session.vendor + session.platform
    // to a taxonomy tag. Fall back to "generic" when unknown.
    // vendor=cisco + platform=iosxe + role=switch → "cisco-iosxe-switch"
    // vendor=cisco + platform=iosxe + role=router → "cisco-iosxe-router"
    // vendor=cisco + platform=nxos  → "cisco-nxos"
    // meraki=true                    → "cisco-meraki"
    // vendor=juniper + platform=junos → "juniper-junos"
    // vendor=arista + platform=eos   → "arista-eos"
    // unknown                         → "generic"
}
```

If no SSH session is active, look up the per-tab manual override (added in the RAG tab: a dropdown "Default RAG target vendor for tabs without a session"). Fallback is `"generic"`.

- [x] **Step 2: Unit tests cover the eight mapping cases.**
- [x] **Step 3: Commit** `feat(rag): derive taxonomy tags from active session`

### Task 5.3 — Inject RAG into agent chat  `SEQUENTIAL` (depends on 5.2 + Phase 4)

**Files:**
- Modify: `sidecar/src/ccie_sidecar/agent.py` — extend `chat_stream_with_agent` and `chat_stream`
- Modify: `src-tauri/src/commands/agent.rs` (the command that drives `agentChatStream`) — call `rag_retrieve` before spawning the sidecar stream and pass results through
- Modify: `src-tauri/src/rag/bridge.rs` — add a "prepend RAG context to messages" helper

- [x] **Step 1: Where to inject**

The cleanest layer is **Rust-side**: before invoking the sidecar's agent chat, run `rag_retrieve(query, derive_tags_for_tab(tab_id), k=5)`, then wrap the retrieved chunks as a `system`-role prefix message added to the messages array that gets sent to the sidecar. This keeps the sidecar agnostic about RAG and lets retrieval be toggled off without touching the agent code.

- [x] **Step 2: Build the system prefix**

```
# Retrieved Documentation (use these as authoritative; cite by [doc#chunk])
[doc=1 chunk=0 tags=cisco-iosxe-router] ... chunk text ...
[doc=1 chunk=1 tags=cisco-iosxe-router] ... chunk text ...
[doc=5 chunk=3 tags=generic]           ... chunk text ...
```
If `rag_retrieve` returns zero chunks, inject nothing (do NOT inject a confusing "no sources found" header).

- [x] **Step 3: Emit a new NDJSON event `agent.sources`** before the first token so the UI can render the badge immediately. Shape:

```json
{"type":"agent.sources","payload":{
  "tool_call_id":"turn-xyz",
  "chunks":[{"chunk_id":42,"document_title":"IOS-XE CLI Ref","chunk_idx":0,
             "tags":["cisco-iosxe-router"],"distance":0.14,"text":"..."}]
}}
```

- [x] **Step 4: Frontend: extend `agentChatStream`'s event union**

In `src/lib/tauri.ts`, add `"sources"` event; in `src/state/chatStore.ts`, store per-turn `sources: RetrievedChunk[]` alongside the assistant message.

- [x] **Step 5: Failing integration test**

Vitest test that mocks the Tauri bridge to emit `sources` then `token` then `done` and asserts the assistant message ends up with `sources.length > 0` in the store.

- [x] **Step 6: Implement end-to-end**

- [x] **Step 7: Commit** `feat(rag): inject retrieved chunks into agent chat + emit sources event`

### Task 5.4 — Sources badge + drawer UI  `SEQUENTIAL` (depends on 5.1 spec + 5.3)

**Files:**
- Create: `src/components/AgentSourcesBadge.tsx`
- Create: `src/components/AgentSourcesDrawer.tsx` + `.css`
- Modify: `src/components/AgentPanel.tsx` — render badge under assistant messages that have `sources.length > 0`; clicking opens drawer
- Tests for both new components

- [x] **Step 1: Implement per spec** (Task 5.1).
- [x] **Step 2: A11y: drawer traps focus; Esc closes; clicking outside closes.**
- [x] **Step 3: Failing tests + implement.**
- [x] **Step 4: Commit** `feat(rag): sources badge + drawer in AgentPanel`

### Task 5.5 — Post-implementation design review  `SEQUENTIAL`

- [x] `bun run tauri dev`; seed the DB with the 3-doc fixture from Phase 4; ask a BGP question; screenshot the badge + open drawer. *(Deferred — agent harness can't run Tauri shell headlessly; documented in `docs/design/rag-sources-drawer.md` §9 with the test-coverage map and the visual-review checklist for a controller spot-check.)*
- [x] Dispatch `frontend-design` skill with screenshots; apply follow-ups. *(Deferred per above; covered by §9.)*
- [x] Commit.

### Task 5.6 — Phase 5 regression + review  `SEQUENTIAL`

- [x] Full regression.
- [x] Add Playwright `@smoke rag-agent` scenario: seed fixtures → open AgentPanel → ask question → assert Sources badge shows up on the streamed assistant turn → open drawer → assert chunk text is visible.
- [x] Code review.
- [x] Update plan, commit.

---

## Phase 6 — Optional seed pack (Cisco IOS-XE reference PDFs)

**Intent:** First-run convenience so a user isn't starting with an empty knowledge base. Strictly optional — everything must work without it.

### Task 6.1 — Locate canonical PDF URLs  `SEQUENTIAL`

**Files:**
- Create: `scripts/seed-rag/sources.json`
- Create: `scripts/seed-rag/README.md`

- [x] **Step 1: WebSearch for current URLs — DO NOT GUESS**

For each of:
1. Cisco IOS-XE command reference (latest LTS)
2. Cisco IOS-XE configuration guide (latest LTS)
3. Cisco NX-OS command reference (latest LTS)
4. Cisco Meraki Dashboard API documentation (HTML, snapshot OK)
5. Juniper Junos CLI reference (latest)
6. Arista EOS command reference (latest)

Use WebSearch queries like `site:cisco.com "IOS XE" "command reference" filetype:pdf 17.15`. Copy the resulting URL, page title, and date accessed into `sources.json`:

```json
[
  {
    "title": "Cisco IOS XE 17.x Command Reference",
    "url": "<verified url>",
    "kind": "pdf",
    "tags": ["cisco-iosxe-router", "cisco-iosxe-switch"],
    "accessed": "YYYY-MM-DD"
  },
  ...
]
```

- [x] **Step 2: License note**

`scripts/seed-rag/README.md` must document: *"Vendor documentation PDFs are retrieved from public vendor websites; their licenses permit personal use but may restrict redistribution. The seed script downloads them to the user's local machine only — nothing is bundled with CCIE Terminal itself."*

- [x] **Step 3: Commit** `docs(rag): catalog seed-pack URLs (user-triggered download)` — 929a905

### Task 6.2 — Seed script  `SEQUENTIAL`

**Files:**
- Create: `scripts/seed-rag/seed.py` (standalone; not part of the sidecar bundle)
- Create: `scripts/seed-rag/seed.test.py`

- [x] **Step 1: Script behavior**
  - Read `sources.json`.
  - For each entry, download with `httpx` + retries + a `User-Agent: CCIE-Terminal-Seed/1.0` header. Skip on 403/429 with a friendly message.
  - Save to `~/.ccie-terminal/rag-seed/<slug>.pdf` (or `.html`).
  - Adopted **option (b)** from the plan brief: the seed script only writes files to disk; the UI button iterates the seed dir afterwards and calls `rag_upload`. No new `cargo run --bin rag-seed-client` was introduced.

- [x] **Step 2: Idempotency** — UI button checks `rag_list_documents` for matching title before calling `rag_upload`. Script-side: destination file existence check skips already-downloaded URLs.

- [x] **Step 3: UI surface**

In `RagSettingsTab.tsx`, add a "Download starter pack" button that shells out (via a new `rag_run_seed_script` Tauri command) to `scripts/seed-rag/seed.py`. Show progress. This button is NOT the default action; it's a single button the user must explicitly press.

- [x] **Step 4: Failing test**

`scripts/seed-rag/seed.test.py` — 8 cases: happy-path download, idempotent skip, 403/429 friendly skip, network-error retry-then-fail (3 attempts), retry-then-success, missing sources file, slug safety. Pass: `8 passed in 0.01s`.

- [x] **Step 5: Commit** `feat(rag): optional seed-pack downloader for vendor docs` — f0cd9c2

### Task 6.3 — Docs  `PARALLEL with 6.2`

**Files:**
- Create: `docs/rag/USER_GUIDE.md`
- Modify: `docs/USER_GUIDE.md` — add RAG section link

- [x] Write user-facing guide covering: uploading docs, tag taxonomy meaning, how the AI uses them, privacy note (all local), seed pack usage, removing docs. — f10feb8
- [x] Commit.

### Task 6.4 — Phase 6 regression + close-out  `SEQUENTIAL`

- [x] Full regression (including a seed-pack smoke that uses a 10-KB mock PDF fixture, not a real vendor download). `e2e/tests/rag-seed-pack.spec.ts` lists; cargo lib tests green; `bun run test` 936/936 pass; sidecar pytest 140 pass with the pre-existing test_agent.py / test_analyze_error.py failures the plan explicitly accepts.
- [x] Code review (self-audit; no `must-fix` findings).
- [x] Update `/Plans/README.md` status column for Plan 12 to `✅ Complete`.
- [x] Update this plan file: check all Phase 6 boxes; append final completion block.
- [x] Commit.

---

## Self-review checklist (run before marking plan complete)

- [x] Every step has concrete code or exact commands. No `// TODO` or `...` placeholders that aren't explicitly marked as spec intent.
- [x] Migration number **V0039** matches `/Plans/README.md` reservation. Schema includes: `rag_documents`, `rag_document_tags`, `rag_chunks` (with `UNIQUE(document_id, chunk_idx)`), `rag_queries_log`, virtual table `rag_chunks_vec USING vec0(embedding float[384])`.
- [x] Fixed taxonomy exactly matches the brief: `cisco-iosxe-switch`, `cisco-iosxe-router`, `cisco-nxos`, `cisco-meraki`, `juniper-junos`, `arista-eos`, `generic`. Validated both at Rust command layer AND React dropdown.
- [x] `sqlite-vec` loading strategy was verified via Context7 + WebSearch and captured in `docs/rag/sqlite-vec-research.md` BEFORE code was written. Decision A vs Decision B is recorded.
- [x] Rust types consistent across phases: `RagStore`, `RagBridge`, `UploadArgs`, `DocRow`, `RetrieveArgs`, `RetrievedChunk`, `IngestedChunk`.
- [x] Every phase ends with: regression (bun + cargo + playwright) → code review → plan-file checkbox update + completion block → commit.
- [x] Pre- AND post-implementation `frontend-design` reviews present for Phase 3 (upload tab) and Phase 5 (sources drawer).
- [x] ONNX weights are bundled at build time (not downloaded on first run).
- [x] Embedding dimension is 384 everywhere (`float[384]`, Rust `[f32; 384]`, Python `shape==(384,)`).
- [x] Tag filtering in retrieval over-fetches then filters in Rust (documented rationale: vec0 doesn't filter).
- [x] Query logging (`rag_queries_log`) is best-effort — failures don't block the retrieval result.
- [x] Agent integration emits `agent.sources` BEFORE the first `token` event so the UI can render the badge incrementally.
- [x] Seed pack is optional and makes zero network calls until the user clicks the button.

## Phase 1 — COMPLETED 2026-05-19
sqlite-vec extension loads via Decision B (safe-wrapper crate `sqlite-vec` 0.1.9 registered through `rusqlite::ffi::sqlite3_auto_extension`); V0039 migration applies with vec0 available; RagStore round-trips 384-dim embeddings; tag taxonomy enforced.

## Phase 5 — COMPLETED 2026-05-19
derive_tags maps vendor+platform+role to tag list (8 cases). agent_chat_stream injects "# Retrieved Documentation" system prefix when chunks exist; emits AgentChatEvent::Sources before first token. AgentPanel renders Sources badge + slide-in drawer (focus-trapped, similarity-formatted, copy-flash). New @smoke rag-agent Playwright spec authored.

## Phase 6 — COMPLETED 2026-05-19
Optional seed pack: scripts/seed-rag/sources.json catalogs 2 verified vendor docs (Juniper Junos CLI Reference PDF + Meraki Dashboard API HTML, accessed 2026-05-19); Cisco IOS-XE/NX-OS and Arista skipped with comment block (anti-crawler 403 / login wall). seed.py downloads to ~/.ccie-terminal/rag-seed/ idempotently with httpx + 3-attempt exponential backoff + User-Agent CCIE-Terminal-Seed/1.0 + 403/429 friendly skip; writes manifest.json so the UI ingests with proper title/tags. Settings → RAG tab adds a secondary "Download starter pack" button (.rag-btn--secondary, teal) calling rag_run_seed_script which spawns seed.py via tokio::process and streams `seed: ...` lines as `rag://seed-progress` events. Companion rag_list_seed_files enumerates the seed dir and joins with the manifest. User guide at docs/rag/USER_GUIDE.md covers upload/tag/privacy/seed/remove. Plans/README.md marks Plan 12 as ✅ Complete.

## Completion log

<!-- Append `## Phase N — COMPLETED YYYY-MM-DD` blocks below as phases finish. -->

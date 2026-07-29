# sqlite-vec loading research (Plan 12 Phase 1 Task 1.1)

> Research artefact for the chosen sqlite-vec integration strategy. All
> downstream Phase 1 tasks (1.2–1.5) cite the **Decision** section at the
> bottom of this file.

## Versions in scope

| Component | Pinned version | Source |
| --- | --- | --- |
| `sqlite-vec` upstream extension | **v0.1.9** (released 2026-03-31) | https://github.com/asg017/sqlite-vec/releases/tag/v0.1.9 |
| `sqlite-vec` Rust crate | **0.1.9** (stable; `0.1.10-alpha.*` available but pre-release) | https://crates.io/crates/sqlite-vec |
| `rusqlite` already in project | **0.32** with `features = ["bundled"]` | `src-tauri/Cargo.toml` |
| `zerocopy` (helper for vector slices) | latest 0.7.x | https://crates.io/crates/zerocopy |

The macOS arm64 loadable archive for v0.1.9 is named
`sqlite-vec-0.1.9-loadable-macos-aarch64.tar.gz` (verified via the GitHub
releases JSON API on 2026-05-19). The shared library inside is `vec0.dylib`.
We do **not** ship that loadable archive — see Decision B below.

## Step 1 — Context7 lookup for `sqlite-vec`

Context7 library id: `/asg017/sqlite-vec` (High reputation, 373 snippets,
benchmark 83.74). Query: *"rust rusqlite load_extension vec0 virtual table"*.

### Verbatim excerpt (Context7 — *Initialize and use sqlite-vec in Rust*)

> Source: https://github.com/asg017/sqlite-vec/blob/main/site/using/rust.md
>
> Demonstrates registering the sqlite-vec extension with rusqlite and
> executing a query that utilizes vector functions. It uses zerocopy to pass
> vector data efficiently.
>
> ```rust
> use sqlite_vec::sqlite3_vec_init;
> use rusqlite::{ffi::sqlite3_auto_extension, Result, Connection};
> use zerocopy::AsBytes;
>
> fn main()-> Result<()> {
>     unsafe {
>         sqlite3_auto_extension(Some(std::mem::transmute(sqlite3_vec_init as *const ())));
>     }
>
>     let db = Connection::open_in_memory()?;
>     let v: Vec<f32> = vec![0.1, 0.2, 0.3];
>
>     let (vec_version, embedding): (String, String) = db.query_row(
>         "select  vec_version(), vec_to_json(?)",
>         &[v.as_bytes()],
>         |x| Ok((x.get(0)?, x.get(1)?)),
>     )?;
>
>     println!("vec_version={vec_version}, embedding={embedding}");
>     Ok(())
> }
> ```

### Verbatim excerpt (Context7 — *Create and Query vec0 Virtual Tables*)

> Source: https://context7.com/asg017/sqlite-vec/llms.txt
>
> Demonstrates creating a virtual table for vector storage, inserting vector
> data, and performing a K-Nearest Neighbor (KNN) search.
>
> ```sql
> CREATE VIRTUAL TABLE vec_documents USING vec0(
>   document_id INTEGER PRIMARY KEY,
>   contents_embedding float[768]
> );
>
> INSERT INTO vec_documents(document_id, contents_embedding)
> VALUES
>   (1, '[-0.200, 0.250, 0.341, -0.211, 0.645, 0.935, -0.316, -0.924]'),
>   (2, '[0.443, -0.501, 0.355, -0.771, 0.707, -0.708, -0.185, 0.362]'),
>   (3, '[0.716, -0.927, 0.134, 0.052, -0.669, 0.793, -0.634, -0.162]');
>
> SELECT document_id, distance
> FROM vec_documents
> WHERE contents_embedding MATCH '[0.890, 0.544, 0.825, 0.961, 0.358, 0.0196, 0.521, 0.175]'
>   AND k = 2
> ORDER BY distance;
> ```

The MATCH predicate accepts a JSON-array string literal (no `serialize_f32`
required), which is exactly what Plan 12's `RagStore::insert_chunk` will
emit via `serde_json::to_string(&[f32; 384])`.

## Step 2 — Authoritative web confirmation

### asg017/sqlite-vec official Rust guide (2026-03 update)

- Title: *Using sqlite-vec in Rust*
- URL: https://github.com/asg017/sqlite-vec/blob/main/site/using/rust.md
- Accessed: 2026-05-19

> **rusqlite Cargo.toml dependency line is recommended? Does it use
> "bundled" feature, "load_extension" feature, or just
> `sqlite3_auto_extension` via the sqlite-vec crate?**
>
> The recommended rusqlite dependency uses the `"bundled"` feature:
>
> ```toml
> rusqlite = { version = "VERSION", features = ["bundled"] }
> ```
>
> The guide states: *"First, enable the 'bundled' feature in your Cargo
> file entry for rusqlite"*. This approach works in conjunction with the
> `sqlite-vec` crate, which handles registering the extension via
> `sqlite3_auto_extension()`. The example demonstrates calling
> `sqlite3_auto_extension()` with `sqlite3_vec_init` from the sqlite-vec
> crate to load the extension at runtime, rather than using a separate
> `"load_extension"` feature on rusqlite itself.

### rusqlite 0.32 docs.rs — `Connection::load_extension`

- URL: https://docs.rs/rusqlite/0.32.0/rusqlite/struct.Connection.html
- Accessed: 2026-05-19

> Methods `load_extension_enable`, `load_extension_disable`, and
> `load_extension` are documented as *"Available on crate feature
> `load_extension` only"*. The `bundled` feature alone does **not** expose
> these methods. However, `rusqlite::ffi::sqlite3_auto_extension` is part
> of the FFI re-export and is available with the `bundled` feature without
> any additional flag — it is the C-level auto-extension hook that
> sqlite-vec's `sqlite3_vec_init` plugs into.

### asg017/sqlite-vec releases — macOS aarch64 asset

- URL: https://api.github.com/repos/asg017/sqlite-vec/releases/latest
- Accessed: 2026-05-19
- Tag: `v0.1.9`
- Published: 2026-03-31T08:00:23Z

Asset list (verbatim, abbreviated to the loadables relevant to host
triples we may someday support):

```
sqlite-vec-0.1.9-loadable-macos-aarch64.tar.gz
sqlite-vec-0.1.9-loadable-macos-x86_64.tar.gz
sqlite-vec-0.1.9-loadable-linux-aarch64.tar.gz
sqlite-vec-0.1.9-loadable-linux-x86_64.tar.gz
sqlite-vec-0.1.9-loadable-windows-x86_64.tar.gz
sqlite-vec-0.1.9-static-macos-aarch64.tar.gz       # static lib (.a)
sqlite-vec-0.1.9-static-macos-x86_64.tar.gz
sqlite-vec-0.1.9-static-linux-aarch64.tar.gz
sqlite-vec-0.1.9-static-linux-x86_64.tar.gz
```

The Rust crate `sqlite-vec` 0.1.9 statically links the same C source these
archives are built from, so we don't have to ship any loadable.

### Confirmation of the three Phase 1 task questions

1. **Does rusqlite 0.32 with `features=["bundled"]` expose
   `Connection::load_extension`?** No. `load_extension` requires the
   separate `"load_extension"` Cargo feature. But for sqlite-vec via
   crate (Decision B) we use `rusqlite::ffi::sqlite3_auto_extension`,
   which IS available with just `bundled`.
2. **Is `unsafe { conn.load_extension_enable() }` required?** Only on the
   `load_extension` feature path. Not relevant to Decision B.
3. **Is there a safe-Rust binding crate?** Yes — `sqlite-vec` on crates.io
   (FFI bindings, by the same author asg017). It vendors the C code and
   exposes `sqlite3_vec_init` so we register it via `sqlite3_auto_extension`
   at process start; every subsequent `Connection::open*` automatically has
   `vec0` available.

## Decision

**Decision: B — use the `sqlite-vec` Rust crate (`sqlite-vec = "0.1.9"`)
plus `zerocopy = "0.7"`, register `sqlite3_vec_init` via
`rusqlite::ffi::sqlite3_auto_extension` once at process start (and once
per test process), and ship NO loose `vec0.dylib`.**

Justification:

1. **No platform binaries to ship or sign.** The crate vendors the C
   sources and statically links them into the Rust binary. Tauri's
   bundling becomes simpler — nothing in `vendor/sqlite-vec/<triple>/`,
   no `build.rs` copy step, no `capabilities/default.json` FS scope
   change. macOS code-signing also stays simple (no separate `.dylib`
   to sign).
2. **No `unsafe { conn.load_extension_enable() }` block on every
   migration path.** A single `unsafe` block in `enable_vec_extension`
   to call `sqlite3_auto_extension` once is cleaner than an
   "enable / load / disable" dance per connection.
3. **Idempotent across tests.** `sqlite3_auto_extension` registers
   globally for the process; subsequent calls with the same init function
   are no-ops. Suits cargo's per-test threaded model.
4. **Same author, same versioning.** asg017 is upstream for both the
   extension and the Rust crate; we get a single dependency arrow that
   tracks the C release.
5. **Plan 12 retains the `enable_vec_extension(&Connection) -> Result<()>`
   API surface** — only the body changes. Migration ordering, `RagStore`,
   tests, etc., all keep the spec's signature even though the body is
   the safe-wrapper version.

> NOTE for Phase 1 Task 1.2: because we are NOT shipping a loose
> `vec0.dylib`, the `src-tauri/vendor/sqlite-vec/<triple>/` tree, the
> `CCIE_VEC_DIR` env override, the `build.rs` copy step, and any
> `capabilities/default.json` FS-scope expansion are dropped. The plan
> file's checkbox text mentions these but the Decision-A vs Decision-B
> escape hatch is explicitly invoked here. Subsequent commit messages
> reflect Decision B.

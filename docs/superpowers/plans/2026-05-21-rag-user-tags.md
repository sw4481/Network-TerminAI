# RAG User-Defined Tags Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users create their own tags alongside the seven builtin vendor tags, organize uploaded documents with them, and optionally use them as an additional retrieval filter in any chat tab.

**Architecture:** Replace the strict 7-tag whitelist in `rag/tags.rs` with a slug-shape validator + reserved-prefix guard, keep `TAG_TAXONOMY` only as the source of truth for "is this tag builtin," extend `rag_tag_taxonomy` to return builtin and user tags separately, and add an `AND` (subset) filter pass to `rag/retrieve.rs` that runs only when the caller passes user tags. Frontend toggles user tags per chat tab in the existing `AgentSourcesDrawer`, and the AgentPanel passes them on every retrieve call. No DB migration.

**Tech Stack:** Rust 2021 (anyhow, rusqlite, async-trait, serde, tauri 2), TypeScript (zustand, vitest, React, @tauri-apps/api), spec at `docs/superpowers/specs/2026-05-21-rag-user-tags-design.md`.

---

## File Structure

**Rust — modified:**

- `src-tauri/src/rag/tags.rs` — replace `validate_tag` with `validate_tag_shape` and add `is_builtin_tag`. Existing tests rewritten.
- `src-tauri/src/rag/store.rs` — `set_tags` calls `validate_tag_shape`. New `list_user_tags()` method.
- `src-tauri/src/rag/retrieve.rs` — split incoming tags into builtin/user sets, add subset filter. New tests.
- `src-tauri/src/commands/rag.rs` — `validate_upload_args` uses `validate_tag_shape`. `rag_tag_taxonomy` returns `RagTaxonomyPayload`.

**Rust — tests modified/created:**

- `src-tauri/tests/rag_upload_test.rs` — add cases for accepted user tag and rejected reserved-prefix tag.
- `src-tauri/tests/rag_retrieve_test.rs` — add three subset-filter cases.

**Frontend — modified:**

- `src/lib/rag.ts` — `RagTag` widens to `string`. New `BUILTIN_RAG_TAGS`, `RagTaxonomy`, `UserTagSummary`, `TAG_SHAPE_RE`, `isReservedPrefix`. `ragTaxonomy()` return type changes.
- `src/lib/rag.test.ts` — taxonomy mock updated; add shape/reserved tests.
- `src/state/ragStore.ts` — `taxonomy` field becomes `RagTaxonomy`. New `activeUserTagsByTab`, `getActiveUserTags`, `setActiveUserTags`, `toggleActiveUserTag`.
- `src/components/RagSettingsTab.tsx` — `taxonomy.length > 0` guard becomes `taxonomy.builtin.length > 0`. Pass `taxonomy` (full object) into the modal.
- `src/components/RagUploadModal.tsx` — split chip rows into builtin + user; add `+ New tag` inline input with shape validation.
- `src/components/AgentSourcesDrawer.tsx` — render the active-tags section under the cited-chunks list with read-only vendor chips and toggleable user-tag chips.
- `src/components/AgentPanel.tsx` — no behavior change here directly; the retrieve composition is in Rust today (`build_rag_system_prefix`).

**Rust — chat-time retrieve composition:**

- `src-tauri/src/commands/mod.rs::build_rag_system_prefix` and `agent_chat_stream` accept an optional `user_tags: Option<Vec<String>>` and append it to the `RetrieveArgs.tags` list.
- `src/lib/tauri.ts::agentChatStream` accepts a new optional `userTags?: string[]` and forwards it.
- `src/components/AgentPanel.tsx` reads active user tags from `ragStore` for the current tab and passes them in.

**Frontend — tests modified/created:**

- `src/components/RagUploadModal.test.tsx` (new file if absent; otherwise extend) — inline tag creation, shape validation, dedup vs existing tag.
- `src/components/AgentSourcesDrawer.test.tsx` — add active-tags section assertions.
- `src/state/ragStore.test.ts` (new) — covers `activeUserTagsByTab` reducers.

No DB migration. No new dependency.

---

## Task 1: Rust validator — `validate_tag_shape` + `is_builtin_tag`

**Files:**
- Modify: `src-tauri/src/rag/tags.rs` (full rewrite)
- Test: same file (`#[cfg(test)] mod tests`)

- [ ] **Step 1: Replace the file contents**

Overwrite `src-tauri/src/rag/tags.rs` with:

```rust
//! Plan 12 + RAG user-tags follow-up — RAG tag shape rules.
//!
//! `TAG_TAXONOMY` lists the seven builtin vendor tags. They participate
//! in retrieval as the OR-filter set (caller's vendor + `generic`).
//! Any other tag that passes `validate_tag_shape` is treated as a user
//! tag. User tags participate in retrieval as an additional AND
//! (subset) filter — see `src-tauri/src/rag/retrieve.rs`.

use anyhow::{bail, Result};

/// Authoritative builtin taxonomy. Order matches the original Plan 12
/// brief and the `BUILTIN_RAG_TAGS` constant in `src/lib/rag.ts`.
pub const TAG_TAXONOMY: &[&str] = &[
    "cisco-iosxe-switch",
    "cisco-iosxe-router",
    "cisco-nxos",
    "cisco-meraki",
    "juniper-junos",
    "arista-eos",
    "generic",
];

/// Reserved prefixes — a non-builtin tag may not start with any of
/// these. Protects the vendor namespace from typo'd lookalikes
/// (e.g. `cisco-iosx-router`).
const RESERVED_PREFIXES: &[&str] = &["cisco-", "juniper-", "arista-"];

/// True iff `t` is an exact member of [`TAG_TAXONOMY`]. Used by the
/// retriever to split an incoming tag list into the builtin (OR) set
/// and the user (AND) set.
pub fn is_builtin_tag(t: &str) -> bool {
    TAG_TAXONOMY.iter().any(|x| *x == t)
}

/// Slug-shape + reserved-prefix check.
///
/// Rules:
/// - 1..=32 ASCII characters.
/// - Lowercase letter or digit at position 0.
/// - Subsequent characters: `[a-z0-9-]`.
/// - Tags equal to a builtin (exact match in [`TAG_TAXONOMY`]) always
///   pass.
/// - Non-builtin tags must not start with a reserved vendor prefix
///   (`cisco-`, `juniper-`, `arista-`) and must not equal `generic`.
pub fn validate_tag_shape(t: &str) -> Result<()> {
    if is_builtin_tag(t) {
        return Ok(());
    }
    if t.is_empty() {
        bail!("tag must not be empty");
    }
    if t.len() > 32 {
        bail!("tag '{t}' exceeds 32-character cap");
    }
    let mut chars = t.chars();
    let first = chars.next().unwrap();
    if !(first.is_ascii_lowercase() || first.is_ascii_digit()) {
        bail!("tag '{t}' must start with a lowercase letter or digit");
    }
    for c in chars {
        if !(c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-') {
            bail!("tag '{t}' contains invalid character '{c}' (allowed: a-z, 0-9, -)");
        }
    }
    if t == "generic" {
        // is_builtin_tag returns true for exact "generic", so reaching
        // this branch means the input was something different that
        // happened to equal "generic" — defensive only.
        bail!("tag 'generic' is reserved");
    }
    for prefix in RESERVED_PREFIXES {
        if t.starts_with(prefix) {
            bail!("tag '{t}' uses reserved vendor prefix '{prefix}'");
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn taxonomy_contains_canonical_seven() {
        assert_eq!(TAG_TAXONOMY.len(), 7);
        for expected in [
            "cisco-iosxe-switch",
            "cisco-iosxe-router",
            "cisco-nxos",
            "cisco-meraki",
            "juniper-junos",
            "arista-eos",
            "generic",
        ] {
            assert!(TAG_TAXONOMY.contains(&expected), "missing {expected}");
        }
    }

    #[test]
    fn is_builtin_tag_matches_taxonomy_only() {
        assert!(is_builtin_tag("cisco-iosxe-router"));
        assert!(is_builtin_tag("generic"));
        assert!(!is_builtin_tag("customer-acme"));
        assert!(!is_builtin_tag(""));
    }

    #[test]
    fn validate_shape_accepts_builtins() {
        for t in TAG_TAXONOMY {
            assert!(validate_tag_shape(t).is_ok(), "builtin {t} rejected");
        }
    }

    #[test]
    fn validate_shape_accepts_user_slugs() {
        assert!(validate_tag_shape("customer-acme").is_ok());
        assert!(validate_tag_shape("project1").is_ok());
        assert!(validate_tag_shape("a").is_ok());
        assert!(validate_tag_shape("0").is_ok());
        assert!(validate_tag_shape(&"a".repeat(32)).is_ok());
    }

    #[test]
    fn validate_shape_rejects_bad_shape() {
        assert!(validate_tag_shape("").is_err());
        assert!(validate_tag_shape("Customer-ACME").is_err());
        assert!(validate_tag_shape("-leading").is_err());
        assert!(validate_tag_shape("bad space").is_err());
        assert!(validate_tag_shape("emoji-🔥").is_err());
        assert!(validate_tag_shape(&"a".repeat(33)).is_err());
    }

    #[test]
    fn validate_shape_rejects_reserved_prefixes() {
        assert!(validate_tag_shape("cisco-foo").is_err());
        assert!(validate_tag_shape("juniper-x").is_err());
        assert!(validate_tag_shape("arista-foo").is_err());
        // Builtins still pass — they're whitelisted by exact match.
        assert!(validate_tag_shape("cisco-iosxe-router").is_ok());
        assert!(validate_tag_shape("juniper-junos").is_ok());
    }
}
```

- [ ] **Step 2: Run tests**

Run: `cd "/Users/shaunwhi/CCIE Terminal/src-tauri" && cargo test --lib rag::tags`
Expected: 6 tests pass.

- [ ] **Step 3: Commit**

```bash
cd "/Users/shaunwhi/CCIE Terminal" && \
git add src-tauri/src/rag/tags.rs && \
git commit -m "refactor(rag): replace tag whitelist with shape validator

Replaces the strict 7-tag whitelist (validate_tag) with
validate_tag_shape + is_builtin_tag. Builtin tags still live in
TAG_TAXONOMY but are now the source of truth for 'which tags are
builtin' rather than 'which tags are allowed at all'. Reserved
vendor prefixes (cisco-, juniper-, arista-) are guarded so user tags
cannot pose as vendor tags.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 2: Wire `validate_tag_shape` into the store + add `list_user_tags`

**Files:**
- Modify: `src-tauri/src/rag/store.rs` (replace `validate_tag` import + `set_tags` body, append `list_user_tags`)
- Test: `src-tauri/src/rag/store.rs` (`#[cfg(test)] mod tests` — locate at the bottom)

- [ ] **Step 1: Replace the import**

In `src-tauri/src/rag/store.rs`, change line 15:

```rust
use super::tags::validate_tag;
```

to:

```rust
use super::tags::validate_tag_shape;
```

- [ ] **Step 2: Replace the body of `set_tags`**

In the same file, replace the `for t in tags { validate_tag(...)... }` loop inside `set_tags` (currently lines 93–96) with:

```rust
for t in tags {
    validate_tag_shape(t)
        .with_context(|| format!("validate tag '{t}' for doc {doc_id}"))?;
}
```

The rest of the function is unchanged.

- [ ] **Step 3: Add `UserTagSummary` and `list_user_tags`**

Add the following type at the top of the file, immediately after the `EMBEDDING_DIM` constant:

```rust
/// One row per distinct non-builtin tag currently referenced by at
/// least one document. Returned by [`RagStore::list_user_tags`].
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct UserTagSummary {
    pub tag: String,
    pub usage_count: i64,
}
```

Then add the new method on `impl RagStore`. Place it directly after `list_tags` (which currently ends near line 130 — locate by `pub fn list_tags`):

```rust
    /// Enumerate every distinct tag in `rag_document_tags` that is NOT
    /// a member of [`super::tags::TAG_TAXONOMY`], with its usage count.
    /// Ordered by `usage_count desc, tag asc` so the picker UI can
    /// present popular tags first. The taxonomy filter happens in Rust
    /// rather than SQL because the builtin list is short and lives in
    /// code, not the database.
    pub fn list_user_tags(&self) -> Result<Vec<UserTagSummary>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT tag, COUNT(*) AS usage_count
                 FROM rag_document_tags
             GROUP BY tag",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))
        })?;
        let mut out: Vec<UserTagSummary> = Vec::new();
        for row in rows {
            let (tag, usage_count) = row?;
            if super::tags::is_builtin_tag(&tag) {
                continue;
            }
            out.push(UserTagSummary { tag, usage_count });
        }
        out.sort_by(|a, b| {
            b.usage_count
                .cmp(&a.usage_count)
                .then_with(|| a.tag.cmp(&b.tag))
        });
        Ok(out)
    }
```

- [ ] **Step 4: Add tests for `set_tags` accepting user tags + `list_user_tags`**

Locate the existing `#[cfg(test)] mod tests` block at the bottom of `store.rs`. Inside that block, add:

```rust
    #[test]
    fn set_tags_accepts_user_tag_shapes() {
        let store = RagStore::open_in_memory().expect("open store");
        let id = store
            .insert_document("Doc", "/tmp/d.md", "md", 10)
            .expect("insert");
        store
            .set_tags(&id_ref(id), &["cisco-iosxe-router", "customer-acme"])
            .expect("set_tags ok with mixed builtin + user");
        let tags = store.list_tags(id).expect("list_tags");
        assert!(tags.iter().any(|t| t == "cisco-iosxe-router"));
        assert!(tags.iter().any(|t| t == "customer-acme"));
    }

    #[test]
    fn set_tags_rejects_reserved_prefix() {
        let store = RagStore::open_in_memory().expect("open store");
        let id = store
            .insert_document("Doc", "/tmp/d.md", "md", 10)
            .expect("insert");
        let err = store
            .set_tags(&id_ref(id), &["cisco-foo"])
            .expect_err("reserved prefix must be rejected");
        let msg = format!("{err:#}");
        assert!(msg.contains("cisco-foo"), "msg = {msg}");
    }

    #[test]
    fn list_user_tags_excludes_builtins_and_orders_by_usage() {
        let store = RagStore::open_in_memory().expect("open store");
        let a = store
            .insert_document("A", "/tmp/a.md", "md", 1)
            .expect("insert a");
        let b = store
            .insert_document("B", "/tmp/b.md", "md", 1)
            .expect("insert b");
        store
            .set_tags(&id_ref(a), &["customer-acme", "generic"])
            .expect("tags a");
        store
            .set_tags(&id_ref(b), &["customer-acme", "project1"])
            .expect("tags b");
        let user = store.list_user_tags().expect("list_user_tags");
        // generic is builtin → filtered out.
        assert_eq!(user.len(), 2);
        assert_eq!(user[0].tag, "customer-acme");
        assert_eq!(user[0].usage_count, 2);
        assert_eq!(user[1].tag, "project1");
        assert_eq!(user[1].usage_count, 1);
    }

    fn id_ref(id: i64) -> i64 {
        // `set_tags` takes &[&str]; the `id` slice version is just a
        // local helper to keep the test bodies readable.
        id
    }
```

> **NOTE TO IMPLEMENTER:** if `id_ref` collides with anything already defined in the test module, drop it and inline `id` directly into each `set_tags(id, ...)` call.

- [ ] **Step 5: Run the new tests**

Run: `cd "/Users/shaunwhi/CCIE Terminal/src-tauri" && cargo test --lib rag::store::tests`
Expected: all existing tests pass + 3 new tests pass.

- [ ] **Step 6: Commit**

```bash
cd "/Users/shaunwhi/CCIE Terminal" && \
git add src-tauri/src/rag/store.rs && \
git commit -m "feat(rag): accept user tags in store; add list_user_tags

set_tags now uses validate_tag_shape so any slug-shape tag is
accepted alongside the seven builtins. list_user_tags surfaces
non-builtin tags with usage counts for the picker UI.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 3: Retrieve — split into builtin OR-set and user AND-set

**Files:**
- Modify: `src-tauri/src/rag/retrieve.rs`
- Test: `src-tauri/tests/rag_retrieve_test.rs` (existing) + the in-file `#[cfg(test)] mod tests` if present.

- [ ] **Step 1: Replace the validator import**

In `src-tauri/src/rag/retrieve.rs`, change `use crate::rag::tags::validate_tag;` (line 33) to:

```rust
use crate::rag::tags::{is_builtin_tag, validate_tag_shape};
```

- [ ] **Step 2: Update the validation + filter logic**

Locate the block beginning `for t in &args.tags { validate_tag(t)... }` and the `effective_tags` construction (lines 85–93). Replace from that loop through the loop that builds `effective_tags` with:

```rust
    for t in &args.tags {
        validate_tag_shape(t)
            .with_context(|| format!("retrieve: invalid tag '{t}'"))?;
    }

    // Split incoming tags into the builtin (OR) set and the user (AND)
    // set. Builtins always include `generic` so a bare-vendor query
    // still surfaces vendor-neutral docs (existing semantics).
    let mut builtin_set: std::collections::HashSet<String> = args
        .tags
        .iter()
        .filter(|t| is_builtin_tag(t))
        .cloned()
        .collect();
    builtin_set.insert("generic".to_string());

    let user_set: std::collections::HashSet<String> = args
        .tags
        .iter()
        .filter(|t| !is_builtin_tag(t))
        .cloned()
        .collect();
```

- [ ] **Step 3: Update the candidate-keep predicate**

Locate the loop that walks ANN candidates and tests `doc_tags ∩ effective_tags ≠ ∅` (around line 122). Replace the keep-condition with:

```rust
        let doc_tags = tags_by_doc.get(&c.document_id).cloned().unwrap_or_default();
        let builtin_match = doc_tags.iter().any(|t| builtin_set.contains(t));
        let user_match = user_set.iter().all(|t| doc_tags.contains(t));
        if !(builtin_match && user_match) {
            continue;
        }
```

(Replace whatever the existing `if`/`continue` was; keep the surrounding `kept`/`out` accumulation logic untouched.)

- [ ] **Step 4: If the file has an in-file test module, update it; otherwise jump to Step 5**

If `retrieve.rs` has `#[cfg(test)] mod tests`, scan it for any test that constructs `RetrieveArgs` with non-builtin tags or that relies on the OR-only semantics. Update those tests so they pass user-tag values via the new AND filter (use the integration test additions in Step 5 as a template). If none exist in-file, this is a no-op.

- [ ] **Step 5: Add three integration tests**

Open `src-tauri/tests/rag_retrieve_test.rs`. Add the following three tests at the end of the file (inside whatever `mod`/file scope it uses; existing helpers like `setup` should be reused — locate them by reading the top of the file):

```rust
#[tokio::test]
async fn retrieve_user_tag_subset_of_one_passes() {
    let (store, bridge) = setup().await;
    let doc_id = ingest_doc_with_tags(
        &store,
        &bridge,
        "Acme Cisco runbook",
        &["cisco-iosxe-router", "customer-acme"],
    )
    .await;
    let args = crate::rag::retrieve::RetrieveArgs {
        query: "ospf areas".into(),
        tags: vec!["cisco-iosxe-router".into(), "customer-acme".into()],
        k: 5,
    };
    let chunks = crate::rag::retrieve::retrieve(&store, bridge.as_ref(), args)
        .await
        .expect("retrieve ok");
    assert!(
        chunks.iter().any(|c| c.document_id == doc_id),
        "tagged doc must surface"
    );
}

#[tokio::test]
async fn retrieve_user_tag_missing_excludes_doc() {
    let (store, bridge) = setup().await;
    // Doc has only the vendor tag, no user tag.
    let doc_id = ingest_doc_with_tags(
        &store,
        &bridge,
        "Generic Cisco runbook",
        &["cisco-iosxe-router"],
    )
    .await;
    let args = crate::rag::retrieve::RetrieveArgs {
        query: "ospf areas".into(),
        tags: vec!["cisco-iosxe-router".into(), "customer-acme".into()],
        k: 5,
    };
    let chunks = crate::rag::retrieve::retrieve(&store, bridge.as_ref(), args)
        .await
        .expect("retrieve ok");
    assert!(
        !chunks.iter().any(|c| c.document_id == doc_id),
        "doc without all user tags must be excluded"
    );
}

#[tokio::test]
async fn retrieve_two_user_tags_both_present_passes() {
    let (store, bridge) = setup().await;
    let doc_id = ingest_doc_with_tags(
        &store,
        &bridge,
        "Acme CLI runbook",
        &["cisco-iosxe-router", "customer-acme", "cli-only"],
    )
    .await;
    let args = crate::rag::retrieve::RetrieveArgs {
        query: "ospf areas".into(),
        tags: vec![
            "cisco-iosxe-router".into(),
            "customer-acme".into(),
            "cli-only".into(),
        ],
        k: 5,
    };
    let chunks = crate::rag::retrieve::retrieve(&store, bridge.as_ref(), args)
        .await
        .expect("retrieve ok");
    assert!(
        chunks.iter().any(|c| c.document_id == doc_id),
        "doc with both user tags must surface"
    );
}
```

If `setup` and `ingest_doc_with_tags` do not exist in this file under those names, locate the existing test helpers (open the top of the file with Read) and adapt the calls. The existing tests already exercise an `ingest + tag` pattern; copy that pattern into a small `ingest_doc_with_tags(store, bridge, title, tags)` helper at file scope and reuse it.

> If a helper is missing, write one inside this same file:
>
> ```rust
> async fn ingest_doc_with_tags(
>     store: &crate::rag::store::RagStore,
>     bridge: &std::sync::Arc<dyn crate::rag::bridge::RagBridgeApi>,
>     title: &str,
>     tags: &[&str],
> ) -> i64 {
>     // Use the same ingestion path the existing tests use; if those
>     // tests bypass `rag_upload_inner` and call store + bridge directly,
>     // mirror that. The helper's only job is to land a document whose
>     // text embeds against "ospf areas" so the ANN call returns it.
>     todo!("mirror existing ingestion helper")
> }
> ```

- [ ] **Step 6: Run retrieve tests**

Run: `cd "/Users/shaunwhi/CCIE Terminal/src-tauri" && cargo test --test rag_retrieve_test`
Expected: existing tests pass + 3 new tests pass.

- [ ] **Step 7: Commit**

```bash
cd "/Users/shaunwhi/CCIE Terminal" && \
git add src-tauri/src/rag/retrieve.rs src-tauri/tests/rag_retrieve_test.rs && \
git commit -m "feat(rag): apply user tags as AND filter in retrieve

Vendor + generic continue to gate via OR (any-of), preserving today's
behavior when no user tags are passed. Non-builtin tags now act as a
required subset on each candidate, so a chat scoped to
'customer-acme' only sees docs that have customer-acme on them.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 4: Tauri command surface — `rag_tag_taxonomy` returns `RagTaxonomyPayload`

**Files:**
- Modify: `src-tauri/src/commands/rag.rs`
- Test: `src-tauri/tests/rag_upload_test.rs`

- [ ] **Step 1: Replace the imports + validator + add the payload type**

In `src-tauri/src/commands/rag.rs`, change:

```rust
use crate::rag::tags::{validate_tag, TAG_TAXONOMY};
```

to:

```rust
use crate::rag::store::UserTagSummary;
use crate::rag::tags::{validate_tag_shape, TAG_TAXONOMY};
```

- [ ] **Step 2: Update `validate_upload_args`**

Inside `validate_upload_args`, replace:

```rust
    for t in &args.tags {
        validate_tag(t).map_err(|e| e.to_string())?;
    }
```

with:

```rust
    for t in &args.tags {
        validate_tag_shape(t).map_err(|e| e.to_string())?;
    }
```

- [ ] **Step 3: Add the payload type and rewrite `rag_tag_taxonomy`**

Replace the existing `pub fn rag_tag_taxonomy() -> Vec<&'static str>` and its `#[tauri::command]` attribute (currently lines 254–257) with:

```rust
/// Frontend payload for the tag picker. `builtin` is the seven fixed
/// vendor tags; `user` is whatever non-builtin tags currently appear
/// in `rag_document_tags` (with usage counts).
#[derive(Debug, Serialize)]
pub struct RagTaxonomyPayload {
    pub builtin: Vec<&'static str>,
    pub user: Vec<UserTagSummary>,
}

#[tauri::command]
pub async fn rag_tag_taxonomy(
    state: State<'_, AppState>,
) -> Result<RagTaxonomyPayload, String> {
    let store = state.rag_store.clone();
    let user = tokio::task::spawn_blocking(move || store.list_user_tags())
        .await
        .map_err(|e| format!("list_user_tags join: {e}"))?
        .map_err(|e| e.to_string())?;
    Ok(RagTaxonomyPayload {
        builtin: TAG_TAXONOMY.to_vec(),
        user,
    })
}
```

- [ ] **Step 4: Update `rag_upload_test.rs`**

Open `src-tauri/tests/rag_upload_test.rs`. Locate any test that exercises tag validation and confirm none of them depend on rejection of a valid-shape user tag (the old `validate_tag` rejected anything outside the 7-list). For each test that asserts rejection of `customer-acme` or similar, change the assertion to **acceptance**.

Add two new tests at the end of the file:

```rust
#[tokio::test]
async fn upload_accepts_user_tag() {
    let (store, bridge) = setup().await;
    let res = crate::commands::rag::rag_upload_inner(
        &store,
        bridge.as_ref(),
        crate::commands::rag::UploadArgs {
            path: small_pdf_fixture(),
            kind: "pdf".into(),
            title: "Acme runbook".into(),
            tags: vec!["cisco-iosxe-router".into(), "customer-acme".into()],
        },
        None,
    )
    .await;
    assert!(res.is_ok(), "user tag must be accepted: {res:?}");
}

#[tokio::test]
async fn upload_rejects_reserved_prefix_tag() {
    let (store, bridge) = setup().await;
    let res = crate::commands::rag::rag_upload_inner(
        &store,
        bridge.as_ref(),
        crate::commands::rag::UploadArgs {
            path: small_pdf_fixture(),
            kind: "pdf".into(),
            title: "Bogus".into(),
            tags: vec!["cisco-foo".into()],
        },
        None,
    )
    .await;
    let err = res.expect_err("reserved prefix must be rejected");
    assert!(err.contains("cisco-foo"), "err = {err}");
}
```

If `small_pdf_fixture()` does not exist, reuse whatever fixture path the existing tests use (the file has at least one passing upload-test today; mirror its setup).

- [ ] **Step 5: Run the tests**

Run: `cd "/Users/shaunwhi/CCIE Terminal/src-tauri" && cargo test --test rag_upload_test`
Expected: existing tests pass + 2 new tests pass.

- [ ] **Step 6: Type-check the workspace**

Run: `cd "/Users/shaunwhi/CCIE Terminal/src-tauri" && cargo check --all-targets`
Expected: no errors. (`rag_tag_taxonomy`'s changed signature may surface a downstream consumer; if so, fix the call site here — the only known consumer is the frontend.)

- [ ] **Step 7: Commit**

```bash
cd "/Users/shaunwhi/CCIE Terminal" && \
git add src-tauri/src/commands/rag.rs src-tauri/tests/rag_upload_test.rs && \
git commit -m "feat(rag): rag_tag_taxonomy returns builtin + user split

rag_upload now validates tags via validate_tag_shape, accepting any
slug-shape tag and rejecting reserved-prefix lookalikes.
rag_tag_taxonomy returns RagTaxonomyPayload { builtin, user[] } so
the picker UI can render the two sets distinctly with usage counts.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 5: Frontend types — widen `RagTag`, add taxonomy + shape helpers

**Files:**
- Modify: `src/lib/rag.ts`
- Test: `src/lib/rag.test.ts`

- [ ] **Step 1: Replace the type/constant block**

In `src/lib/rag.ts`, replace the `export type RagTag = ... | "generic";` block (lines 19–26) with:

```ts
/** Builtin (vendor) tags. Mirrors `TAG_TAXONOMY` in
 *  `src-tauri/src/rag/tags.rs`; keep these two lists in sync. */
export const BUILTIN_RAG_TAGS = [
  "cisco-iosxe-switch",
  "cisco-iosxe-router",
  "cisco-nxos",
  "cisco-meraki",
  "juniper-junos",
  "arista-eos",
  "generic",
] as const;
export type BuiltinRagTag = (typeof BUILTIN_RAG_TAGS)[number];

/** A RAG tag — any builtin or any user-defined slug. The Rust validator
 *  enforces shape; this type is intentionally `string` so user tags
 *  type-check in callers. */
export type RagTag = string;

/** Mirrors `validate_tag_shape` in Rust: 1..=32 chars, lowercase alnum
 *  + hyphen, must start with letter/digit. Reserved-prefix check is a
 *  separate function. */
export const TAG_SHAPE_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

/** True iff `t` would be rejected by Rust as a reserved-prefix user
 *  tag. Builtin tags themselves return false (they're allowed). */
export function isReservedPrefix(t: string): boolean {
  if ((BUILTIN_RAG_TAGS as readonly string[]).includes(t)) return false;
  if (t === "generic") return true;
  return (
    t.startsWith("cisco-") ||
    t.startsWith("juniper-") ||
    t.startsWith("arista-")
  );
}

/** One row in `RagTaxonomy.user`. */
export type UserTagSummary = { tag: string; usage_count: number };

/** Result shape of `rag_tag_taxonomy`. */
export type RagTaxonomy = {
  builtin: readonly BuiltinRagTag[];
  user: UserTagSummary[];
};
```

- [ ] **Step 2: Update `ragTaxonomy` signature**

Replace the existing `ragTaxonomy` export (currently `Promise<RagTag[]>`) with:

```ts
export const ragTaxonomy = (): Promise<RagTaxonomy> =>
  invoke<RagTaxonomy>("rag_tag_taxonomy");
```

- [ ] **Step 3: Update tests**

Open `src/lib/rag.test.ts`. Where the test mocks `rag_tag_taxonomy`, update the mocked return value from a plain string array to:

```ts
{ builtin: ["cisco-iosxe-router", "generic"], user: [] }
```

Then add two new test cases at the end of the file:

```ts
import { TAG_SHAPE_RE, isReservedPrefix } from "./rag";

describe("TAG_SHAPE_RE", () => {
  it("accepts user slugs", () => {
    expect(TAG_SHAPE_RE.test("customer-acme")).toBe(true);
    expect(TAG_SHAPE_RE.test("a")).toBe(true);
    expect(TAG_SHAPE_RE.test("0")).toBe(true);
    expect(TAG_SHAPE_RE.test("a".repeat(32))).toBe(true);
  });
  it("rejects bad shapes", () => {
    expect(TAG_SHAPE_RE.test("")).toBe(false);
    expect(TAG_SHAPE_RE.test("Customer-ACME")).toBe(false);
    expect(TAG_SHAPE_RE.test("-leading")).toBe(false);
    expect(TAG_SHAPE_RE.test("bad space")).toBe(false);
    expect(TAG_SHAPE_RE.test("a".repeat(33))).toBe(false);
  });
});

describe("isReservedPrefix", () => {
  it("flags vendor prefixes for non-builtin tags", () => {
    expect(isReservedPrefix("cisco-foo")).toBe(true);
    expect(isReservedPrefix("juniper-x")).toBe(true);
    expect(isReservedPrefix("arista-foo")).toBe(true);
  });
  it("permits builtins themselves", () => {
    expect(isReservedPrefix("cisco-iosxe-router")).toBe(false);
    expect(isReservedPrefix("juniper-junos")).toBe(false);
  });
  it("permits ordinary user tags", () => {
    expect(isReservedPrefix("customer-acme")).toBe(false);
  });
});
```

- [ ] **Step 4: Run the tests**

Run: `cd "/Users/shaunwhi/CCIE Terminal" && npx vitest run src/lib/rag.test.ts`
Expected: existing tests pass + new shape/reserved tests pass.

- [ ] **Step 5: Commit**

```bash
cd "/Users/shaunwhi/CCIE Terminal" && \
git add src/lib/rag.ts src/lib/rag.test.ts && \
git commit -m "feat(rag): widen RagTag and split taxonomy into builtin + user

Widen RagTag from a 7-string union to plain string. Add
BUILTIN_RAG_TAGS, TAG_SHAPE_RE, isReservedPrefix, RagTaxonomy, and
UserTagSummary so the upload modal and Sources drawer can render
the two tag sets separately and validate inline tag creation.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 6: ragStore — taxonomy shape + per-tab active user tags

**Files:**
- Modify: `src/state/ragStore.ts`
- Test: `src/state/ragStore.test.ts` (new)

- [ ] **Step 1: Update store types and reducers**

Replace the contents of `src/state/ragStore.ts` with:

```ts
/**
 * Plan 12 + RAG user-tags follow-up — Zustand store for the Settings
 * → RAG tab and the AgentPanel Sources drawer.
 *
 * Holds the document list, in-flight upload progress (keyed by source
 * path), the cached taxonomy (builtin + user split), and per-tab
 * active user-tag selections. Lazily loaded by the tab component on
 * mount; the upload-progress subscription is attached once via
 * `subscribeUploadProgress`.
 */
import { create } from "zustand";
import {
  type DocRow,
  type RagTaxonomy,
  type UploadProgress,
  ragList,
  ragTaxonomy,
  onUploadProgress,
} from "../lib/rag";
import type { UnlistenFn } from "@tauri-apps/api/event";

const EMPTY_TAXONOMY: RagTaxonomy = { builtin: [], user: [] };

type RagStoreState = {
  documents: DocRow[];
  inFlight: Record<string, UploadProgress>;
  taxonomy: RagTaxonomy;
  activeUserTagsByTab: Record<string, string[]>;
  loading: boolean;
  error: string | null;
  unlisten: UnlistenFn | null;

  loadDocuments: () => Promise<void>;
  loadTaxonomy: () => Promise<void>;
  appendDocument: (doc: DocRow) => void;
  optimisticDelete: (docId: number) => void;
  applyProgress: (p: UploadProgress) => void;
  clearInFlight: (path: string) => void;
  subscribeUploadProgress: () => Promise<void>;
  unsubscribeUploadProgress: () => void;
  getActiveUserTags: (tabId: string) => string[];
  setActiveUserTags: (tabId: string, tags: string[]) => void;
  toggleActiveUserTag: (tabId: string, tag: string) => void;
  reset: () => void;
};

export const useRagStore = create<RagStoreState>((set, get) => ({
  documents: [],
  inFlight: {},
  taxonomy: EMPTY_TAXONOMY,
  activeUserTagsByTab: {},
  loading: false,
  error: null,
  unlisten: null,

  loadDocuments: async () => {
    set({ loading: true, error: null });
    try {
      const docs = await ragList();
      set({ documents: docs, loading: false });
    } catch (e) {
      set({ error: String(e), loading: false });
    }
  },

  loadTaxonomy: async () => {
    try {
      const taxonomy = await ragTaxonomy();
      set({ taxonomy });
    } catch (e) {
      set({ error: String(e) });
    }
  },

  appendDocument: (doc) =>
    set((s) => ({ documents: [doc, ...s.documents] })),

  optimisticDelete: (docId) =>
    set((s) => ({
      documents: s.documents.filter((d) => d.id !== docId),
    })),

  applyProgress: (p) =>
    set((s) => ({
      inFlight: { ...s.inFlight, [p.docPath]: p },
    })),

  clearInFlight: (path) =>
    set((s) => {
      const next = { ...s.inFlight };
      delete next[path];
      return { inFlight: next };
    }),

  subscribeUploadProgress: async () => {
    if (get().unlisten) return;
    try {
      const unl = await onUploadProgress((p) => get().applyProgress(p));
      set({ unlisten: unl });
    } catch (e) {
      set({ error: String(e) });
    }
  },

  unsubscribeUploadProgress: () => {
    const unl = get().unlisten;
    if (unl) {
      unl();
      set({ unlisten: null });
    }
  },

  getActiveUserTags: (tabId) => get().activeUserTagsByTab[tabId] ?? [],

  setActiveUserTags: (tabId, tags) =>
    set((s) => ({
      activeUserTagsByTab: { ...s.activeUserTagsByTab, [tabId]: tags },
    })),

  toggleActiveUserTag: (tabId, tag) =>
    set((s) => {
      const current = s.activeUserTagsByTab[tabId] ?? [];
      const next = current.includes(tag)
        ? current.filter((t) => t !== tag)
        : [...current, tag];
      return {
        activeUserTagsByTab: { ...s.activeUserTagsByTab, [tabId]: next },
      };
    }),

  reset: () =>
    set({
      documents: [],
      inFlight: {},
      taxonomy: EMPTY_TAXONOMY,
      activeUserTagsByTab: {},
      loading: false,
      error: null,
    }),
}));
```

- [ ] **Step 2: Add a unit test**

Create `src/state/ragStore.test.ts` with:

```ts
import { describe, expect, it, beforeEach, vi } from "vitest";
import { useRagStore } from "./ragStore";

vi.mock("../lib/rag", () => ({
  ragList: vi.fn().mockResolvedValue([]),
  ragTaxonomy: vi
    .fn()
    .mockResolvedValue({ builtin: ["generic"], user: [] }),
  onUploadProgress: vi.fn(),
}));

describe("ragStore active user tags", () => {
  beforeEach(() => {
    useRagStore.getState().reset();
  });

  it("getActiveUserTags returns [] for an unknown tab", () => {
    expect(useRagStore.getState().getActiveUserTags("tab-x")).toEqual([]);
  });

  it("setActiveUserTags overwrites the per-tab list", () => {
    useRagStore.getState().setActiveUserTags("tab-x", ["customer-acme"]);
    expect(useRagStore.getState().getActiveUserTags("tab-x")).toEqual([
      "customer-acme",
    ]);
    useRagStore.getState().setActiveUserTags("tab-x", []);
    expect(useRagStore.getState().getActiveUserTags("tab-x")).toEqual([]);
  });

  it("toggleActiveUserTag adds and removes per-tab", () => {
    useRagStore.getState().toggleActiveUserTag("tab-x", "customer-acme");
    expect(useRagStore.getState().getActiveUserTags("tab-x")).toEqual([
      "customer-acme",
    ]);
    useRagStore.getState().toggleActiveUserTag("tab-x", "cli-only");
    expect(useRagStore.getState().getActiveUserTags("tab-x")).toEqual([
      "customer-acme",
      "cli-only",
    ]);
    useRagStore.getState().toggleActiveUserTag("tab-x", "customer-acme");
    expect(useRagStore.getState().getActiveUserTags("tab-x")).toEqual([
      "cli-only",
    ]);
  });

  it("per-tab state is independent", () => {
    useRagStore.getState().toggleActiveUserTag("tab-a", "customer-acme");
    useRagStore.getState().toggleActiveUserTag("tab-b", "project1");
    expect(useRagStore.getState().getActiveUserTags("tab-a")).toEqual([
      "customer-acme",
    ]);
    expect(useRagStore.getState().getActiveUserTags("tab-b")).toEqual([
      "project1",
    ]);
  });
});
```

- [ ] **Step 3: Run the test**

Run: `cd "/Users/shaunwhi/CCIE Terminal" && npx vitest run src/state/ragStore.test.ts`
Expected: 4 tests pass.

- [ ] **Step 4: Commit**

```bash
cd "/Users/shaunwhi/CCIE Terminal" && \
git add src/state/ragStore.ts src/state/ragStore.test.ts && \
git commit -m "feat(rag): per-tab active user tags in ragStore

Adds activeUserTagsByTab + selectors so the AgentPanel Sources
drawer can record per-tab user-tag selections. taxonomy field shape
follows the new RagTaxonomy { builtin, user[] } payload.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 7: RagSettingsTab — adopt new taxonomy shape

**Files:**
- Modify: `src/components/RagSettingsTab.tsx`
- Test: existing component tests if any (no new test required for this small adapter change).

- [ ] **Step 1: Update the gating condition + modal prop**

In `src/components/RagSettingsTab.tsx`, locate the modal render block (around line 523):

```tsx
{pending.length > 0 && taxonomy.length > 0 && (
  <RagUploadModal
    files={pending}
    taxonomy={taxonomy}
    onCancel={() => setPending([])}
    onSubmit={dispatchUploads}
  />
)}
```

Replace with:

```tsx
{pending.length > 0 && taxonomy.builtin.length > 0 && (
  <RagUploadModal
    files={pending}
    taxonomy={taxonomy}
    onCancel={() => setPending([])}
    onSubmit={dispatchUploads}
  />
)}
```

Also remove the `RagTag` import from the existing import line if it becomes unused after Task 8 lands; for now leave it, as the modal will still need the old `RagTag` type alias (which is now `string`).

- [ ] **Step 2: Type-check**

Run: `cd "/Users/shaunwhi/CCIE Terminal" && npx tsc --noEmit`
Expected: success — `taxonomy.builtin.length` resolves through the new type.

> If tsc reports a `Type 'RagTaxonomy' is not assignable` error from the modal prop, that's expected and gets fixed in Task 8. If you're running tasks one at a time, you may either (a) defer this typecheck to after Task 8, or (b) cast the modal `taxonomy` prop as `taxonomy as unknown as RagTag[]` and remove the cast in Task 8. Pick (a) if you can; the diff stays cleaner.

- [ ] **Step 3: Commit**

```bash
cd "/Users/shaunwhi/CCIE Terminal" && \
git add src/components/RagSettingsTab.tsx && \
git commit -m "refactor(rag): RagSettingsTab consumes new taxonomy shape

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 8: Upload modal — split chip rows + inline `+ New tag`

**Files:**
- Modify: `src/components/RagUploadModal.tsx`
- Modify: `src/components/RagSettingsTab.css` (or `RagUploadModal.css`, whichever owns `.rag-tag-grid`) — additive styles only.
- Test: `src/components/RagUploadModal.test.tsx`

- [ ] **Step 1: Replace the modal body**

Open `src/components/RagUploadModal.tsx`. Apply these edits:

Replace the import line `import type { RagKind, RagTag } from "../lib/rag";` with:

```tsx
import {
  type RagKind,
  type RagTag,
  type RagTaxonomy,
  TAG_SHAPE_RE,
  isReservedPrefix,
} from "../lib/rag";
```

Replace the `RagUploadModalProps` `taxonomy` field type from `RagTag[]` to `RagTaxonomy`:

```tsx
export type RagUploadModalProps = {
  files: PendingFile[];
  taxonomy: RagTaxonomy;
  onCancel: () => void;
  onSubmit: (
    files: { path: string; title: string; kind: RagKind }[],
    tags: RagTag[],
  ) => void;
};
```

Just inside the `RagUploadModal` component body, after `const [tags, setTags] = useState<Set<RagTag>>(new Set());`, add:

```tsx
  // User tags: starts as the taxonomy.user list; the inline `+ New tag`
  // input adds to this. Modal-local — the tag becomes real on first
  // upload that includes it (the Rust set_tags writes the row).
  const [userTagPool, setUserTagPool] = useState<string[]>(
    () => taxonomy.user.map((u) => u.tag),
  );
  const [newTagDraft, setNewTagDraft] = useState("");
  const [newTagError, setNewTagError] = useState<string | null>(null);

  const validateDraft = (raw: string): string | null => {
    const v = raw.trim();
    if (!v) return null; // Empty draft: no error, just nothing to add.
    if (!TAG_SHAPE_RE.test(v)) {
      return "Lowercase letters, digits, hyphens. Max 32 characters.";
    }
    if (isReservedPrefix(v)) {
      return "That prefix is reserved for vendor tags.";
    }
    return null;
  };

  const commitNewTag = () => {
    const v = newTagDraft.trim();
    if (!v) return;
    const err = validateDraft(v);
    if (err) {
      setNewTagError(err);
      return;
    }
    // Dedup against any existing chip (builtin or user).
    if (
      taxonomy.builtin.includes(v as never) ||
      userTagPool.includes(v)
    ) {
      // Just select the existing chip.
      setTags((prev) => {
        const next = new Set(prev);
        next.add(v);
        return next;
      });
      setNewTagDraft("");
      setNewTagError(null);
      return;
    }
    setUserTagPool((prev) => [...prev, v]);
    setTags((prev) => {
      const next = new Set(prev);
      next.add(v);
      return next;
    });
    setNewTagDraft("");
    setNewTagError(null);
    setShowTagError(false);
  };
```

Replace the existing `<div className="rag-tag-grid" ...>` block (the one that maps over `taxonomy`) with the two-row layout:

```tsx
            <p className="rag-modal-tag-label">
              Tag the batch (applies to all {files.length}, choose 1+):
            </p>

            <p className="rag-modal-tag-sublabel">Builtin tags</p>
            <div
              className="rag-tag-grid"
              role="group"
              aria-label="Builtin tags"
            >
              {taxonomy.builtin.map((t) => {
                const selected = tags.has(t);
                return (
                  <button
                    key={t}
                    type="button"
                    role="button"
                    aria-pressed={selected}
                    className={
                      "rag-tag rag-modal-tag" +
                      (selected ? " rag-tag--selected" : "")
                    }
                    onClick={() => toggleTag(t)}
                  >
                    <span className="rag-tag-glyph" aria-hidden="true">
                      {selected ? "◉" : "⊘"}
                    </span>
                    {t}
                  </button>
                );
              })}
            </div>

            <p className="rag-modal-tag-sublabel">Your tags</p>
            <div
              className="rag-tag-grid"
              role="group"
              aria-label="Your tags"
            >
              {userTagPool.length === 0 && newTagDraft.length === 0 && (
                <span className="rag-modal-empty-user-tags">
                  No custom tags yet — type one below.
                </span>
              )}
              {userTagPool.map((t) => {
                const selected = tags.has(t);
                return (
                  <button
                    key={t}
                    type="button"
                    role="button"
                    aria-pressed={selected}
                    className={
                      "rag-tag rag-modal-tag rag-modal-tag--user" +
                      (selected ? " rag-tag--selected" : "")
                    }
                    onClick={() => toggleTag(t)}
                  >
                    <span className="rag-tag-glyph" aria-hidden="true">
                      {selected ? "◉" : "⊘"}
                    </span>
                    {t}
                  </button>
                );
              })}
            </div>

            <div className="rag-modal-new-tag-row">
              <input
                className="rag-modal-new-tag-input"
                type="text"
                value={newTagDraft}
                onChange={(e) => {
                  const v = e.target.value;
                  setNewTagDraft(v);
                  setNewTagError(validateDraft(v));
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    e.stopPropagation();
                    commitNewTag();
                  }
                }}
                placeholder="+ New tag (e.g. customer-acme)"
                aria-label="Create a new user tag"
                aria-invalid={newTagError ? "true" : undefined}
                data-testid="rag-modal-new-tag-input"
              />
              <button
                type="button"
                className="rag-modal-new-tag-btn"
                onClick={commitNewTag}
                disabled={!newTagDraft.trim() || !!newTagError}
                data-testid="rag-modal-new-tag-add"
              >
                Add
              </button>
            </div>
            {newTagError && (
              <p
                className="rag-modal-tag-error"
                role="alert"
                data-testid="rag-modal-new-tag-error"
              >
                {newTagError}
              </p>
            )}

            <p className="rag-modal-tag-help">
              <span aria-hidden="true">ⓘ </span>
              One tag minimum. Chats see docs tagged for the session's
              vendor + any tagged <code>generic</code>; user tags filter
              further (AND).
            </p>
```

Note the existing `{showTagError && ...}` block that was inside the old `rag-modal-tag-section` should remain — leave it where it is, immediately after the help paragraph.

- [ ] **Step 2: Add minimal additive CSS**

Locate `RagSettingsTab.css` (already imported by the settings tab). Append:

```css
.rag-modal-tag-sublabel {
  margin: 0.5rem 0 0.25rem;
  font-size: 0.75rem;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  opacity: 0.7;
}
.rag-modal-empty-user-tags {
  font-size: 0.85rem;
  opacity: 0.6;
}
.rag-modal-new-tag-row {
  display: flex;
  gap: 0.5rem;
  margin-top: 0.5rem;
}
.rag-modal-new-tag-input {
  flex: 1;
}
```

(If the file already defines a more specific scheme, follow that pattern instead — the goal is "two visually distinct chip rows + a one-line input under them.")

- [ ] **Step 3: Add modal tests**

Create `src/components/RagUploadModal.test.tsx` (or extend an existing test file if present):

```tsx
import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { RagUploadModal } from "./RagUploadModal";
import type { RagTaxonomy } from "../lib/rag";

const TAXONOMY: RagTaxonomy = {
  builtin: ["cisco-iosxe-router", "generic"],
  user: [{ tag: "customer-acme", usage_count: 2 }],
};

const FILES = [
  {
    path: "/tmp/foo.pdf",
    title: "foo",
    kind: "pdf" as const,
    bytes: 1024,
  },
];

describe("RagUploadModal user tags", () => {
  it("renders builtin and user chips in separate rows", () => {
    render(
      <RagUploadModal
        files={FILES}
        taxonomy={TAXONOMY}
        onCancel={() => {}}
        onSubmit={() => {}}
      />,
    );
    expect(
      screen.getByRole("group", { name: /builtin tags/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("group", { name: /your tags/i }),
    ).toBeInTheDocument();
    expect(screen.getByText("cisco-iosxe-router")).toBeInTheDocument();
    expect(screen.getByText("customer-acme")).toBeInTheDocument();
  });

  it("creates a chip when typing a valid slug and pressing Enter", () => {
    render(
      <RagUploadModal
        files={FILES}
        taxonomy={{ ...TAXONOMY, user: [] }}
        onCancel={() => {}}
        onSubmit={() => {}}
      />,
    );
    const input = screen.getByTestId("rag-modal-new-tag-input");
    fireEvent.change(input, { target: { value: "project1" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByText("project1")).toBeInTheDocument();
  });

  it("shows an error for an invalid shape", () => {
    render(
      <RagUploadModal
        files={FILES}
        taxonomy={{ ...TAXONOMY, user: [] }}
        onCancel={() => {}}
        onSubmit={() => {}}
      />,
    );
    const input = screen.getByTestId("rag-modal-new-tag-input");
    fireEvent.change(input, { target: { value: "Bad Tag!" } });
    expect(
      screen.getByTestId("rag-modal-new-tag-error"),
    ).toBeInTheDocument();
  });

  it("rejects reserved-prefix tags", () => {
    render(
      <RagUploadModal
        files={FILES}
        taxonomy={{ ...TAXONOMY, user: [] }}
        onCancel={() => {}}
        onSubmit={() => {}}
      />,
    );
    const input = screen.getByTestId("rag-modal-new-tag-input");
    fireEvent.change(input, { target: { value: "cisco-foo" } });
    expect(
      screen.getByTestId("rag-modal-new-tag-error"),
    ).toBeInTheDocument();
  });

  it("dedups against an existing user tag (selects rather than duplicates)", () => {
    const onSubmit = vi.fn();
    render(
      <RagUploadModal
        files={FILES}
        taxonomy={TAXONOMY}
        onCancel={() => {}}
        onSubmit={onSubmit}
      />,
    );
    const input = screen.getByTestId("rag-modal-new-tag-input");
    fireEvent.change(input, { target: { value: "customer-acme" } });
    fireEvent.keyDown(input, { key: "Enter" });
    // Only one chip with that text.
    expect(screen.getAllByText("customer-acme")).toHaveLength(1);
  });

  it("submits with both a builtin and a newly created tag", () => {
    const onSubmit = vi.fn();
    render(
      <RagUploadModal
        files={FILES}
        taxonomy={{ ...TAXONOMY, user: [] }}
        onCancel={() => {}}
        onSubmit={onSubmit}
      />,
    );
    fireEvent.click(screen.getByText("cisco-iosxe-router"));
    const input = screen.getByTestId("rag-modal-new-tag-input");
    fireEvent.change(input, { target: { value: "project1" } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.click(screen.getByText(/^Add$/i, { selector: "button" }));
    // Submit via the modal's primary button — locate by accessible name.
    fireEvent.click(screen.getByRole("button", { name: /^add documents?$/i }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    const [, tags] = onSubmit.mock.calls[0];
    expect(tags).toEqual(
      expect.arrayContaining(["cisco-iosxe-router", "project1"]),
    );
  });
});
```

> **NOTE TO IMPLEMENTER:** the existing primary button label may be `Add` or `Upload` — read the modal footer (around line 280 of `RagUploadModal.tsx`) and adjust the last test's `getByRole("button", { name: ... })` query to match.

- [ ] **Step 4: Run modal tests**

Run: `cd "/Users/shaunwhi/CCIE Terminal" && npx vitest run src/components/RagUploadModal.test.tsx`
Expected: all 6 tests pass.

- [ ] **Step 5: Type-check**

Run: `cd "/Users/shaunwhi/CCIE Terminal" && npx tsc --noEmit`
Expected: success.

- [ ] **Step 6: Commit**

```bash
cd "/Users/shaunwhi/CCIE Terminal" && \
git add src/components/RagUploadModal.tsx src/components/RagSettingsTab.css src/components/RagUploadModal.test.tsx && \
git commit -m "feat(rag): upload modal supports inline user-tag creation

Splits the tag picker into a Builtin row and a Your tags row, plus a
+ New tag input that validates slug-shape on the fly and dedups
against existing chips. Tags become persistent on first upload that
includes them (set_tags writes the rag_document_tags row).

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 9: AgentSourcesDrawer — active tags section

**Files:**
- Modify: `src/components/AgentSourcesDrawer.tsx`
- Modify: `src/components/AgentSourcesDrawer.css` (additive)
- Test: `src/components/AgentSourcesDrawer.test.tsx`

- [ ] **Step 1: Read the drawer's current props**

Run: `Read src/components/AgentSourcesDrawer.tsx` and record (a) the prop shape, (b) where it's used by `AgentPanel.tsx`, (c) whether it currently receives a `tabId`. If it doesn't receive a `tabId`, plan to thread one through — `AgentPanel.tsx` already knows the active tab id (it builds a `keyForTurn` near line 290).

- [ ] **Step 2: Add an `activeUserTags` section**

In `AgentSourcesDrawer.tsx`, add the following near the top of the component (after the existing imports and the props destructure). If the drawer doesn't yet take `tabId`, add it to the props:

```tsx
import { useRagStore } from "../state/ragStore";
import { useTabsStore } from "../state/tabsStore"; // adjust to actual path

// Inside the component:
const taxonomy = useRagStore((s) => s.taxonomy);
const activeUserTags = useRagStore(
  (s) => s.activeUserTagsByTab[props.tabId] ?? [],
);
const toggleActiveUserTag = useRagStore((s) => s.toggleActiveUserTag);
const vendor = useTabsStore((s) => s.tabs.find((t) => t.id === props.tabId)?.rag_vendor ?? null);
const platform = useTabsStore((s) => s.tabs.find((t) => t.id === props.tabId)?.rag_platform ?? null);
```

> If `useTabsStore` lookups don't match the real store name/shape, locate the per-tab vendor/platform getter (it's already used by `AgentPanel` when calling `agentChatStream`). Reuse that hook.

Render the section at the bottom of the existing drawer body (after the cited-chunks list) only when the drawer is open:

```tsx
        <section className="agent-sources-active-tags">
          <h4 className="agent-sources-active-tags-title">Active tags</h4>
          {(vendor || platform) ? (
            <div className="agent-sources-active-tags-row" aria-label="Vendor tags (auto-derived)">
              {vendor && <span className="rag-tag rag-tag--readonly">{vendor}</span>}
              {platform && <span className="rag-tag rag-tag--readonly">{platform}</span>}
              <span className="rag-tag rag-tag--readonly">generic</span>
            </div>
          ) : null}

          {taxonomy.user.length === 0 ? (
            <p className="agent-sources-empty-tags">
              Tag uploads in <em>Settings → RAG</em> to filter chats by your own tags.
            </p>
          ) : (
            <div
              className="agent-sources-active-tags-row"
              role="group"
              aria-label="User tags"
            >
              {taxonomy.user.map((u) => {
                const selected = activeUserTags.includes(u.tag);
                return (
                  <button
                    type="button"
                    key={u.tag}
                    aria-pressed={selected}
                    className={
                      "rag-tag rag-tag--user" +
                      (selected ? " rag-tag--selected" : "")
                    }
                    onClick={() => toggleActiveUserTag(props.tabId, u.tag)}
                    data-testid={`agent-sources-user-tag-${u.tag}`}
                  >
                    {u.tag} <span className="rag-tag-count">({u.usage_count})</span>
                  </button>
                );
              })}
            </div>
          )}
          <p className="agent-sources-active-tags-help">
            Vendor tags use OR; your tags use AND.
          </p>
        </section>
```

- [ ] **Step 3: Append CSS**

In `AgentSourcesDrawer.css`, append:

```css
.agent-sources-active-tags {
  margin-top: 1rem;
  padding-top: 0.75rem;
  border-top: 1px solid var(--border, rgba(255,255,255,0.1));
}
.agent-sources-active-tags-title {
  margin: 0 0 0.5rem;
  font-size: 0.85rem;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}
.agent-sources-active-tags-row {
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem;
  margin-bottom: 0.5rem;
}
.agent-sources-empty-tags {
  font-size: 0.8rem;
  opacity: 0.7;
}
.agent-sources-active-tags-help {
  font-size: 0.75rem;
  opacity: 0.6;
}
.rag-tag-count {
  opacity: 0.6;
  font-variant-numeric: tabular-nums;
}
```

- [ ] **Step 4: Update `AgentPanel.tsx` to pass `tabId`**

If the existing `<AgentSourcesDrawer ... />` render does not pass a `tabId` prop, add it. The active tab id is whatever `AgentPanel` uses as the key for chat state.

- [ ] **Step 5: Add drawer tests**

Open `src/components/AgentSourcesDrawer.test.tsx` and append:

```tsx
import { describe, expect, it } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { AgentSourcesDrawer } from "./AgentSourcesDrawer";
import { useRagStore } from "../state/ragStore";

describe("AgentSourcesDrawer active tags", () => {
  it("hides user-tag row when taxonomy.user is empty", () => {
    useRagStore.getState().reset();
    useRagStore.setState({ taxonomy: { builtin: ["generic"], user: [] } });
    render(
      <AgentSourcesDrawer
        // ...whatever required props the component takes; reuse the
        // existing test's render helper if one exists.
        tabId="tab-x"
        chunks={[]}
        open
        onClose={() => {}}
      />,
    );
    expect(screen.getByText(/Tag uploads in/)).toBeInTheDocument();
  });

  it("toggles a user tag into activeUserTagsByTab", () => {
    useRagStore.getState().reset();
    useRagStore.setState({
      taxonomy: {
        builtin: ["generic"],
        user: [{ tag: "customer-acme", usage_count: 3 }],
      },
    });
    render(
      <AgentSourcesDrawer
        tabId="tab-x"
        chunks={[]}
        open
        onClose={() => {}}
      />,
    );
    const chip = screen.getByTestId("agent-sources-user-tag-customer-acme");
    expect(chip.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(chip);
    expect(
      useRagStore.getState().getActiveUserTags("tab-x"),
    ).toEqual(["customer-acme"]);
  });
});
```

> If the drawer's existing test file already imports a `setup`/`renderDrawer` helper, reuse it instead of reproducing the prop list above.

- [ ] **Step 6: Run drawer tests**

Run: `cd "/Users/shaunwhi/CCIE Terminal" && npx vitest run src/components/AgentSourcesDrawer.test.tsx`
Expected: existing tests pass + 2 new tests pass.

- [ ] **Step 7: Commit**

```bash
cd "/Users/shaunwhi/CCIE Terminal" && \
git add src/components/AgentSourcesDrawer.tsx src/components/AgentSourcesDrawer.css src/components/AgentSourcesDrawer.test.tsx src/components/AgentPanel.tsx && \
git commit -m "feat(rag): active-tags section in Sources drawer

Renders a read-only vendor chip row (auto-derived from the tab's
vendor + platform + generic) and a toggleable user-tag chip row
sourced from rag_tag_taxonomy. Selections persist per tab via
ragStore.activeUserTagsByTab and are passed into agent_chat_stream.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 10: Plumb `userTags` through `agent_chat_stream`

**Files:**
- Modify: `src-tauri/src/commands/mod.rs`
- Modify: `src/lib/tauri.ts`
- Modify: `src/components/AgentPanel.tsx`

- [ ] **Step 1: Rust — accept and forward `user_tags`**

In `src-tauri/src/commands/mod.rs`, change the signature of `build_rag_system_prefix`:

```rust
async fn build_rag_system_prefix(
    state: &State<'_, AppState>,
    vendor: Option<&str>,
    platform: Option<&str>,
    user_tags: &[String],
    query: &str,
    on_event: &Channel<AgentChatEvent>,
) -> Option<String> {
    if vendor.is_none() && platform.is_none() && user_tags.is_empty() {
        return None;
    }
    let mut tags = crate::rag::session_tags::derive_tags(vendor, platform, None);
    for t in user_tags {
        tags.push(t.clone());
    }
    let args = crate::rag::retrieve::RetrieveArgs {
        query: query.to_string(),
        tags,
        k: 5,
    };
    // ...rest unchanged
```

Then update the `agent_chat_stream` signature and the call site:

```rust
pub async fn agent_chat_stream(
    state: State<'_, AppState>,
    tab_id: String,
    message: String,
    on_event: Channel<AgentChatEvent>,
    vendor: Option<String>,
    platform: Option<String>,
    user_tags: Option<Vec<String>>,
) -> Result<(), String> {
    // ...existing setup...

    let user_tags_vec = user_tags.unwrap_or_default();
    let rag_prefix = build_rag_system_prefix(
        &state,
        vendor.as_deref(),
        platform.as_deref(),
        &user_tags_vec,
        &cleaned_msg,
        &on_event,
    )
    .await;
    // ...rest unchanged
```

- [ ] **Step 2: Frontend — forward through `agentChatStream`**

In `src/lib/tauri.ts`, extend the `agentChatStream` opts and `invoke` payload:

```ts
export async function agentChatStream(opts: {
  tabId: string;
  message: string;
  onEvent: (e: AgentChatEvent) => void;
  vendor?: string;
  platform?: string;
  /** Active user tags from ragStore.activeUserTagsByTab[tabId]. */
  userTags?: string[];
}): Promise<void> {
  const channel = new Channel<AgentChatEvent>();
  channel.onmessage = opts.onEvent;
  return invoke<void>("agent_chat_stream", {
    tabId: opts.tabId,
    message: opts.message,
    onEvent: channel,
    vendor: opts.vendor ?? null,
    platform: opts.platform ?? null,
    userTags: opts.userTags ?? null,
  });
}
```

- [ ] **Step 3: AgentPanel — pass active user tags on every send**

In `src/components/AgentPanel.tsx`, locate the call to `agentChatStream`. Add a selector for the current tab's active user tags and include it in the call:

```tsx
const userTags = useRagStore((s) => s.activeUserTagsByTab[props.tabId] ?? []);
// ...
agentChatStream({
  tabId: props.tabId,
  message: ...,
  onEvent: ...,
  vendor: ...,
  platform: ...,
  userTags,
});
```

(Adjust the destructure if `props.tabId` is named differently in this component — locate the existing `tabId` reference and reuse it.)

- [ ] **Step 4: Type-check + workspace check**

Run: `cd "/Users/shaunwhi/CCIE Terminal" && npx tsc --noEmit`
Expected: success.

Run: `cd "/Users/shaunwhi/CCIE Terminal/src-tauri" && cargo check --all-targets`
Expected: success.

- [ ] **Step 5: Commit**

```bash
cd "/Users/shaunwhi/CCIE Terminal" && \
git add src-tauri/src/commands/mod.rs src/lib/tauri.ts src/components/AgentPanel.tsx && \
git commit -m "feat(rag): pass active user tags through agent_chat_stream

build_rag_system_prefix appends the caller's user tags onto the
session-derived vendor/generic tag list before retrieving. With no
active user tags the behavior is identical to today.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 11: Full-suite regressions

**Files:** none modified — verification only.

- [ ] **Step 1: Rust suite**

Run: `cd "/Users/shaunwhi/CCIE Terminal/src-tauri" && cargo test --all-targets`
Expected: all tests pass.

- [ ] **Step 2: Frontend suite**

Run: `cd "/Users/shaunwhi/CCIE Terminal" && npx vitest run`
Expected: all tests pass (1076 baseline + the new ones from Tasks 5/6/8/9).

- [ ] **Step 3: Type-check + build**

Run: `cd "/Users/shaunwhi/CCIE Terminal" && npx tsc --noEmit && npm run build`
Expected: success.

- [ ] **Step 4: Manual smoke (UI)**

Restart the dev app (post bundled-python fix). Then:

1. Settings → RAG. Drop a PDF. In the upload modal, click `+ New tag`, type `customer-acme`, hit Enter, also pick `cisco-iosxe-router`. Submit. Verify the doc appears with both tags in its row.
2. Drop a second PDF. In the modal, type `project1`, hit Enter. Pick only `cisco-iosxe-router`. Submit.
3. Open a chat tab inferred as cisco-iosxe-router. Open the Sources drawer. Verify `customer-acme (1)` and `project1 (1)` chips show.
4. Toggle `customer-acme` on. Send a question. Confirm only the customer-acme-tagged Cisco doc appears in the cited chunks.
5. Toggle `customer-acme` off. Send the same question. Confirm both Cisco docs are eligible.
6. Toggle a reserved-prefix attempt in the upload modal — type `cisco-bad`, expect inline error.

If any step fails, fix the issue, write a regression test, and recommit before continuing.

- [ ] **Step 5: Final commit (if any drift)**

If smoke testing surfaced a fix, commit it. Otherwise no-op.

---

## Spec coverage check (self-review)

| Spec section | Covered by |
|---|---|
| Validator changes (`validate_tag_shape`, `is_builtin_tag`, reserved prefixes) | Task 1 |
| `RagStore::list_user_tags`, `set_tags` calls `validate_tag_shape` | Task 2 |
| `rag_tag_taxonomy` returns `RagTaxonomyPayload`, `rag_upload` shape validation | Task 4 |
| Retrieve splits builtin OR-set + user AND-set | Task 3 |
| `derive_tags` unchanged | (no change required) |
| Frontend `BUILTIN_RAG_TAGS`, `RagTaxonomy`, `TAG_SHAPE_RE`, `isReservedPrefix` | Task 5 |
| `ragStore` taxonomy shape, `activeUserTagsByTab` + reducers | Task 6 |
| `RagUploadModal` two chip rows + `+ New tag` | Task 8 |
| Sources drawer "Active tags" section | Task 9 |
| Chat retrieval call site appends user tags | Task 10 |
| Rust tag-shape + reserved-prefix tests | Task 1 |
| Rust store list_user_tags + reserved-prefix rejection tests | Task 2 |
| Rust retrieve subset-filter tests | Task 3 |
| Rust upload accept user / reject reserved tests | Task 4 |
| Frontend rag.ts shape + reserved tests | Task 5 |
| Frontend ragStore active-tag tests | Task 6 |
| Frontend modal inline-creation tests | Task 8 |
| Frontend drawer empty-state + toggle tests | Task 9 |

No DB migration is required; no rollout/migration step exists in the spec.

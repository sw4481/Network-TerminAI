# RAG User-Defined Tags — Design

Status: design (approved 2026-05-21)
Touches: Plan 12 (RAG Tab), no new migration

## Goal

Let users create their own tags alongside the seven builtin vendor tags, organize uploaded documents with them, and optionally use them as an additional retrieval filter in any chat tab.

## Background

Today the RAG system enforces a fixed seven-tag taxonomy at three layers (`rag/tags.rs::TAG_TAXONOMY`, `rag/retrieve.rs`, `rag/session_tags.rs::derive_tags`). Uploads with any other tag are rejected. There is no way to organize docs by customer, project, or any axis other than vendor.

## Non-goals

- Per-tag color/description/icon — strings only.
- Tag hierarchy or grouping — flat namespace.
- Tag rename/merge/delete UI — possible follow-up; for v1 a tag exists as long as at least one doc references it.
- Backfill of any existing data — no rows currently violate the new rules.

## Architecture overview

Replace the strict whitelist with a slug-shape validator, surface builtin and user tags as separate fields to the UI, store an active set of user tags per chat tab on the frontend, and have the retriever apply the user tags as an additional `subset` filter on top of the existing vendor-OR-generic gate.

The DB schema is unchanged. `rag_document_tags(document_id, tag)` already accepts arbitrary strings — only the application validator gated it.

## Validator changes (`src-tauri/src/rag/tags.rs`)

```
shape regex: ^[a-z0-9][a-z0-9-]{0,31}$
length cap : 32 characters
reserved   : a tag matching prefix `cisco-`, `juniper-`, `arista-`, or
             equal to `generic` is rejected unless it's an exact member
             of TAG_TAXONOMY
```

`TAG_TAXONOMY` stays as the source of truth for which tags are builtin.

Two functions:

```rust
/// True iff `t` is in TAG_TAXONOMY. Used by retrieval to decide which
/// part of the incoming tag list is a vendor filter vs a user filter.
pub fn is_builtin_tag(t: &str) -> bool;

/// Slug-shape + reserved-prefix check. Used by upload + retrieval to
/// accept any tag (builtin or user) without enforcing the whitelist.
pub fn validate_tag_shape(t: &str) -> Result<()>;
```

`RagStore::set_tags` calls `validate_tag_shape` instead of `validate_tag`. `rag_upload`'s frontend-args validator does the same. The old `validate_tag` is removed.

## Storage

No DB migration. V0043 remains the latest used.

New `RagStore` method to enumerate user tags for the picker:

```rust
/// Returns every distinct tag in `rag_document_tags` that is NOT a
/// member of TAG_TAXONOMY, with its usage count, ordered by
/// usage_count desc then tag asc.
pub fn list_user_tags(&self) -> Result<Vec<UserTagSummary>>;

pub struct UserTagSummary {
    pub tag: String,
    pub usage_count: i64,
}
```

Single SQL query (group-by + having; cheap, no index needed beyond the existing `(tag)` lookup).

## Tauri command surface (`commands/rag.rs`)

`rag_tag_taxonomy()` shape changes from `Vec<&str>` to:

```rust
#[derive(Serialize)]
pub struct RagTaxonomyPayload {
    pub builtin: Vec<&'static str>,    // TAG_TAXONOMY
    pub user: Vec<UserTagSummary>,     // from RagStore::list_user_tags
}
```

This is a breaking change for the one consumer (`RagSettingsTab.tsx`) and one test (`lib/rag.test.ts`); both updated in the same change set.

`rag_upload` validation: replace whitelist check with slug-shape + reserved-prefix check. Error messages name the offending tag and the rule it violated.

## Retrieval (`src-tauri/src/rag/retrieve.rs`)

Current filter:

```
effective = args.tags ∪ {generic}
candidate passes iff doc_tags ∩ effective ≠ ∅
```

New filter:

```
validate_tag_shape on every t in args.tags
builtin_set = { t ∈ args.tags : is_builtin(t) } ∪ {generic}
user_set    = { t ∈ args.tags : !is_builtin(t) }

candidate passes iff
  (doc_tags ∩ builtin_set ≠ ∅)        // existing vendor gate
  AND (user_set ⊆ doc_tags)            // every active user tag must be present
```

`user_set` empty ⇒ second clause is trivially true ⇒ behavior identical to today.

Edge case — only user tags supplied: `builtin_set` collapses to `{generic}`. A doc tagged only with a user tag will not surface unless it also carries `generic` or a vendor tag. Documented in upload-modal copy and the Sources drawer helper.

## Session-tag derivation (`src-tauri/src/rag/session_tags.rs`)

Unchanged. `derive_tags(vendor, platform, role)` continues to return only the builtin tags. The frontend appends active user tags from the Sources drawer onto the `RetrieveArgs.tags` list before invoking `ragRetrieve`.

## Frontend changes

### `src/lib/rag.ts`

```ts
export const BUILTIN_RAG_TAGS = [
  "cisco-iosxe-switch", "cisco-iosxe-router", "cisco-nxos",
  "cisco-meraki", "juniper-junos", "arista-eos", "generic",
] as const;
export type BuiltinRagTag = typeof BUILTIN_RAG_TAGS[number];
export type RagTag = string;             // widened from union
export type UserTagSummary = { tag: string; usage_count: number };
export type RagTaxonomy = { builtin: BuiltinRagTag[]; user: UserTagSummary[] };

export const TAG_SHAPE_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
export function isReservedPrefix(t: string): boolean;  // mirrors Rust

export const ragTaxonomy = (): Promise<RagTaxonomy> =>
  invoke<RagTaxonomy>("rag_tag_taxonomy");
```

### `src/state/ragStore.ts`

- `taxonomy: RagTag[]` → `taxonomy: RagTaxonomy`.
- `loadTaxonomy()` updated for the new shape.
- New field `activeUserTagsByTab: Record<string, string[]>`.
- New selectors `getActiveUserTags(tabId)` and `setActiveUserTags(tabId, tags[])`.
- Persists alongside the existing per-tab vendor state (whatever path that uses today).

### `src/components/RagUploadModal.tsx`

Tag picker becomes two chip rows:

1. **Builtin** — same seven chips, same toggle behavior as today.
2. **Your tags** — one chip per `taxonomy.user`, plus an inline `+ New tag` text input.

Inline `+ New tag`:

- Live shape validation against `TAG_SHAPE_RE` and `isReservedPrefix`. Invalid shapes show a red helper line.
- Enter or Add creates a chip in the **Your tags** row already in selected state. No backend call — the tag becomes real on first upload that includes it.
- Typing a slug that already exists (in builtin or user) selects the existing chip rather than duplicating.

After upload, `loadTaxonomy()` reruns and the new tag now shows up in `taxonomy.user` with `usage_count >= 1`.

### `src/components/AgentPanel/SourcesDrawer.tsx` (or current path)

Add a section **Active tags** below the cited-chunks list:

- Read-only chip row with the auto-derived vendor tags for this tab (e.g., `cisco-iosxe-router`, `generic`). Sourced from `derive_tags`; not configurable here.
- Multi-select chip row of user tags from `taxonomy.user`. Each chip shows `(N)` for `usage_count`. Toggling updates `activeUserTagsByTab[tabId]`.
- Helper line: "Filters citations to docs tagged with all of the above. Vendor tags use OR; your tags use AND."

If `taxonomy.user` is empty, hide the user-tag row entirely; replace with a one-line link to Settings → RAG.

### Chat retrieval call site

```ts
const builtin = derivedTagsForTab(tabId);
const user = ragStore.getActiveUserTags(tabId);
await ragRetrieve({ query, tags: [...builtin, ...user], k });
```

## Testing

### Rust

- `tags.rs` — `validate_tag_shape` accepts `customer-acme`; rejects `Customer-ACME`, `-leading`, `bad space`, 33-char string. Reserved-prefix rejects `cisco-foo`, `juniper-x`, `arista-foo`; accepts the seven builtins by exact match.
- `tags.rs` — `is_builtin_tag` returns true for every member of `TAG_TAXONOMY`, false for `customer-acme`.
- `store.rs` — round-trip a doc with `["cisco-iosxe-router", "customer-acme"]`; `list_user_tags()` returns `[("customer-acme", 1)]` after one upload, `("customer-acme", 2)` after a second; `set_tags` rejects a reserved-prefix tag.
- `retrieve.rs` — three new cases: subset-of-one passes, subset-of-two with one missing fails, two user tags both present passes. Existing cases continue to pass with an empty `user_set`.

### Frontend (vitest)

- `RagUploadModal` — typing into `+ New tag` and pressing Enter creates a selected chip; invalid shape surfaces the helper; typing an existing tag selects rather than duplicates.
- `ragStore` — `activeUserTagsByTab` toggles correctly and persists via the existing tab-state mechanism.
- `lib/rag.test.ts` — `TAG_SHAPE_RE` and `isReservedPrefix` match the Rust regex on shared fixtures.

### Manual smoke

1. Restart the dev app. Upload a PDF — verify it ingests (validates the unrelated bundled-python fix is sticky).
2. Settings → RAG → drop a PDF → click `+ New tag` → type `customer-acme` → Enter → also pick `cisco-iosxe-router` → upload.
3. Open a chat tab inferred as cisco-iosxe-router. In the Sources drawer, toggle `customer-acme` on. Ask a question — only the customer-acme-tagged Cisco doc should appear in cited chunks.
4. Toggle `customer-acme` off — both Cisco docs become eligible again.

## Rollout

- No DB migration.
- `rag_tag_taxonomy` shape change is breaking; only one frontend consumer and one test consume it. Both ship in the same change set.
- `RagTag` widens from union to `string`. Existing call sites that passed builtin tags continue to type-check.
- No existing user-tag data to backfill.

## Out of scope (follow-ups)

- Tag rename / merge / delete UI in Settings → RAG.
- Per-tag color or description.
- Importing tags from a doc's metadata at upload time.
- Cross-tab default for active user tags.

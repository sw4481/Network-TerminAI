# Configurable Vendor Keywords in Settings

**Date:** 2026-07-09
**Status:** Approved — decisions confirmed 2026-07-09

## Problem

The Network Architect routes a question to a vendor's helper by matching the
question text against `VENDOR_KEYWORDS` — a hardcoded module-level dict in
`sidecar/src/ccie_sidecar/agents/architect_subagents.py`. These keywords power
three routing fixes (deterministic hint, history scoping, platform-aware rubric),
all funneled through `detect_vendor_ids()`.

Because the keyword lists are hardcoded, a user cannot teach the router their own
site nicknames (e.g. "my-campus-auth" → ISE) or correct a mis-route without a
code change and sidecar rebuild. This spec makes the keyword lists editable from
the Settings GUI, taking effect on the next agent turn (no restart).

## Design decisions

Three product decisions, confirmed by the user 2026-07-09:

1. **Edit semantics — replace per vendor, pre-seeded with built-in defaults.**
   The editor loads each vendor's list pre-filled with the current built-ins, so
   saving *replaces* that vendor's keyword set and "Reset to defaults" deletes the
   override entry (falling back to built-ins). Lets the user both add AND remove
   aliases, while the pre-seed prevents the accidental empty-list foot-gun.

2. **Vendor scope — all 14 vendors.** The editor lists every vendor in
   `VENDOR_SPECS` regardless of whether credentials are configured, so keywords
   can be pre-tuned before a vendor is set up. No configured-vendor filtering.

3. **UI placement — one dedicated "Vendor Keywords" Settings tab.** All routing
   keywords in one place, rather than scattered inline across vendor tabs (which
   would also miss vendors that lack a settings tab).

## Data model

Overrides are stored as a single JSON blob in the existing `app_flags`
key/value table (the same table the context-graph flag uses), under key
`ccie_vendor_keywords`:

```json
{
  "ise":  ["ise", "identity services engine", "nad", "radius", "my-campus-auth"],
  "mist": ["mist", "juniper", "wlan", "wireless-lab"]
}
```

- A vendor **absent** from the JSON uses its built-in `VENDOR_KEYWORDS` list.
- A vendor **present** with a list **replaces** the built-in for that vendor.
- **No DB migration required** — `app_flags` is created on demand by the Rust
  command (mirrors `context_graph_get/set_enabled`). Next free migration remains
  V0074 if a typed table is ever preferred later.

## Components

### 1. Sidecar read path (`architect_subagents.py`)

Add a defensive loader and make `detect_vendor_ids()` override-aware:

```python
def _load_keyword_overrides() -> dict[str, list[str]]:
    """Read the ccie_vendor_keywords JSON blob from app_flags.
    Returns {} on any error (missing DB, missing row, bad JSON) so routing
    always degrades to the hardcoded VENDOR_KEYWORDS default."""
    # reuse feature_flags._db_path(); SELECT value FROM app_flags WHERE key=?
```

`detect_vendor_ids()` builds an **effective** keyword map at call time:
`effective = {**VENDOR_KEYWORDS, **_load_keyword_overrides()}` and reads
`effective.get(vid, [])` instead of the module dict directly. All three
consumers (`architect_routing_hint`, `scope_history_for_question`, and the
runtime's `_platform_aware_rubric`) inherit the override automatically because
they all call `detect_vendor_ids()`.

- Effect is immediate on the next agent turn (read happens per-call).
- Errors swallow to the built-in default, matching `get_ise_config()`'s pattern.
- Keyword matching semantics are unchanged (whole-word for single tokens,
  substring for phrases containing a space).

### 2. Rust command pair (`src-tauri/src/commands/mod.rs` + `lib.rs`)

Modeled on `context_graph_get_enabled` / `context_graph_set_enabled`:

```rust
#[tauri::command]
pub async fn vendor_keywords_get(state: State<'_, AppState>) -> Result<String, String>;
// ensures app_flags exists; returns the JSON string, or "{}" if unset.

#[tauri::command]
pub async fn vendor_keywords_set(state: State<'_, AppState>, keywords: String) -> Result<(), String>;
// ensures app_flags exists; upserts ccie_vendor_keywords = <json string>.
```

JSON is passed as an opaque string; shape validation lives in TS + Python which
know the vendor ids. Register both in the `generate_handler!` list in `lib.rs`
(next to the ISE/Mist command registrations).

### 3. Built-in defaults exposure (single source of truth)

To pre-seed the editor, the frontend needs the built-in defaults, which live in
Python. **Recommended:** expose them from the sidecar so there's one source of
truth. Options to confirm in review:

- **(rec)** A sidecar RPC / small Tauri command `vendor_keyword_defaults` that
  returns `{vid: {display, keywords}}` from `VENDOR_SPECS` + `VENDOR_KEYWORDS`
  for all 14 vendors (display name + built-in keyword list). The tab merges these
  defaults with the saved override for display.
- Duplicate the defaults in TS (rejected — drifts from Python over time).

### 4. TS client (`src/lib/tauri.ts`)

```ts
export const vendorKeywordsGet = () => invoke<string>("vendor_keywords_get");
export const vendorKeywordsSet = (keywords: string) =>
  invoke<void>("vendor_keywords_set", { keywords });
// plus vendorKeywordDefaults() if we expose defaults via a command
```

### 5. React tab (`src/components/settings/VendorKeywordsSettingsTab.tsx`)

Modeled on `IseSettingsTab.tsx` (load-on-mount → edit local state → save):

- On mount: fetch built-in defaults (all 14 vendors, with display names) + saved
  override JSON.
- Render one editable keyword field (comma/newline separated) per vendor (all
  14, in `VENDOR_SPECS` order), pre-filled with `override[vid] ?? defaults[vid]`.
- **Save:** serialize non-default vendor entries to JSON, call `vendorKeywordsSet`.
- **Reset to defaults** (per vendor): remove that vendor's key from the override
  object and save.
- Wire into `Settings.tsx`: add `"vendorKeywords"` to the tab-id string union
  (~line 89), a tab button (~line 512 block), and a render branch (~line 1110).

## Data flow

```
Settings tab  --vendorKeywordsSet(json)-->  Tauri cmd  --upsert-->  app_flags(ccie_vendor_keywords)
                                                                          |
Next agent turn: detect_vendor_ids() --_load_keyword_overrides()--> reads app_flags --> effective map
```

## Error handling

- Bad/absent DB or JSON in the sidecar loader → `{}` → built-in defaults (routing
  never breaks).
- Rust get on unset key → `"{}"`.
- Frontend: invalid JSON never reaches Rust (built from structured state); a
  failed save surfaces an inline error like `IseSettingsTab`.

## Testing

- **Python** (`tests/agents/test_architect_routing.py`):
  - override JSON adds a new alias → `detect_vendor_ids` matches it.
  - override replaces a vendor's list → old built-in alias no longer matches,
    other vendors unaffected.
  - malformed JSON / missing row → falls back to built-ins (no exception).
- **Rust:** `vendor_keywords_get` returns `"{}"` when unset; `set`→`get`
  round-trips a JSON string; table auto-created.
- **TS** (vitest, mocked invoke): tab loads defaults+override, edits a field and
  saves the expected JSON, "reset" removes a vendor's override.

## Out of scope

- Editing keywords for the non-architect loops (they don't use vendor routing).
- A migration / typed table (app_flags KV is sufficient).
- Regex or weighted keywords — lists of literal aliases only, as today.

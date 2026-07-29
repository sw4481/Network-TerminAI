# Configurable Vendor Keywords Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user edit the Network Architect's per-vendor routing keywords from a dedicated Settings tab, taking effect on the next agent turn with no rebuild or restart.

**Architecture:** Overrides are stored as one JSON blob in the existing `app_flags` KV table (key `ccie_vendor_keywords`) via a Rust get/set command pair mirroring `context_graph_get/set_enabled`. The sidecar's `detect_vendor_ids()` reads and merges the override over the hardcoded `VENDOR_KEYWORDS` at call time. The built-in defaults (single source of truth in Python) are exposed to the frontend via a sidecar RPC bridged by a Rust command. A React tab (modeled on `IseSettingsTab`) edits and saves the JSON.

**Tech Stack:** Python 3.12 (sidecar), Rust/Tauri (`rusqlite`, `refinery`), React + TypeScript (Vite), pytest / cargo test / vitest.

## Global Constraints

- Storage: reuse the `app_flags` KV table; **no DB migration** (table is created on demand by the Rust command via `CREATE TABLE IF NOT EXISTS`). Next free migration remains V0074 if ever needed.
- The hardcoded `VENDOR_KEYWORDS` dict remains the fallback for every vendor; all override reads must degrade to it on any error (missing DB/row, bad JSON) — never raise.
- Edit semantics: **replace per vendor** — a vendor present in the override JSON fully replaces its built-in list; a vendor absent uses built-ins.
- Scope: **all 14 vendors** in `VENDOR_SPECS` order (`aci, gnmi, fmc, thousandeyes, cml, ise, secure_endpoint, cisco_xdr, stealthwatch, catalyst_center, splunk, meraki, mist, pyats`) — no configured-vendor filtering.
- UI: one dedicated "Vendor Keywords" Settings tab.
- Keyword matching semantics are unchanged (single token → whole-word regex; phrase with a space → substring), case-insensitive.
- app_flags key constant: `ccie_vendor_keywords`. Sidecar RPC method: `architect.keyword_defaults`.

---

### Task 1: Sidecar — override loader + override-aware detection

**Files:**
- Modify: `sidecar/src/ccie_sidecar/agents/architect_subagents.py` (add loader; change `detect_vendor_ids` read site around lines 259)
- Test: `sidecar/tests/agents/test_architect_routing.py` (append cases)

**Interfaces:**
- Consumes: `feature_flags._db_path()` (returns `pathlib.Path` to sessions.db); module dict `VENDOR_KEYWORDS: dict[str, list[str]]`; `VENDOR_SPECS`.
- Produces:
  - `load_keyword_overrides() -> dict[str, list[str]]` — parsed override map, `{}` on any error.
  - `effective_keywords() -> dict[str, list[str]]` — `{**VENDOR_KEYWORDS, **load_keyword_overrides()}`, restricted to known vendor ids.
  - `detect_vendor_ids()` unchanged signature, now reads `effective_keywords()`.

- [ ] **Step 1: Write the failing tests**

Append to `sidecar/tests/agents/test_architect_routing.py`:

```python
# --- keyword overrides (Settings-configurable) -----------------------------

import json
import sqlite3
import ccie_sidecar.agents.architect_subagents as arch


def _seed_overrides(tmp_path, monkeypatch, blob):
    """Point the override loader at a temp sessions.db holding `blob`."""
    db = tmp_path / "sessions.db"
    conn = sqlite3.connect(str(db))
    conn.execute(
        "CREATE TABLE app_flags (key TEXT PRIMARY KEY, value TEXT NOT NULL)"
    )
    if blob is not None:
        conn.execute(
            "INSERT INTO app_flags(key, value) VALUES ('ccie_vendor_keywords', ?)",
            (blob,),
        )
    conn.commit()
    conn.close()
    monkeypatch.setattr(arch, "_db_path", lambda: db)


def test_override_adds_new_alias(tmp_path, monkeypatch):
    _seed_overrides(tmp_path, monkeypatch,
                    json.dumps({"ise": ["ise", "my-campus-auth"]}))
    assert arch.detect_vendor_ids("check my-campus-auth sessions", ["ise"]) == ["ise"]


def test_override_replaces_and_drops_builtin(tmp_path, monkeypatch):
    # Override ISE with a list that omits the word "radius".
    _seed_overrides(tmp_path, monkeypatch, json.dumps({"ise": ["ise"]}))
    # "radius" no longer routes to ISE (built-in replaced).
    assert arch.detect_vendor_ids("radius timeout", ["ise"]) == []
    # A different vendor is untouched by an ISE-only override.
    assert arch.detect_vendor_ids("list mist wlans", ["mist"]) == ["mist"]


def test_override_malformed_json_falls_back(tmp_path, monkeypatch):
    _seed_overrides(tmp_path, monkeypatch, "{not valid json")
    assert arch.detect_vendor_ids("list my ISE devices", ["ise"]) == ["ise"]


def test_override_missing_db_uses_builtins(tmp_path, monkeypatch):
    monkeypatch.setattr(arch, "_db_path", lambda: tmp_path / "nope.db")
    assert arch.detect_vendor_ids("list my ISE devices", ["ise"]) == ["ise"]


def test_override_unknown_vendor_ignored(tmp_path, monkeypatch):
    _seed_overrides(tmp_path, monkeypatch,
                    json.dumps({"bogus": ["x"], "ise": ["ise", "widget"]}))
    eff = arch.effective_keywords()
    assert "bogus" not in eff
    assert "widget" in eff["ise"]
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd sidecar && .venv/bin/python -m pytest tests/agents/test_architect_routing.py -k override -v`
Expected: FAIL — `AttributeError: module ... has no attribute '_db_path'` / `effective_keywords`.

- [ ] **Step 3: Implement the loader and wire detection**

In `sidecar/src/ccie_sidecar/agents/architect_subagents.py`, add near the top imports (after `import re`):

```python
import json
import sqlite3
```

Add after the `VENDOR_KEYWORDS` dict (after line ~229):

```python
# Settings-configurable overrides. A single JSON blob in the app_flags KV table
# (key ccie_vendor_keywords) maps vendor id -> keyword list and REPLACES that
# vendor's built-in list. Read at call time so Settings edits take effect on the
# next agent turn with no restart. Any error -> {} -> built-in defaults.
_VENDOR_KEYWORDS_FLAG_KEY = "ccie_vendor_keywords"

_VALID_VENDOR_IDS = {s["id"] for s in VENDOR_SPECS}


def _db_path():
    """sessions.db path (delegates to feature_flags so both read one location)."""
    from ccie_sidecar.feature_flags import _db_path as _ff_db_path
    return _ff_db_path()


def load_keyword_overrides() -> dict[str, list[str]]:
    """Parse the ccie_vendor_keywords JSON blob from app_flags.

    Returns {vid: [keywords]} for known vendor ids only. {} on any error
    (missing DB/table/row, bad JSON, wrong shape) so routing always degrades
    to the hardcoded VENDOR_KEYWORDS default.
    """
    db = _db_path()
    try:
        if not db.exists():
            return {}
        conn = sqlite3.connect(str(db))
        try:
            cur = conn.cursor()
            cur.execute(
                "SELECT value FROM app_flags WHERE key = ?",
                (_VENDOR_KEYWORDS_FLAG_KEY,),
            )
            row = cur.fetchone()
        finally:
            conn.close()
        if not row or row[0] is None:
            return {}
        parsed = json.loads(row[0])
        if not isinstance(parsed, dict):
            return {}
        out: dict[str, list[str]] = {}
        for vid, kws in parsed.items():
            if vid in _VALID_VENDOR_IDS and isinstance(kws, list):
                cleaned = [str(k).strip().lower() for k in kws if str(k).strip()]
                if cleaned:
                    out[vid] = cleaned
        return out
    except Exception:
        return {}


def effective_keywords() -> dict[str, list[str]]:
    """Built-in VENDOR_KEYWORDS with per-vendor overrides applied (replace)."""
    return {**VENDOR_KEYWORDS, **load_keyword_overrides()}
```

Then change the read site inside `detect_vendor_ids` (currently line ~259). Replace:

```python
    low = text.lower()
    found: List[str] = []
    for spec in VENDOR_SPECS:
        vid = spec["id"]
        if restrict_to is not None and vid not in restrict_to:
            continue
        for kw in VENDOR_KEYWORDS.get(vid, []):
```

with:

```python
    low = text.lower()
    keywords = effective_keywords()
    found: List[str] = []
    for spec in VENDOR_SPECS:
        vid = spec["id"]
        if restrict_to is not None and vid not in restrict_to:
            continue
        for kw in keywords.get(vid, []):
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd sidecar && .venv/bin/python -m pytest tests/agents/test_architect_routing.py -v`
Expected: PASS (all prior + 5 new override tests).

- [ ] **Step 5: Commit**

```bash
git add sidecar/src/ccie_sidecar/agents/architect_subagents.py sidecar/tests/agents/test_architect_routing.py
git commit -m "feat(architect): read Settings-configurable vendor keyword overrides"
```

---

### Task 2: Sidecar RPC — expose built-in keyword defaults

**Files:**
- Modify: `sidecar/src/ccie_sidecar/server.py` (add an `elif method == "architect.keyword_defaults"` branch near the `iac.analyze_drift` branch at line ~551)
- Test: `sidecar/tests/test_server.py` (append a case)

**Interfaces:**
- Consumes: `architect_subagents.VENDOR_SPECS`, `VENDOR_KEYWORDS`.
- Produces: RPC `architect.keyword_defaults` returning
  `{"id", "type": "done", "result": {"vendors": [{"id", "display", "keywords": [...]}, ...]}}`
  in `VENDOR_SPECS` order, all 14 vendors.

- [ ] **Step 1: Write the failing test**

Append to `sidecar/tests/test_server.py` (match the file's existing dispatch-call style — it calls the same handler `server.py` uses; if the handler is `handle_request`, use that name):

```python
def test_architect_keyword_defaults_lists_all_vendors():
    import asyncio
    from ccie_sidecar import server

    req = {"id": "1", "method": "architect.keyword_defaults", "params": {}}
    resp = asyncio.get_event_loop().run_until_complete(server.handle_request(req))

    assert resp["type"] == "done"
    vendors = resp["result"]["vendors"]
    ids = [v["id"] for v in vendors]
    # All 14 vendors, in VENDOR_SPECS order.
    assert ids == [
        "aci", "gnmi", "fmc", "thousandeyes", "cml", "ise", "secure_endpoint",
        "cisco_xdr", "stealthwatch", "catalyst_center", "splunk", "meraki",
        "mist", "pyats",
    ]
    ise = next(v for v in vendors if v["id"] == "ise")
    assert ise["display"] == "Cisco ISE (identity)"
    assert "radius" in ise["keywords"]
```

> Note for implementer: open `sidecar/tests/test_server.py` first and mirror how existing tests invoke the dispatcher (function name and sync/async wrapper). `server.py:78` reads `req.get("method")`; find the enclosing `async def` and call it the same way the existing tests do. Adjust `handle_request` to the real name if different.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd sidecar && .venv/bin/python -m pytest tests/test_server.py -k keyword_defaults -v`
Expected: FAIL — response `type` is `error` ("unknown method") or KeyError.

- [ ] **Step 3: Implement the RPC branch**

In `sidecar/src/ccie_sidecar/server.py`, add immediately after the `iac.analyze_drift` branch closes (after line ~569):

```python
    elif method == "architect.keyword_defaults":
        # Settings → Vendor Keywords tab: the built-in routing keyword defaults
        # (single source of truth lives in Python). The tab merges these with the
        # saved override for display. Read-only; never fatal.
        try:
            from ccie_sidecar.agents.architect_subagents import (
                VENDOR_SPECS,
                VENDOR_KEYWORDS,
            )
            vendors = [
                {
                    "id": s["id"],
                    "display": s["display"],
                    "keywords": list(VENDOR_KEYWORDS.get(s["id"], [])),
                }
                for s in VENDOR_SPECS
            ]
            return {"id": req_id, "type": "done", "result": {"vendors": vendors}}
        except Exception as e:
            return {"id": req_id, "type": "error", "message": str(e)}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd sidecar && .venv/bin/python -m pytest tests/test_server.py -k keyword_defaults -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add sidecar/src/ccie_sidecar/server.py sidecar/tests/test_server.py
git commit -m "feat(architect): expose built-in vendor keyword defaults over RPC"
```

---

### Task 3: Rust — get/set commands + defaults bridge + registration

**Files:**
- Modify: `src-tauri/src/commands/mod.rs` (add three commands after `context_graph_set_enabled` at line ~3801)
- Modify: `src-tauri/src/lib.rs` (register three commands after line 369)
- Test: `src-tauri/tests/commands_test.rs` (append round-trip test)

**Interfaces:**
- Consumes: `AppState { db: Arc<Mutex<Connection>>, agent }`; `agent.call(method, params) -> AgentResponse::Done { result }` (see `iac_check_drift` at mod.rs:4880).
- Produces (Tauri commands):
  - `vendor_keywords_get(state) -> Result<String, String>` — JSON string, `"{}"` if unset.
  - `vendor_keywords_set(state, keywords: String) -> Result<(), String>` — upserts.
  - `vendor_keyword_defaults(state) -> Result<serde_json::Value, String>` — proxies the `architect.keyword_defaults` sidecar RPC.

- [ ] **Step 1: Write the failing test**

Append to `src-tauri/tests/commands_test.rs` (match the file's existing AppState/test-DB setup — reuse whatever helper the other tests use to build an in-memory `AppState`; the round-trip logic is what matters):

```rust
#[test]
fn vendor_keywords_round_trip() {
    use rusqlite::Connection;
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS app_flags (\
            key TEXT PRIMARY KEY, value TEXT NOT NULL,\
            updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now')));",
    )
    .unwrap();

    // Unset -> read yields "{}".
    let got: Option<String> = conn
        .query_row(
            "SELECT value FROM app_flags WHERE key = 'ccie_vendor_keywords'",
            [],
            |r| r.get(0),
        )
        .ok();
    assert!(got.is_none());

    // Set -> read yields the stored JSON verbatim.
    let blob = r#"{"ise":["ise","my-auth"]}"#;
    conn.execute(
        "INSERT OR REPLACE INTO app_flags(key, value) VALUES ('ccie_vendor_keywords', ?1)",
        rusqlite::params![blob],
    )
    .unwrap();
    let got: String = conn
        .query_row(
            "SELECT value FROM app_flags WHERE key = 'ccie_vendor_keywords'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(got, blob);
}
```

> This test locks the storage contract (table + key + upsert) that the commands depend on. It compiles/runs without constructing a full `AppState`.

- [ ] **Step 2: Run test to verify it fails/passes-as-contract**

Run: `cd src-tauri && cargo test --test commands_test vendor_keywords_round_trip`
Expected: PASS (it asserts the SQL contract the commands will implement). If the crate doesn't compile yet because Step 3 isn't done, that's fine — do Step 3, then re-run.

- [ ] **Step 3: Implement the three commands**

In `src-tauri/src/commands/mod.rs`, add after `context_graph_set_enabled` (after line 3801):

```rust
/// Per-vendor routing keyword overrides for the Network Architect. Stored as one
/// JSON blob in app_flags under `ccie_vendor_keywords`; the sidecar
/// (`architect_subagents.load_keyword_overrides`) reads the same key and REPLACES
/// a vendor's built-in keyword list with the stored one. Edits take effect on the
/// next agent turn — no restart.
const VENDOR_KEYWORDS_FLAG_KEY: &str = "ccie_vendor_keywords";

#[tauri::command]
pub fn vendor_keywords_get(state: State<'_, AppState>) -> Result<String, String> {
    let db = state.db.lock();
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS app_flags (\
            key TEXT PRIMARY KEY,\
            value TEXT NOT NULL,\
            updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))\
        );",
    )
    .map_err(|e| format!("Failed to ensure app_flags: {}", e))?;

    let value: Option<String> = db
        .query_row(
            "SELECT value FROM app_flags WHERE key = ?1",
            rusqlite::params![VENDOR_KEYWORDS_FLAG_KEY],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| format!("Failed to read vendor keywords: {}", e))?;

    Ok(value.unwrap_or_else(|| "{}".to_string()))
}

#[tauri::command]
pub fn vendor_keywords_set(
    state: State<'_, AppState>,
    keywords: String,
) -> Result<(), String> {
    // Validate it parses as a JSON object before persisting (defense in depth;
    // the sidecar also degrades gracefully on bad JSON).
    let parsed: serde_json::Value =
        serde_json::from_str(&keywords).map_err(|e| format!("Invalid JSON: {}", e))?;
    if !parsed.is_object() {
        return Err("Vendor keywords must be a JSON object".to_string());
    }

    let db = state.db.lock();
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS app_flags (\
            key TEXT PRIMARY KEY,\
            value TEXT NOT NULL,\
            updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))\
        );",
    )
    .map_err(|e| format!("Failed to ensure app_flags: {}", e))?;

    db.execute(
        "INSERT OR REPLACE INTO app_flags(key, value) VALUES (?1, ?2)",
        rusqlite::params![VENDOR_KEYWORDS_FLAG_KEY, keywords],
    )
    .map_err(|e| format!("Failed to save vendor keywords: {}", e))?;

    Ok(())
}

/// Built-in keyword defaults (display name + keyword list per vendor), proxied
/// from the sidecar so Python stays the single source of truth. Returns the
/// sidecar's `{"vendors": [...]}` result. Errors surface to the caller.
#[tauri::command]
pub async fn vendor_keyword_defaults(
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let resp = state
        .agent
        .call("architect.keyword_defaults", serde_json::json!({}))
        .await
        .map_err(|e| format!("Sidecar call failed: {}", e))?;
    match resp {
        crate::agent_bridge::AgentResponse::Done { result } => Ok(result),
        other => Err(format!("Unexpected sidecar response: {:?}", other)),
    }
}
```

In `src-tauri/src/lib.rs`, add after line 369 (`commands::context_graph_set_enabled,`):

```rust
            commands::vendor_keywords_get,
            commands::vendor_keywords_set,
            commands::vendor_keyword_defaults,
```

- [ ] **Step 4: Build and run the test**

Run: `cd src-tauri && cargo build 2>&1 | tail -5 && cargo test --test commands_test vendor_keywords_round_trip`
Expected: build succeeds; test PASSES.

> If `AgentResponse` variant names differ, grep `src-tauri/src/agent_bridge.rs` for the enum and match the real `Done { result }` variant (it is used verbatim at `mod.rs:4881`).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/commands/mod.rs src-tauri/src/lib.rs src-tauri/tests/commands_test.rs
git commit -m "feat(architect): Tauri commands for vendor keyword overrides + defaults"
```

---

### Task 4: TS client wrappers

**Files:**
- Modify: `src/lib/tauri.ts` (add after the context-graph wrappers at line ~1588)

**Interfaces:**
- Consumes: the three Task 3 commands.
- Produces:
  - `type VendorKeywordDefault = { id: string; display: string; keywords: string[] }`
  - `vendorKeywordsGet(): Promise<string>` (JSON string)
  - `vendorKeywordsSet(keywords: string): Promise<void>`
  - `vendorKeywordDefaults(): Promise<{ vendors: VendorKeywordDefault[] }>`

- [ ] **Step 1: Add the wrappers**

In `src/lib/tauri.ts`, after line 1588 (the `contextGraphSetStaleness` export):

```ts
// Network Architect per-vendor routing keyword overrides. Stored in app_flags
// (key ccie_vendor_keywords); the sidecar merges them over built-in defaults at
// agent-turn time. Defaults come from the sidecar (Python is source of truth).
export type VendorKeywordDefault = {
  id: string;
  display: string;
  keywords: string[];
};

export const vendorKeywordsGet = () =>
  invoke<string>("vendor_keywords_get");

export const vendorKeywordsSet = (keywords: string) =>
  invoke<void>("vendor_keywords_set", { keywords });

export const vendorKeywordDefaults = () =>
  invoke<{ vendors: VendorKeywordDefault[] }>("vendor_keyword_defaults");
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit 2>&1 | grep tauri.ts || echo "tauri.ts clean"`
Expected: `tauri.ts clean`.

- [ ] **Step 3: Commit**

```bash
git add src/lib/tauri.ts
git commit -m "feat(architect): TS client for vendor keyword overrides"
```

---

### Task 5: React — VendorKeywordsSettingsTab component

**Files:**
- Create: `src/components/settings/VendorKeywordsSettingsTab.tsx`
- Create: `src/components/settings/VendorKeywordsSettingsTab.css`
- Test: `src/components/settings/VendorKeywordsSettingsTab.test.tsx`

**Interfaces:**
- Consumes: `vendorKeywordDefaults`, `vendorKeywordsGet`, `vendorKeywordsSet`, `type VendorKeywordDefault` from `../../lib/tauri`.
- Produces: default-exported `VendorKeywordsSettingsTab` component.

Behavior contract:
- On mount: load defaults (all 14 vendors) + saved override JSON. For each vendor, the textarea shows `override[id]` if present, else `defaults[id].keywords`, joined by `, `.
- Track per-vendor "is overridden" so Save only writes vendors whose text differs from their default list (keeps the blob minimal; a vendor equal to default is omitted → falls back to built-in).
- Save: build `{id: [keywords]}` (split on comma/newline, trim, drop empties) for overridden vendors, `JSON.stringify`, call `vendorKeywordsSet`.
- "Reset to defaults" (per vendor): set the textarea back to the default list and mark it not-overridden.

- [ ] **Step 1: Write the failing test**

Create `src/components/settings/VendorKeywordsSettingsTab.test.tsx`:

```tsx
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import VendorKeywordsSettingsTab from './VendorKeywordsSettingsTab';
import * as tauri from '../../lib/tauri';

vi.mock('../../lib/tauri', () => ({
  vendorKeywordDefaults: vi.fn(),
  vendorKeywordsGet: vi.fn(),
  vendorKeywordsSet: vi.fn(),
}));

const DEFAULTS = {
  vendors: [
    { id: 'ise', display: 'Cisco ISE (identity)', keywords: ['ise', 'radius'] },
    { id: 'mist', display: 'Juniper Mist', keywords: ['mist', 'juniper'] },
  ],
};

describe('VendorKeywordsSettingsTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(tauri.vendorKeywordDefaults).mockResolvedValue(DEFAULTS as any);
    vi.mocked(tauri.vendorKeywordsGet).mockResolvedValue('{}');
    vi.mocked(tauri.vendorKeywordsSet).mockResolvedValue(undefined);
  });

  it('renders a field per vendor pre-filled with defaults', async () => {
    render(<VendorKeywordsSettingsTab />);
    await waitFor(() => {
      expect(screen.getByText('Cisco ISE (identity)')).toBeInTheDocument();
      expect(screen.getByDisplayValue('ise, radius')).toBeInTheDocument();
      expect(screen.getByDisplayValue('mist, juniper')).toBeInTheDocument();
    });
  });

  it('pre-fills a saved override over the default', async () => {
    vi.mocked(tauri.vendorKeywordsGet).mockResolvedValue(
      JSON.stringify({ ise: ['ise', 'my-auth'] }),
    );
    render(<VendorKeywordsSettingsTab />);
    await waitFor(() => {
      expect(screen.getByDisplayValue('ise, my-auth')).toBeInTheDocument();
    });
  });

  it('saves only vendors edited away from their default', async () => {
    render(<VendorKeywordsSettingsTab />);
    const iseField = await screen.findByDisplayValue('ise, radius');
    fireEvent.change(iseField, { target: { value: 'ise, radius, my-auth' } });
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
    await waitFor(() => {
      expect(tauri.vendorKeywordsSet).toHaveBeenCalledWith(
        JSON.stringify({ ise: ['ise', 'radius', 'my-auth'] }),
      );
    });
  });

  it('reset restores a vendor to its default and drops it from the save', async () => {
    vi.mocked(tauri.vendorKeywordsGet).mockResolvedValue(
      JSON.stringify({ ise: ['ise', 'my-auth'] }),
    );
    render(<VendorKeywordsSettingsTab />);
    const resetBtns = await screen.findAllByRole('button', { name: /reset/i });
    fireEvent.click(resetBtns[0]);
    await waitFor(() => {
      expect(screen.getByDisplayValue('ise, radius')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
    await waitFor(() => {
      expect(tauri.vendorKeywordsSet).toHaveBeenCalledWith('{}');
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/settings/VendorKeywordsSettingsTab.test.tsx`
Expected: FAIL — cannot resolve `./VendorKeywordsSettingsTab`.

- [ ] **Step 3: Implement the component**

Create `src/components/settings/VendorKeywordsSettingsTab.tsx`:

```tsx
import { useState, useEffect } from 'react';
import {
  vendorKeywordDefaults,
  vendorKeywordsGet,
  vendorKeywordsSet,
  type VendorKeywordDefault,
} from '../../lib/tauri';
import './VendorKeywordsSettingsTab.css';

type StatusKind = 'ok' | 'err' | 'info';

// Split a textarea value into a clean keyword list (comma or newline separated).
function parseKeywords(text: string): string[] {
  return text
    .split(/[,\n]/)
    .map((k) => k.trim().toLowerCase())
    .filter((k) => k.length > 0);
}

// Two keyword lists are equal (order-sensitive, already normalized).
function sameList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

export default function VendorKeywordsSettingsTab() {
  const [defaults, setDefaults] = useState<VendorKeywordDefault[]>([]);
  // vendor id -> current textarea text
  const [text, setText] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<{ kind: StatusKind; text: string } | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const [def, overrideJson] = await Promise.all([
          vendorKeywordDefaults(),
          vendorKeywordsGet(),
        ]);
        const vendors = def.vendors;
        setDefaults(vendors);
        let override: Record<string, string[]> = {};
        try {
          const parsed = JSON.parse(overrideJson || '{}');
          if (parsed && typeof parsed === 'object') override = parsed;
        } catch {
          override = {};
        }
        const initial: Record<string, string> = {};
        for (const v of vendors) {
          const list = Array.isArray(override[v.id]) ? override[v.id] : v.keywords;
          initial[v.id] = list.join(', ');
        }
        setText(initial);
      } catch (e) {
        setStatus({ kind: 'err', text: `Failed to load: ${String(e)}` });
      }
    })();
  }, []);

  const resetVendor = (v: VendorKeywordDefault) => {
    setText((t) => ({ ...t, [v.id]: v.keywords.join(', ') }));
  };

  const save = async () => {
    setSaving(true);
    try {
      // Only include vendors whose list differs from their built-in default.
      const blob: Record<string, string[]> = {};
      for (const v of defaults) {
        const current = parseKeywords(text[v.id] ?? '');
        if (!sameList(current, v.keywords)) {
          blob[v.id] = current;
        }
      }
      await vendorKeywordsSet(JSON.stringify(blob));
      setStatus({ kind: 'ok', text: 'Vendor keywords saved.' });
    } catch (e) {
      setStatus({ kind: 'err', text: `Save failed: ${String(e)}` });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="vkw-tab">
      <div className="vkw-header">
        <h2>Vendor Routing Keywords</h2>
        <p className="vkw-subtitle">
          The Network Architect routes a question to a platform by matching these
          keywords. Edits replace that vendor's built-in list and take effect on
          the next agent turn. Comma- or newline-separated; case-insensitive.
        </p>
      </div>

      {defaults.map((v) => (
        <div className="vkw-vendor" key={v.id}>
          <div className="vkw-vendor-head">
            <label htmlFor={`vkw-${v.id}`}>{v.display}</label>
            <button
              type="button"
              className="vkw-reset"
              onClick={() => resetVendor(v)}
            >
              Reset to defaults
            </button>
          </div>
          <textarea
            id={`vkw-${v.id}`}
            aria-label={v.display}
            rows={2}
            value={text[v.id] ?? ''}
            onChange={(e) => setText((t) => ({ ...t, [v.id]: e.target.value }))}
          />
        </div>
      ))}

      <div className="vkw-actions">
        <button onClick={save} disabled={saving} className="vkw-btn-primary">
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>

      {status && (
        <div className={`vkw-status vkw-status--${status.kind}`}>{status.text}</div>
      )}
    </div>
  );
}
```

Create `src/components/settings/VendorKeywordsSettingsTab.css`:

```css
.vkw-tab { padding: 16px 20px; max-width: 720px; }
.vkw-header h2 { margin: 0 0 4px; }
.vkw-subtitle { color: var(--text-secondary, #8a8f98); font-size: 13px; margin: 0 0 16px; }
.vkw-vendor { margin-bottom: 14px; }
.vkw-vendor-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px; }
.vkw-vendor-head label { font-weight: 600; }
.vkw-reset { background: none; border: none; color: var(--accent, #5b8cff); cursor: pointer; font-size: 12px; padding: 0; }
.vkw-tab textarea { width: 100%; font-family: var(--font-mono, monospace); font-size: 13px; padding: 6px 8px; box-sizing: border-box; resize: vertical; }
.vkw-actions { margin-top: 20px; }
.vkw-btn-primary { padding: 6px 18px; }
.vkw-status { margin-top: 12px; padding: 8px 12px; border-radius: 6px; font-size: 13px; }
.vkw-status--ok { background: rgba(46,160,67,0.15); }
.vkw-status--err { background: rgba(248,81,73,0.15); }
.vkw-status--info { background: rgba(91,140,255,0.15); }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/components/settings/VendorKeywordsSettingsTab.test.tsx`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/components/settings/VendorKeywordsSettingsTab.tsx src/components/settings/VendorKeywordsSettingsTab.css src/components/settings/VendorKeywordsSettingsTab.test.tsx
git commit -m "feat(architect): Vendor Keywords settings tab component"
```

---

### Task 6: Wire the tab into Settings.tsx

**Files:**
- Modify: `src/windows/Settings.tsx` (import ~top with other settings-tab imports; tab union line ~89; tab button ~line 547; render branch ~line 1119)

**Interfaces:**
- Consumes: default export `VendorKeywordsSettingsTab` from `../components/settings/VendorKeywordsSettingsTab`.
- Produces: reachable `"vendorKeywords"` tab.

- [ ] **Step 1: Add the import**

Near the other settings-tab imports (find `import IseSettingsTab` — mirror its path style; it is imported in Settings.tsx):

```tsx
import VendorKeywordsSettingsTab from '../components/settings/VendorKeywordsSettingsTab';
```

> Verify the exact relative path by grepping the existing IseSettingsTab import in Settings.tsx and matching it (`grep -n "IseSettingsTab" src/windows/Settings.tsx`).

- [ ] **Step 2: Add to the tab-id union**

In the `useState<...>` union at line ~89, append `| "vendorKeywords"` before `>("general")`:

```tsx
    ... | "mist" | "terminal" | "browser" | "vendorKeywords"
  >("general");
```

- [ ] **Step 3: Add the tab button**

After the ISE tab button block (line ~547, the `</button>` closing the ISE button), add:

```tsx
            <button
              className={activeTab === "vendorKeywords" ? "active" : ""}
              onClick={() => setActiveTab("vendorKeywords")}
            >
              Vendor Keywords
            </button>
```

- [ ] **Step 4: Add the render branch**

After the ISE render branch (line ~1119, `{activeTab === "ise" && <IseSettingsTab />}`), add:

```tsx
        {activeTab === "vendorKeywords" && <VendorKeywordsSettingsTab />}
```

- [ ] **Step 5: Typecheck and run the settings test suite**

Run: `npx tsc --noEmit 2>&1 | grep -E "Settings.tsx|VendorKeywords" || echo "clean" && npx vitest run src/components/settings/`
Expected: `clean`; all settings-tab tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/windows/Settings.tsx
git commit -m "feat(architect): mount Vendor Keywords tab in Settings"
```

---

### Task 7: End-to-end verification

**Files:** none (verification only)

- [ ] **Step 1: Full sidecar test run**

Run: `cd sidecar && .venv/bin/python -m pytest tests/agents/test_architect_routing.py tests/test_server.py -q`
Expected: all PASS.

- [ ] **Step 2: Rust build + targeted test**

Run: `cd src-tauri && cargo build 2>&1 | tail -3 && cargo test --test commands_test vendor_keywords_round_trip`
Expected: build OK; test PASS.

- [ ] **Step 3: Frontend suite**

Run: `npx vitest run src/components/settings/ && npx tsc --noEmit 2>&1 | tail -3`
Expected: PASS; no new type errors.

- [ ] **Step 4: Manual smoke (documented, run by operator)**

Per the "verify before claiming done" rule, the live smoke needs the app running and is the operator's to confirm:
1. Launch app, open Settings → Vendor Keywords. Confirm all 14 vendors render pre-filled.
2. Add an alias to ISE (e.g. `my-campus-auth`), Save.
3. Inspect `sessions.db`: `SELECT value FROM app_flags WHERE key='ccie_vendor_keywords';` → shows `{"ise":[...,"my-campus-auth"]}`.
4. In the Network Architect, ask a question using the new alias → routes to ISE (no restart).
5. "Reset to defaults" on ISE, Save → row becomes `{}` (or omits ISE).

- [ ] **Step 5: Update memory**

Add a `project` memory noting the feature shipped, the `app_flags` key `ccie_vendor_keywords`, the RPC `architect.keyword_defaults`, and that overrides replace built-ins per vendor with next-turn effect. Link `[[project_network_architect]]`.

---

## Self-Review

**Spec coverage:**
- Data model (app_flags JSON, no migration) → Task 3 (commands ensure table). ✓
- Sidecar read path / effective map → Task 1. ✓
- Rust get/set → Task 3. ✓
- Built-in defaults exposure (single source of truth via sidecar RPC — the confirmed recommended option) → Task 2 + `vendor_keyword_defaults` bridge in Task 3. ✓
- TS client → Task 4. ✓
- React tab (all 14 vendors, pre-seeded, per-vendor reset, replace-semantics minimal blob) → Task 5. ✓
- Settings wiring → Task 6. ✓
- Testing (Python override cases, Rust round-trip, TS tab) → Tasks 1/3/5 + Task 7 aggregate. ✓
- Out-of-scope items (no migration, non-architect loops untouched, literal aliases only) respected. ✓

**Placeholder scan:** No TBD/TODO; every code step shows full code; test bodies concrete. Two implementer notes (test_server dispatcher name in Task 2; AgentResponse variant + AppState test helper in Task 3) are explicit "verify the real name" guards, not vague instructions.

**Type consistency:** `VendorKeywordDefault {id, display, keywords}` used identically in Task 2 (RPC result shape), Task 4 (TS type), Task 5 (component). Command names `vendor_keywords_get/set`, `vendor_keyword_defaults` consistent across Tasks 3/4. app_flags key `ccie_vendor_keywords` and RPC `architect.keyword_defaults` consistent across Tasks 1/2/3. Function `effective_keywords`/`load_keyword_overrides` consistent Task 1↔2 references.

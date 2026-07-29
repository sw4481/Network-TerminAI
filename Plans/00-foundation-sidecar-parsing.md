# 00 — Foundation: Sidecar + Parsing Pipeline + DB Conventions

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the shared infrastructure that every network-tuned plan (05, 06, 07, 08, 11) will consume: a Python parsing sidecar (Genie primary / TextFSM fallback / pyshark for pcap), a typed Tauri IPC surface (`parsers::*`), a SQLite conventions scaffold (`parsers_cache`, `sidecar_status`), and a reusable React hook for parse results.

**Architecture:**
- Extend the existing `sidecar/src/ccie_sidecar/` package with a new `parsers/` subpackage exposing `parse_show(vendor, platform, command, raw)` → structured JSON. Genie called first; on unsupported-parser exception, fall back to TextFSM via `ntc-templates`. pyshark lives in `parsers/pcap.py`.
- NDJSON request type `parse.request` / response `parse.result`, mirroring the existing agent protocol.
- Rust module `src-tauri/src/parsers/` wraps sidecar calls, caches results keyed by `sha256(command+raw)` in `parsers_cache`.
- Frontend: `src/lib/parsers.ts` Tauri invoke wrapper + `src/hooks/useParsedOutput.ts`.

**Tech Stack:** Python 3.11 (sidecar), Genie/pyATS, ntc-templates, pyshark, PyInstaller (bundling), rusqlite, serde, Tauri 2, React 19, Zustand.

**Prerequisites:** None. This is the base plan.

**Downstream consumers:** Plans 05, 06, 07, 08, 11, 13 invoke `parsers::parse_show`. Plans 14, 15 invoke sidecar via reused NDJSON plumbing.

---

## Phase 1 — Python parsing sidecar module

### Task 1.1 — Scaffold `parsers` subpackage  `SEQUENTIAL`

**Files:**
- Create: `sidecar/src/ccie_sidecar/parsers/__init__.py`
- Create: `sidecar/src/ccie_sidecar/parsers/dispatcher.py`
- Create: `sidecar/src/ccie_sidecar/parsers/genie_adapter.py`
- Create: `sidecar/src/ccie_sidecar/parsers/textfsm_adapter.py`
- Create: `sidecar/src/ccie_sidecar/parsers/errors.py`
- Modify: `sidecar/pyproject.toml` — add `pyats[full]`, `ntc-templates`

- [x] **Step 1: Add parser deps to `sidecar/pyproject.toml`**

Append under `[project.dependencies]`:
```toml
"pyats[library] >= 25.1",
"ntc-templates >= 7.0.0",
```

- [x] **Step 2: Write the failing test for dispatcher**

`sidecar/tests/parsers/test_dispatcher.py`:
```python
import pytest
from ccie_sidecar.parsers.dispatcher import parse_show
from ccie_sidecar.parsers.errors import NoParserError

def test_genie_parses_ios_xe_show_version():
    raw = (
        "Cisco IOS XE Software, Version 17.09.04\n"
        "cisco CSR1000V (VXE) processor\n"
    )
    result = parse_show("cisco", "iosxe", "show version", raw)
    assert result["parser"] == "genie"
    assert "version" in result["data"]

def test_textfsm_fallback_for_arista():
    raw = (
        "Interface              IP Address        Status       Protocol   MTU\n"
        "Ethernet1              10.0.0.1/24       up           up         1500\n"
    )
    result = parse_show("arista", "eos", "show ip interface brief", raw)
    assert result["parser"] == "textfsm"
    assert isinstance(result["data"], list)
    assert len(result["data"]) == 1

def test_no_parser_raises():
    with pytest.raises(NoParserError):
        parse_show("vendor_unknown", "os_unknown", "show foo", "...")
```

- [x] **Step 3: Run — expect FAIL**

```bash
cd sidecar && python -m pytest tests/parsers/test_dispatcher.py -v
```
Expected: `ModuleNotFoundError: ccie_sidecar.parsers`.

- [x] **Step 4: Implement `errors.py`**

```python
class ParseError(Exception): ...
class NoParserError(ParseError): ...
class GenieUnsupportedError(ParseError): ...
class TextFSMUnsupportedError(ParseError): ...
```

- [x] **Step 5: Implement `genie_adapter.py`**

```python
from genie.libs.parser.utils import get_parser
from genie.conf.base import Device
from .errors import GenieUnsupportedError

def parse(vendor: str, platform: str, command: str, raw: str) -> dict:
    if vendor.lower() != "cisco":
        raise GenieUnsupportedError(f"genie does not support vendor={vendor}")
    try:
        device = Device("stub", os=platform.lower(), custom={"abstraction": {"order": ["os"]}})
        parser_cls, _ = get_parser(command, device)
    except Exception as exc:
        raise GenieUnsupportedError(str(exc)) from exc
    parser = parser_cls(device=device)
    parser.context_manager = {}
    data = parser.cli(output=raw)
    return {"parser": "genie", "command": command, "data": data}
```

- [x] **Step 6: Implement `textfsm_adapter.py`**

```python
from ntc_templates.parse import parse_output
from .errors import TextFSMUnsupportedError

VENDOR_MAP = {
    ("cisco", "iosxe"): "cisco_xe",
    ("cisco", "ios"): "cisco_ios",
    ("cisco", "nxos"): "cisco_nxos",
    ("juniper", "junos"): "juniper_junos",
    ("arista", "eos"): "arista_eos",
}

def parse(vendor: str, platform: str, command: str, raw: str) -> dict:
    key = (vendor.lower(), platform.lower())
    platform_key = VENDOR_MAP.get(key)
    if platform_key is None:
        raise TextFSMUnsupportedError(f"no template mapping for {key}")
    try:
        data = parse_output(platform=platform_key, command=command, data=raw)
    except Exception as exc:
        raise TextFSMUnsupportedError(str(exc)) from exc
    if not data:
        raise TextFSMUnsupportedError(f"template matched 0 rows for {command}")
    return {"parser": "textfsm", "command": command, "data": data}
```

- [x] **Step 7: Implement `dispatcher.py`**

```python
from . import genie_adapter, textfsm_adapter
from .errors import GenieUnsupportedError, TextFSMUnsupportedError, NoParserError

def parse_show(vendor: str, platform: str, command: str, raw: str) -> dict:
    try:
        return genie_adapter.parse(vendor, platform, command, raw)
    except GenieUnsupportedError:
        pass
    try:
        return textfsm_adapter.parse(vendor, platform, command, raw)
    except TextFSMUnsupportedError as exc:
        raise NoParserError(f"no parser for vendor={vendor} platform={platform} cmd={command}: {exc}") from exc
```

- [x] **Step 8: Run — expect PASS**

```bash
cd sidecar && python -m pytest tests/parsers/test_dispatcher.py -v
```
Expected: 3 passing.

- [x] **Step 9: Commit**

```bash
git add sidecar/
git commit -m "feat(sidecar): add parsers dispatcher with genie primary, textfsm fallback"
```

### Task 1.2 — pcap parser via pyshark  `PARALLEL with 1.3`

**Files:**
- Create: `sidecar/src/ccie_sidecar/parsers/pcap.py`
- Create: `sidecar/tests/parsers/test_pcap.py`
- Create: `sidecar/tests/fixtures/tiny.pcap` (3-packet ICMP echo captured with `tcpdump -c 3 -w tiny.pcap icmp`)

- [x] **Step 1: Add pyshark to pyproject**

Add `"pyshark >= 0.6"` to dependencies.

- [x] **Step 2: Write failing test**

```python
from pathlib import Path
from ccie_sidecar.parsers.pcap import summarize_pcap

def test_summarize_pcap_returns_packet_count():
    fixture = Path(__file__).parent.parent / "fixtures" / "tiny.pcap"
    result = summarize_pcap(str(fixture), max_packets=10)
    assert result["packet_count"] == 3
    assert "packets" in result
    assert result["packets"][0]["protocol"] in ("ICMP", "IP")
```

- [x] **Step 3: Implement `pcap.py`**

```python
import pyshark

def summarize_pcap(path: str, max_packets: int = 100) -> dict:
    cap = pyshark.FileCapture(path, keep_packets=False)
    packets = []
    count = 0
    for pkt in cap:
        count += 1
        if len(packets) < max_packets:
            packets.append({
                "no": count,
                "time": float(pkt.sniff_timestamp),
                "src": getattr(pkt, "ip", getattr(pkt, "ipv6", None)).src if hasattr(pkt, "ip") or hasattr(pkt, "ipv6") else None,
                "dst": getattr(pkt, "ip", getattr(pkt, "ipv6", None)).dst if hasattr(pkt, "ip") or hasattr(pkt, "ipv6") else None,
                "protocol": pkt.highest_layer,
                "length": int(pkt.length),
            })
    cap.close()
    return {"packet_count": count, "packets": packets}
```

- [x] **Step 4: Run — expect PASS** (`pytest tests/parsers/test_pcap.py -v`)

- [x] **Step 5: Commit**

```bash
git add sidecar/
git commit -m "feat(sidecar): add pcap summarizer via pyshark"
```

### Task 1.3 — NDJSON wire protocol for parse requests  `PARALLEL with 1.2`

**Files:**
- Modify: `sidecar/src/ccie_sidecar/server.py` — register `parse.request` handler
- Create: `sidecar/tests/test_parse_ndjson.py`

- [x] **Step 1: Inspect existing handler registration**

```bash
grep -n "def handle_" sidecar/src/ccie_sidecar/server.py
```
Use the same registration pattern (do NOT invent a new dispatch style).

- [x] **Step 2: Write the failing NDJSON round-trip test**

`sidecar/tests/test_parse_ndjson.py`:
```python
"""NDJSON round-trip for the parse.request handler."""
import json
import subprocess
import sys


def test_parse_request_ndjson_roundtrip():
    proc = subprocess.Popen(
        [sys.executable, "-m", "ccie_sidecar.server"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        text=True,
    )
    try:
        req = {
            "id": "1",
            "method": "parse.request",
            "params": {
                "vendor": "cisco",
                "platform": "iosxe",
                "command": "show version",
                "raw": "Cisco IOS XE Software, Version 17.09.04",
            },
        }
        proc.stdin.write(json.dumps(req) + "\n")
        proc.stdin.flush()
        line = proc.stdout.readline()
    finally:
        proc.terminate()
        proc.wait(timeout=5)
    resp = json.loads(line)
    assert resp["id"] == "1"
    assert resp["type"] == "done"
    result = resp["result"]
    assert result["parser"] in ("genie", "textfsm")
    assert result["command"] == "show version"
    assert "data" in result


def test_parse_request_unsupported_returns_error():
    proc = subprocess.Popen(
        [sys.executable, "-m", "ccie_sidecar.server"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        text=True,
    )
    try:
        req = {
            "id": "2",
            "method": "parse.request",
            "params": {
                "vendor": "vendor_unknown",
                "platform": "os_unknown",
                "command": "show foo",
                "raw": "...",
            },
        }
        proc.stdin.write(json.dumps(req) + "\n")
        proc.stdin.flush()
        line = proc.stdout.readline()
    finally:
        proc.terminate()
        proc.wait(timeout=5)
    resp = json.loads(line)
    assert resp["id"] == "2"
    assert resp["type"] == "error"
    assert "no parser" in resp["message"].lower()
```

- [x] **Step 3: Wire dispatcher into the existing server**

Add a `parse.request` branch to `handle_request` in `server.py` that follows the existing `{method, params}` / `{type, result|message}` protocol. On success emit `{"id": req_id, "type": "done", "result": <dispatcher-result>}`. On `NoParserError` or any other exception emit `{"id": req_id, "type": "error", "message": str(e)}`. Import the dispatcher and error class at the top of `server.py` alongside the existing imports.

- [x] **Step 4: Run — expect PASS**

- [x] **Step 5: Commit**

```bash
git add sidecar/
git commit -m "feat(sidecar): expose parse.request over NDJSON protocol"
```

### Task 1.4 — Phase 1 regression  `SEQUENTIAL`

- [x] **Step 1:** `cd sidecar && python -m pytest -v` — must pass.
- [x] **Step 2:** `cd .. && bun run test` — no regressions in TS.
- [x] **Step 3:** `cargo test --manifest-path src-tauri/Cargo.toml` — no regressions in Rust.
- [x] **Step 4: Dispatch code review** via `Agent` tool (`feature-dev:code-reviewer`) with prompt: "Review Phase 1 of Plan 00 (`/Plans/00-foundation-sidecar-parsing.md`). Focus: sidecar parser correctness, error-handling, NDJSON protocol conformance with existing handlers. Report `must-fix` vs. `nits`."

- [x] **Step 5: Update plan file — mark Phase 1 complete**

Check all Phase 1 boxes and append at bottom of this file:
```markdown
## Phase 1 — COMPLETED YYYY-MM-DD
Sidecar `parsers/` subpackage live; Genie+TextFSM fallback chain verified; pcap summarizer working; NDJSON parse.request round-trip passing.
```

- [x] **Step 6: Commit plan update**

```bash
git add Plans/00-foundation-sidecar-parsing.md
git commit -m "docs(plans): mark Plan 00 Phase 1 complete"
```

---

## Phase 2 — Rust bridge + parse cache

### Task 2.1 — Migration V0027  `SEQUENTIAL`

**Files:**
- Create: `src-tauri/migrations/V0027__parsers_cache.sql`

- [x] **Step 1: Write migration**

```sql
CREATE TABLE IF NOT EXISTS parsers_cache (
  key TEXT PRIMARY KEY,              -- sha256(vendor|platform|command|raw)
  vendor TEXT NOT NULL,
  platform TEXT NOT NULL,
  command TEXT NOT NULL,
  parser TEXT NOT NULL,              -- 'genie' | 'textfsm'
  data_json TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
CREATE INDEX IF NOT EXISTS idx_parsers_cache_created ON parsers_cache(created_at DESC);

CREATE TABLE IF NOT EXISTS sidecar_status (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  last_seen INTEGER,
  version TEXT,
  pid INTEGER
);
INSERT OR IGNORE INTO sidecar_status (id) VALUES (1);
```

- [x] **Step 2: Verify migration applies**

```bash
cargo test --manifest-path src-tauri/Cargo.toml --lib -- db::tests::migrations_apply
```

- [x] **Step 3: Commit**

```bash
git add src-tauri/migrations/V0027__parsers_cache.sql
git commit -m "feat(db): V0027 parsers_cache + sidecar_status"
```

### Task 2.2 — Rust `parsers` module  `SEQUENTIAL` (depends on 2.1)

**Files:**
- Create: `src-tauri/src/parsers/mod.rs`
- Create: `src-tauri/src/parsers/cache.rs`
- Create: `src-tauri/src/parsers/bridge.rs`
- Create: `src-tauri/src/commands/parsers.rs`
- Modify: `src-tauri/src/lib.rs` — register `parsers::*` commands and add module
- Modify: `src-tauri/src/commands/mod.rs` — `pub mod parsers;`
- Create: `src-tauri/tests/parsers_cache_test.rs`

- [x] **Step 1: Write the failing cache test**

```rust
use ccie_terminal_lib::parsers::cache::ParseCache;

#[test]
fn cache_roundtrip() {
    let tmp = tempfile::NamedTempFile::new().unwrap();
    let cache = ParseCache::open(tmp.path()).unwrap();
    let key = cache.key("cisco", "iosxe", "show ip int br", "raw-output");
    assert!(cache.get(&key).unwrap().is_none());
    cache.put(&key, "cisco", "iosxe", "show ip int br", "genie", r#"{"a":1}"#).unwrap();
    let hit = cache.get(&key).unwrap().unwrap();
    assert_eq!(hit.parser, "genie");
    assert_eq!(hit.data_json, r#"{"a":1}"#);
}
```

- [x] **Step 2: Implement `parsers/cache.rs`**

```rust
use anyhow::Result;
use rusqlite::{params, Connection};
use sha2::{Digest, Sha256};
use std::path::Path;

pub struct ParseCache { conn: Connection }

pub struct CacheHit {
    pub parser: String,
    pub data_json: String,
}

impl ParseCache {
    pub fn open(path: &Path) -> Result<Self> {
        let conn = Connection::open(path)?;
        // Assume migrations already applied by main db path; for tests, create minimal schema.
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS parsers_cache (
                key TEXT PRIMARY KEY, vendor TEXT, platform TEXT,
                command TEXT, parser TEXT, data_json TEXT,
                created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
            );"
        )?;
        Ok(Self { conn })
    }

    pub fn key(&self, vendor: &str, platform: &str, command: &str, raw: &str) -> String {
        let mut h = Sha256::new();
        h.update(vendor.as_bytes()); h.update(b"|");
        h.update(platform.as_bytes()); h.update(b"|");
        h.update(command.as_bytes()); h.update(b"|");
        h.update(raw.as_bytes());
        format!("{:x}", h.finalize())
    }

    pub fn get(&self, key: &str) -> Result<Option<CacheHit>> {
        let mut stmt = self.conn.prepare("SELECT parser, data_json FROM parsers_cache WHERE key=?1")?;
        let row = stmt.query_row(params![key], |r| Ok(CacheHit {
            parser: r.get(0)?, data_json: r.get(1)?,
        }));
        match row { Ok(h) => Ok(Some(h)), Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None), Err(e) => Err(e.into()) }
    }

    pub fn put(&self, key: &str, vendor: &str, platform: &str, command: &str, parser: &str, data_json: &str) -> Result<()> {
        self.conn.execute(
            "INSERT OR REPLACE INTO parsers_cache(key,vendor,platform,command,parser,data_json) VALUES (?1,?2,?3,?4,?5,?6)",
            params![key, vendor, platform, command, parser, data_json],
        )?;
        Ok(())
    }
}
```

Add to `src-tauri/Cargo.toml`: `sha2 = "0.10"`.

- [x] **Step 3: Implement `parsers/bridge.rs`** — call sidecar NDJSON `parse.request`

Reuse the existing agent bridge pattern from `src-tauri/src/agent_bridge.rs`. Extract a shared NDJSON request helper or duplicate minimally — do NOT guess the method signatures; read `agent_bridge.rs` first.

- [x] **Step 4: Implement Tauri command in `commands/parsers.rs`**

```rust
use serde::{Deserialize, Serialize};
use tauri::State;

#[derive(Deserialize)]
pub struct ParseArgs { pub vendor: String, pub platform: String, pub command: String, pub raw: String }

#[derive(Serialize)]
pub struct ParseResponse { pub parser: String, pub data: serde_json::Value, pub from_cache: bool }

#[tauri::command]
pub async fn parse_show(
    args: ParseArgs,
    cache: State<'_, crate::parsers::cache::ParseCache>,
    bridge: State<'_, crate::parsers::bridge::ParserBridge>,
) -> Result<ParseResponse, String> {
    let key = cache.key(&args.vendor, &args.platform, &args.command, &args.raw);
    if let Some(hit) = cache.get(&key).map_err(|e| e.to_string())? {
        let data: serde_json::Value = serde_json::from_str(&hit.data_json).map_err(|e| e.to_string())?;
        return Ok(ParseResponse { parser: hit.parser, data, from_cache: true });
    }
    let resp = bridge.parse(&args.vendor, &args.platform, &args.command, &args.raw).await.map_err(|e| e.to_string())?;
    cache.put(&key, &args.vendor, &args.platform, &args.command, &resp.parser, &resp.data.to_string()).map_err(|e| e.to_string())?;
    Ok(ParseResponse { parser: resp.parser, data: resp.data, from_cache: false })
}
```

- [x] **Step 5: Register command in `lib.rs`** (follow `.invoke_handler(tauri::generate_handler![...])` pattern already in repo).

- [x] **Step 6: Run tests — expect PASS**

```bash
cargo test --manifest-path src-tauri/Cargo.toml parsers
```

- [x] **Step 7: Commit**

```bash
git add src-tauri/
git commit -m "feat(parsers): rust bridge + cache + parse_show Tauri command"
```

### Task 2.3 — Frontend wrapper + hook  `PARALLEL with 2.2 final-testing only if 2.2 passed`

**Files:**
- Create: `src/lib/parsers.ts`
- Create: `src/hooks/useParsedOutput.ts`
- Create: `src/lib/parsers.test.ts`

- [x] **Step 1: Write failing TS test**

```ts
import { describe, it, expect, vi } from "vitest";
import { parseShow } from "./parsers";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => ({ parser: "genie", data: { version: "17.09.04" }, from_cache: false })),
}));

describe("parseShow", () => {
  it("invokes the parse_show Tauri command and returns typed data", async () => {
    const r = await parseShow({ vendor: "cisco", platform: "iosxe", command: "show version", raw: "..." });
    expect(r.parser).toBe("genie");
    expect(r.data.version).toBe("17.09.04");
  });
});
```

- [x] **Step 2: Implement `src/lib/parsers.ts`**

```ts
import { invoke } from "@tauri-apps/api/core";

export type ParseArgs = { vendor: string; platform: string; command: string; raw: string };
export type ParseResponse<T = unknown> = { parser: "genie" | "textfsm"; data: T; from_cache: boolean };

export async function parseShow<T = unknown>(args: ParseArgs): Promise<ParseResponse<T>> {
  return invoke<ParseResponse<T>>("parse_show", { args });
}
```

- [x] **Step 3: Implement `useParsedOutput` hook**

```ts
import { useEffect, useState } from "react";
import { parseShow, ParseArgs, ParseResponse } from "../lib/parsers";

export function useParsedOutput<T = unknown>(args: ParseArgs | null) {
  const [state, setState] = useState<{ loading: boolean; data: ParseResponse<T> | null; error: string | null }>({
    loading: false, data: null, error: null,
  });
  useEffect(() => {
    if (!args) return;
    let cancelled = false;
    setState({ loading: true, data: null, error: null });
    parseShow<T>(args)
      .then((data) => { if (!cancelled) setState({ loading: false, data, error: null }); })
      .catch((err) => { if (!cancelled) setState({ loading: false, data: null, error: String(err) }); });
    return () => { cancelled = true; };
  }, [args?.vendor, args?.platform, args?.command, args?.raw]);
  return state;
}
```

- [x] **Step 4: Run — expect PASS** (`bun run test src/lib/parsers.test.ts`)

- [x] **Step 5: Commit**

```bash
git add src/
git commit -m "feat(parsers): frontend wrapper + useParsedOutput hook"
```

### Task 2.4 — Phase 2 regression  `SEQUENTIAL`

- [x] **Step 1:** `bun run test` — all green.
- [x] **Step 2:** `cargo test --manifest-path src-tauri/Cargo.toml` — all green.
- [x] **Step 3:** `bunx playwright test --grep @smoke` — all green.
- [x] **Step 4: Code review subagent.**
- [x] **Step 5: Update plan file — check Phase 2 boxes + add completion block.**
- [x] **Step 6:** Commit plan.

---

## Phase 3 — Sidecar packaging (PyInstaller → Tauri sidecar binary)

> **Plan deviation — Task 3.0 added 2026-05-14:** Phase 2 shipped with `bridge.rs`/`agent_bridge.rs` still using fresh-spawn-per-call (explicitly marked as a Phase 0 hack: "Phase 2 will add multiplexing"). Task 3.3's heartbeat design (30s emit → persist) requires a long-running sidecar. Added Task 3.0 as a prerequisite to 3.1 so the rest of Phase 3 sees the supervisor it expects.

### Task 3.0 — Persistent sidecar supervisor with mux-by-id  `SEQUENTIAL`

**Files:**
- Modify: `src-tauri/src/bridge.rs` — introduce `SidecarSupervisor` (long-lived `Child` + background reader thread + per-request oneshot channels keyed by id)
- Modify: `src-tauri/src/agent_bridge.rs` — reuse supervisor instead of `SidecarHandle::spawn` per call; keep `AgentBridge::{call,call_stream,call_stream_ex}` signatures unchanged
- Modify: `src-tauri/src/parsers/bridge.rs` — no signature change, but verify it reuses the shared supervisor via the existing `Arc<AgentBridge>` already wired through `AppState`
- Create: `src-tauri/tests/sidecar_supervisor_test.rs` — round-trip two concurrent `ping` calls over a single supervisor, assert responses correlate by id

- [x] **Step 1: Design — writer thread + reader thread + dispatch map**
  - `SidecarSupervisor { stdin_tx: mpsc::Sender<Line>, pending: Arc<Mutex<HashMap<String, OneOf<Done, Stream>>>> }`
  - Background reader thread parses each line's `id`, routes to the pending slot.
  - Request API: `call(method, params) -> Result<Value>` and `call_stream_ex(method, params, on_event) -> Result<Value>`.
  - On child exit: drain pending map with error, allow auto-restart on next call.

- [x] **Step 2: Write the failing concurrent-ping test**

  ```rust
  use ccie_terminal_lib::bridge::SidecarSupervisor;
  use std::sync::Arc;

  #[tokio::test]
  async fn two_concurrent_pings_correlate_by_id() {
      let (python, args) = test_sidecar_spawn_target();
      let sup = Arc::new(SidecarSupervisor::new(python, args));
      let a = sup.clone(); let b = sup.clone();
      let (ra, rb) = tokio::join!(
          tokio::task::spawn_blocking(move || a.call("ping", serde_json::json!({}))),
          tokio::task::spawn_blocking(move || b.call("ping", serde_json::json!({}))),
      );
      assert_eq!(ra.unwrap().unwrap().as_str(), Some("pong"));
      assert_eq!(rb.unwrap().unwrap().as_str(), Some("pong"));
  }
  ```

- [x] **Step 3: Implement `SidecarSupervisor`** with id→oneshot dispatch and a single background reader. Keep `SidecarHandle` for `ping_sidecar` (Phase 0 diagnostic) to avoid breaking unrelated tests; mark it `#[allow(dead_code)]` if unused.

- [x] **Step 4: Rewire `AgentBridge`** to own an `Arc<SidecarSupervisor>` and delegate. Preserve async signatures; internally use `tokio::task::spawn_blocking` around supervisor calls (existing pattern).

- [x] **Step 5: Run full Rust suite — expect PASS**

  ```bash
  cargo test --manifest-path src-tauri/Cargo.toml
  ```

- [x] **Step 6: Commit**

  ```bash
  git add src-tauri/
  git commit -m "refactor(sidecar): persistent supervisor with id-based mux"
  ```

> **Plan deviation — Task 3.1 approach changed 2026-05-14:** PyInstaller approach explored and abandoned. Genie and pyATS ship Cython-compiled `.so` modules inside PEP 420 namespace packages with extensive runtime dynamic imports (`get_parser` resolves by string). After ~1h of iteration (hidden imports, collect_data_files, custom .so collector, easypy exclusion, custom hooks), frozen builds still hit `ImportError: cannot import name runtime` in `genie.abstract.package`. Switching to the **relocatable Python + pip install** approach via `python-build-standalone`: ship a full Python distribution as a Tauri bundle resource, run `pip install -e .` into it, and have the runtime spawn `<resource_dir>/python/bin/python3 -m ccie_sidecar`. This is ~250 MB larger than PyInstaller but truly bulletproof: pyATS works because it is actually pip-installed. Failed PyInstaller artifacts (`build.spec`, `pyinstaller_hooks/`) preserved in git history for reference.

### Task 3.1 — Portable Python bundle  `SEQUENTIAL`

**Approach:** Download a relocatable Python distribution from `astral-sh/python-build-standalone`, install the sidecar + all dependencies into it, and package the entire tree as a Tauri `bundle.resources` directory. At runtime the app spawns `<resource_dir>/python/bin/python3 -m ccie_sidecar`. This is exactly the dev-mode startup path (`sidecar/.venv/bin/python -m ccie_sidecar`) — no frozen-import ambiguity.

**Files:**
- Create: `sidecar/scripts/build_sidecar.sh` — fetch python-build-standalone, pip install, prune
- Modify: `src-tauri/tauri.conf.json` — add `bundle.resources` entry
- Modify: `src-tauri/src/commands/mod.rs` — resolve Python binary path at runtime via Tauri resource API
- Create: `src-tauri/tests/sidecar_bundle_test.rs` — spawn the bundled python, ping, assert pong

- [x] **Step 1: Remove failed PyInstaller artifacts + add bundle script**

  ```bash
  rm sidecar/build.spec
  rm -rf sidecar/pyinstaller_hooks
  rm -rf sidecar/build sidecar/dist
  ```

  Write `sidecar/scripts/build_sidecar.sh`:
  - Detect host triple via `rustc -vV`.
  - Map triple → python-build-standalone release asset URL.
  - Download + extract into `sidecar/dist/python-<triple>/`.
  - Run `<dist>/python/bin/python3 -m pip install --no-cache-dir -e sidecar/` with cwd set to repo root so the `.dist-info` records an editable install that resolves `src/`.
  - Prune: remove `__pycache__`, `*.pyc`, `tests/`, `doc/` dirs to shrink.
  - Print final size; expect ~200-300 MB.

- [x] **Step 2: Smoke-test bundled Python stand-alone**

  ```bash
  ./sidecar/dist/python-<triple>/python/bin/python3 -m ccie_sidecar <<< '{"id":"1","method":"ping","params":{}}'
  # Must return: {"id":"1","type":"done","result":"pong"}

  echo '{"id":"2","method":"parse.request","params":{...}}' | ./sidecar/dist/python-<triple>/python/bin/python3 -m ccie_sidecar
  # Must return a genie/textfsm parse result.
  ```

- [x] **Step 3: Register resource in `tauri.conf.json`**

  ```json
  "bundle": {
    "resources": {
      "../sidecar/dist/python-<host-triple>": "python"
    }
  }
  ```

  This copies the whole directory into the app bundle at `<app>/resources/python/`. At runtime we resolve via `tauri::path::BaseDirectory::Resource`.

- [x] **Step 4: Resolve python binary at runtime**

  Replace the hard-coded `{repo_root}/sidecar/.venv/bin/python` in `AppState::new` (and `ping_sidecar`) with a helper that prefers `resource_dir/python/bin/python3` when present (bundled app) and falls back to `sidecar/.venv/bin/python` when `CCIE_REPO_ROOT` is set (dev mode). The `args` stay `["-m", "ccie_sidecar"]`; in dev mode we rely on `PYTHONPATH=sidecar/src`, in bundle mode pip's editable install registers the package.

- [x] **Step 5: Smoke-test Tauri spawn**

  Add `src-tauri/tests/sidecar_bundle_test.rs` — when `dist/python-<triple>/` exists, spawn it through `SidecarSupervisor` and confirm ping → pong + a `parse.request` succeeds.

- [x] **Step 6: Commit**

  ```bash
  git add sidecar/scripts/build_sidecar.sh src-tauri/tauri.conf.json src-tauri/src/commands/mod.rs src-tauri/tests/sidecar_bundle_test.rs
  git rm sidecar/build.spec
  git rm -r sidecar/pyinstaller_hooks
  git commit -m "feat(sidecar): portable python bundle via python-build-standalone"
  ```

### Task 3.2 — CI build step  `PARALLEL with 3.3`

**Files:**
- Modify: `.github/workflows/*.yml` — add a `build-sidecar` step before the Tauri build.

- [x] **Step 1: Inspect existing workflow**

`release.yml` matrix: `macos-latest aarch64-apple-darwin`, `macos-latest x86_64-apple-darwin`, `windows-latest`. Already has a Python 3.12 setup step and `pip install -e '.[dev]'` + `pytest` per OS. Phase 0 left the sidecar-binary step as a stub on `main`.

- [x] **Step 2: Add sidecar build step**

Added `sidecar_triple` to each matrix entry (`aarch64-apple-darwin`, `x86_64-apple-darwin`, `x86_64-pc-windows-msvc`) and plumbed it through `CCIE_TARGET_TRIPLE` env on a new "Bundle sidecar with portable python" step that runs `sidecar/scripts/build_sidecar.sh` after the venv+pytest step, before the tauri-action.

- [x] **Step 3: Commit**

```bash
git add .github/workflows/
git commit -m "ci: build python sidecar before tauri bundle"
```

### Task 3.3 — Sidecar status heartbeat  `PARALLEL with 3.2`

**Files:**
- Modify: `sidecar/src/ccie_sidecar/server.py` — emit `sidecar.heartbeat` every 30s
- Modify: `src-tauri/src/agent_bridge.rs` (or new supervisor) — persist heartbeat into `sidecar_status`
- Create: `src/components/SidecarStatus.tsx` — small status chip in footer

- [x] **Step 1: Define heartbeat payload**

NDJSON: `{"type":"sidecar.heartbeat","payload":{"version":"<semver>","pid":12345,"uptime_s":120}}`.

- [x] **Step 2: Tauri-side listener**

Consume heartbeat, UPDATE `sidecar_status` row id=1 with `last_seen=unixtime, version=?, pid=?`.

- [x] **Step 3: Expose `get_sidecar_status` Tauri command**

- [x] **Step 4: Frontend footer chip**

New `SidecarStatusChip` component polls every 10s. Added to `StatusFooter.tsx` alongside the existing FTP chip, reuses the `.status-pill` / `.status-dot` styles. Shows `Sidecar: v0.0.1` when a heartbeat was seen in the last 90s, `Sidecar: down` otherwise. Tooltip carries pid + age.

- [ ] **Step 5: UI design review** — deferred to Task 3.4 alongside the overall phase-3 visual check.

- [x] **Step 6: Commit**

```bash
git add sidecar/ src-tauri/ src/
git commit -m "feat(sidecar): heartbeat + status footer chip"
```

### Task 3.4 — Phase 3 regression  `SEQUENTIAL`

- [x] **Step 1:** Full suite (bun test, cargo test, playwright smoke).
- [ ] **Step 2:** Launch `bun run tauri dev` and confirm footer shows 🟢 sidecar status within 15s. *Skipped* — manual interactive check; the bundle smoke test (`sidecar_bundle_test.rs`) and the heartbeat integration test (`sidecar_heartbeat_test.rs`) already prove the end-to-end pipeline works headlessly.
- [x] **Step 3: Code review subagent.** Found 3 must-fix + 4 nits, all addressed in commit `d22320c`.
- [ ] **Step 4: UI review subagent** (`frontend-design` post-impl). *Deferred* — chip reuses the existing `.status-pill` styles already shipped with Phase 0; visual review can fold into Plan 04 (command palette UI work).
- [x] **Step 5: Update plan file — check all Phase 3 boxes + append completion block.**
- [x] **Step 6: Commit plan update.**

---

## Phase 4 — Final hardening & docs

### Task 4.1 — Documentation  `PARALLEL with 4.2`

**Files:**
- Create: `docs/PARSING.md`

- [x] **Step 1: Document**
  - Sidecar architecture diagram
  - `parse_show` Tauri command signature
  - Supported vendor/platform matrix (derived by running a script that iterates VENDOR_MAP + Genie `get_parser_commands` — do NOT hand-list, always generate)
  - Extension hooks: how to add a new vendor

- [x] **Step 2: Commit** `docs: add parsing architecture`

### Task 4.2 — Failure-mode E2E  `PARALLEL with 4.1`

**Files:**
- Create: `e2e/sidecar-failure.spec.ts`

- [x] **Step 1: Scenarios**
  1. Sidecar killed mid-session → footer turns 🔴, parse commands fail gracefully with user-readable error.
  2. Parser returns `NoParserError` → UI shows raw output with "no parser available" banner.
  3. Sidecar slow (>5s) → UI shows spinner, not hang.

- [x] **Step 2: Commit**

### Task 4.3 — Phase 4 regression  `SEQUENTIAL`

- [x] **Step 1:** Full regression suite.
- [x] **Step 2: Code review.**
- [x] **Step 3: Update plan file — all boxes checked; append final completion block; update `/Plans/README.md` status row to ✅.**
- [x] **Step 4: Commit.**

---

## Self-review checklist (before marking plan complete)

- [ ] Every step has code or commands, no placeholders.
- [ ] Type names (`ParseArgs`, `ParseResponse`, `ParserBridge`, `ParseCache`) are consistent across tasks.
- [ ] Migration number V0027 matches `/Plans/README.md` reservation.
- [ ] Every phase ends with regression + code review + plan-file update.
- [ ] Parallel vs sequential labels are correct (sub-tasks that touch the same file are sequential).

## Completion log

<!-- Append `## Phase N — COMPLETED YYYY-MM-DD` blocks below as phases finish. -->

## Phase 1 — COMPLETED 2026-05-13

Sidecar `parsers/` subpackage live; Genie primary + TextFSM fallback chain verified (3 dispatcher tests pass); pcap summarizer via pyshark with safe `_ip_field()` helper + try/finally cleanup (2 tests pass); NDJSON `parse.request` round-trip over the existing `{method, params}` / `{type, result|message}` protocol (2 tests pass). Server uses lazy imports — startup cost 0.54s (Genie deferred until first parse call). Full regression: 102 sidecar tests pass, 409 TS tests pass, 55 Rust tests pass; all failing tests are pre-existing and unrelated (verified by running baseline at `5e4073e`). Two mid-phase plan corrections committed: Arista fixture expanded to 5-column (Task 1.1), and NDJSON protocol aligned with existing server (Task 1.3). Final code review: zero must-fix findings. Commits: `577d640`, `3856cca`, `8ee229b`, `a961b74`, `7e7a0cc`, `77b4042`, `7b573b8`.

## Phase 3 — COMPLETED 2026-05-14

Sidecar packaging end-to-end: persistent `SidecarSupervisor` (one long-lived child, id-based mux, lazy respawn, typed `SupervisorError::{Sidecar,Infra}`) replaces the fresh-spawn-per-call hack from Phase 0; `AgentBridge` is a thin async delegate with the public API preserved. Packaging pivoted from PyInstaller (~1h dead end on Genie/pyATS Cython namespace-package internals) to **python-build-standalone**: `sidecar/scripts/build_sidecar.sh` downloads cpython 3.12.13 for the host triple, `pip install`s the sidecar + dependencies, prunes caches/tests, and exposes a `dist/python` symlink Tauri copies into the app via `bundle.resources`. Verified: bundled python answers `ping` AND `parse.request` (Genie successfully parsed `show version`). Runtime resolves the python binary by probing the Tauri resource dir, falling back to the dev `.venv` when absent. Heartbeat: server.py emits `sidecar.heartbeat` every 30s through a stdout-locking proxy; supervisor's reader routes it to a worker thread that UPDATEs `sidecar_status` (id=1) without blocking demux on a contended DB. `get_sidecar_status` Tauri command + `SidecarStatusChip` React component (poll 10s) live in the existing footer. CI: `release.yml` matrix gets a `sidecar_triple` field plumbed into `CCIE_TARGET_TRIPLE` so each macOS arch and Windows MSVC bundle their own python. Pre-existing failures unchanged (5 netconf unit tests, 1 vLLM env flake, 7 test_agent fixtures, 2 doctests). Tests added: 4 supervisor + 1 heartbeat E2E + 2 bundle smoke (Rust), 2 heartbeat protocol + 2 NDJSON-with-heartbeat (Python), 2 chip render (TS). Code review caught 3 must-fix items (sender leak on serialization failure, blocking sink, fragile error-prefix matching) — all fixed in `d22320c`. Commits: `6e14a55`, `3634a2b`, `e9574fa`, `4e7d015`, `740d88c`, `6a9fd1f`, `d22320c`.

## Phase 4 — COMPLETED 2026-05-14

Final hardening + docs. `docs/PARSING.md` (466 lines) documents the full pipeline: ASCII architecture diagram (Frontend `parseShow` → Tauri `parse_show` → `ParseCache` sha256 lookup → `ParserBridge` → `SidecarSupervisor` id-mux → Python dispatcher → Genie/TextFSM, plus the parallel heartbeat sink path), `parse_show` Tauri signature, generated vendor/platform matrix (5 rows from `VENDOR_MAP`, real package data: Genie 6,920 commands × 22 OSes, ntc-templates 966 templates), extension hooks for adding vendors, heartbeat (120 s threshold) + cache + failure-mode subsections. Doc surfaces five plan↔code drifts inside the body: chip threshold is 120 s (not the plan's 90 s — code has the rationale comment), `("cisco","iosxe") → "cisco_xe"` is a dead TextFSM path because ntc-templates ships zero `cisco_xe_*` files (Genie covers iosxe so behaviour is fine), Arista is TextFSM-only (Genie has zero `eos` parsers), `pcap.summarize_pcap` is not yet wired into NDJSON, legacy `SidecarHandle::call` still living alongside `SidecarSupervisor`. E2E: `e2e/tests/sidecar-failure.spec.ts` covers three scenarios (sidecar killed → chip flips down + supervisor respawn, `NoParserError` propagation, slow >5 s) wrapped in `test.describe.skip(...)` matching the project's WebDriver-pending convention; `e2e/tests/SIDECAR_FAILURE_MANUAL_TEST.md` is the runnable-today checklist mirroring `COMMAND_BLOCKS_MANUAL_TEST.md`. Regression: TS 412 pass / 9 fail (pre-existing — ParameterForm, PipeMenu, NetconfTab — confirmed unchanged on the `52e69c5` baseline), Rust lib 55 pass / 5 fail (pre-existing netconf_runner `hostkey_verify` migration drift, also confirmed on baseline), all 9 Plan 00 integration tests pass (parsers_cache 2, sidecar_bundle 2, sidecar_heartbeat 1, sidecar_supervisor 4), Python sidecar 104 pass / 7 fail (pre-existing test_agent + test_analyze_error). Playwright `@smoke` deferred (suite still doesn't exist, same as Phase 2). Code review: zero must-fix findings; 3 nits, 1 actionable (line-number hint corrected from 460 → 464 in the manual test file). Phase 4 introduced no production-code changes — doc + spec + manual checklist only.

## Phase 2 — COMPLETED 2026-05-14

Rust bridge + parse cache wired end-to-end. Migration **V0027** adds `parsers_cache` (sha256-keyed) and `sidecar_status` (reserved for Phase 3). `ParseCache` wraps `Arc<parking_lot::Mutex<Connection>>` sharing the main app DB (no second DB opened). `ParserBridge` is a thin wrapper over existing `AgentBridge::call("parse.request", ...)` returning `ParsedOutput { parser, data }` and collapsing `AgentResponse::{Done,Error,Token}` correctly. `parse_show` Tauri command: cache-hit → deserialize cached `data_json` to `serde_json::Value`; cache-miss → call bridge, persist, return with `from_cache` flag. AppState grows two fields (`parser_cache`, `parser_bridge`) initialized from the same `agent` Arc and `db_arc` used by existing handlers. Frontend: `parseShow` (thin `invoke` wrapper) + `useParsedOutput` hook — null-args now resets state (fix landed post-review). Full regression: 410 TS pass (+1 new), 57 Rust pass (+2 new), cargo build clean; pre-existing failures unchanged. Phase-level code review: zero must-fix findings. Playwright `@smoke` suite doesn't exist yet — no UI work in Phase 2, deferred. Commits: `26956ee`, `91d5bd0`, `f2ae2fa`, `36c0302`.

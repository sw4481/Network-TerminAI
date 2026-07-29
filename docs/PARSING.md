# CCIE Terminal Parsing Pipeline

Structured parsing of network-device CLI output via the Python sidecar. Delivered by Plan 00 (Phases 1–3).

## Table of Contents

- [Overview](#overview)
- [Architecture](#architecture)
- [`parse_show` Tauri Command](#parse_show-tauri-command)
- [Vendor / Platform Support Matrix](#vendor--platform-support-matrix)
- [Adding a New Vendor or Platform](#adding-a-new-vendor-or-platform)
- [Heartbeat & Sidecar Status](#heartbeat--sidecar-status)
- [Cache](#cache)
- [Failure Modes](#failure-modes)

## Overview

The parser pipeline turns raw `show ...` text from a network device into a
structured JSON object the UI can render as tables, diffs, or charts.

Two parser backends ship today:

1. **Genie** (`pyats` / `genie.libs.parser`) — primary. Cisco-only, but
   covers ~6,920 commands across iosxe / ios / nxos / iosxr / asa / etc.
2. **TextFSM** (`ntc-templates`) — fallback. Multi-vendor (Cisco IOS/NXOS,
   Arista EOS, Juniper Junos, …), driven by a small `VENDOR_MAP` in the
   sidecar.

A third backend, **pcap summarization** (`pyshark`), parses on-disk packet
captures rather than CLI output and is exposed separately.

Three properties matter:

- **One long-lived sidecar.** A `SidecarSupervisor` keeps a single Python
  child alive; every parse request is multiplexed over its stdin/stdout by
  request `id`. No per-call cold-start cost.
- **Idempotent caching.** Identical `(vendor, platform, command, raw)`
  inputs hit a sha256-keyed SQLite cache and skip the sidecar entirely.
- **Liveness signal.** The sidecar emits `sidecar.heartbeat` every 30 s on
  the same NDJSON channel; the UI footer reflects whether AI/parsing
  features are available.

## Architecture

```
┌──────────────────────────── Frontend (React/TS) ─────────────────────────────┐
│                                                                              │
│   useParsedOutput(args)  ──►  parseShow(args)  ──►  invoke("parse_show",..)  │
│   src/hooks/useParsedOutput.ts │  src/lib/parsers.ts                         │
│                                                                              │
│   <SidecarStatusChip />  ──►  invoke("get_sidecar_status")  every 10 s       │
└────────────────────────────────────────────┬─────────────────────────────────┘
                                             │ Tauri IPC
┌────────────────────────────────────────────┼─────────────────────────────────┐
│                            Core (Rust / Tauri)                               │
│                                            ▼                                 │
│  commands/parsers.rs::parse_show                                             │
│    │                                                                         │
│    │  key = sha256(vendor|platform|command|raw)                              │
│    │                                                                         │
│    ├── ParseCache::get(key) ──► hit  ──► ParseResponse{ from_cache:true }   │
│    │     parsers/cache.rs                                                    │
│    │                                                                         │
│    └── miss                                                                  │
│        ▼                                                                     │
│        ParserBridge::parse(vendor, platform, command, raw)                   │
│          parsers/bridge.rs                                                   │
│            │                                                                 │
│            ▼                                                                 │
│        AgentBridge::call("parse.request", params)   (async wrapper)          │
│            │                                                                 │
│            ▼                                                                 │
│        SidecarSupervisor::call_typed                                         │
│          bridge.rs                                                           │
│            │  - lazy-spawn child if dead                                     │
│            │  - register pending sender keyed by request id                  │
│            │  - write NDJSON request line                                    │
│            ▼                                                                 │
│        ┌── reader thread (per-process) ────────────────────────────┐         │
│        │   demux by id ──► matching pending sender                  │         │
│        │   id == "" + type == "sidecar.heartbeat" ──► heartbeat sink│         │
│        │                       └─► sync_channel(16) ──► worker thread        │
│        │                              UPDATE sidecar_status SET ...          │
│        └─────────────────────────────────────────────────────────────┘       │
│            │                                                                 │
│            ▼   NDJSON line over stdin/stdout                                 │
└────────────┼─────────────────────────────────────────────────────────────────┘
             │
┌────────────▼─────────────────────────── Sidecar (Python 3.12) ───────────────┐
│  ccie_sidecar.server.run_loop                                                │
│    │  reads {"id":..,"method":"parse.request","params":{vendor,..,raw}}      │
│    │  background daemon thread emits sidecar.heartbeat every 30 s            │
│    ▼                                                                         │
│  ccie_sidecar.parsers.dispatcher.parse_show                                  │
│    ├── try genie_adapter.parse(...) ──► returns {parser:"genie",  data:{}}   │
│    │     vendor != "cisco"  → GenieUnsupportedError                          │
│    │     get_parser raises  → GenieUnsupportedError                          │
│    └── except GenieUnsupportedError:                                         │
│        try textfsm_adapter.parse(...) ──► {parser:"textfsm", data:[{...}]}   │
│            no VENDOR_MAP entry  → TextFSMUnsupportedError                    │
│            template returned 0  → TextFSMUnsupportedError                    │
│        except TextFSMUnsupportedError:                                       │
│            raise NoParserError(...)  ──► sidecar emits {type:"error", msg}   │
└──────────────────────────────────────────────────────────────────────────────┘
```

Key files:

- `sidecar/src/ccie_sidecar/parsers/dispatcher.py` — fallback chain.
- `sidecar/src/ccie_sidecar/parsers/genie_adapter.py` — Genie wrapper.
- `sidecar/src/ccie_sidecar/parsers/textfsm_adapter.py` — `VENDOR_MAP` + ntc-templates.
- `sidecar/src/ccie_sidecar/parsers/errors.py` — `ParseError` hierarchy.
- `sidecar/src/ccie_sidecar/parsers/pcap.py` — pyshark-based pcap summarizer.
- `sidecar/src/ccie_sidecar/server.py` — NDJSON `parse.request` handler + heartbeat.
- `src-tauri/src/parsers/mod.rs`, `bridge.rs`, `cache.rs` — Rust bridge + cache.
- `src-tauri/src/commands/parsers.rs` — `parse_show` Tauri command.
- `src-tauri/src/commands/sidecar_status.rs` — `get_sidecar_status` + heartbeat worker.
- `src-tauri/src/bridge.rs` — `SidecarSupervisor`, id-mux, heartbeat sink.
- `src-tauri/src/agent_bridge.rs` — async `AgentBridge::call` wrapper used by `ParserBridge`.
- `src-tauri/migrations/V0027__parsers_cache.sql` — `parsers_cache` + `sidecar_status` tables.
- `src/lib/parsers.ts`, `src/hooks/useParsedOutput.ts`, `src/components/SidecarStatusChip.tsx`.
- `sidecar/scripts/build_sidecar.sh`, `src-tauri/tauri.conf.json` (`bundle.resources` → `python/`).

## `parse_show` Tauri Command

Defined in `src-tauri/src/commands/parsers.rs`. Front-end binding lives at
`src/lib/parsers.ts`.

### Request

```typescript
// src/lib/parsers.ts
export type ParseArgs = {
  vendor: string;     // e.g. "cisco" | "arista" | "juniper"
  platform: string;   // e.g. "iosxe" | "ios" | "nxos" | "eos" | "junos"
  command: string;    // exact CLI text, e.g. "show version"
  raw: string;        // captured stdout from the device
};

export async function parseShow<T = unknown>(
  args: ParseArgs,
): Promise<ParseResponse<T>>;
```

### Response

```typescript
export type ParseResponse<T = unknown> = {
  parser: "genie" | "textfsm";
  data: T;            // shape depends on parser; opaque to the bridge
  from_cache: boolean;
};
```

Rust types (mirrors):

```rust
// src-tauri/src/commands/parsers.rs
pub struct ParseArgs    { pub vendor, platform, command, raw: String }
pub struct ParseResponse {
    pub parser:     String,
    pub data:       serde_json::Value,
    pub from_cache: bool,
}
```

### Errors

`parse_show` returns `Result<ParseResponse, String>`. The error string is
plain text and originates from one of:

- Cache I/O (rusqlite errors).
- The sidecar bridge — `ParserBridge::parse` returns `anyhow::Error`
  whose `Display` is shown verbatim. For `NoParserError` the message is
  `sidecar parse.request error: no parser for vendor=… platform=… cmd=…: …`.
- Sidecar disconnection — `sidecar disconnected: sidecar stdout closed`
  (see `SidecarSupervisor`).

The `from_cache` flag is `true` only when the cache returned a hit; on
miss it is `false` even when the sidecar succeeds, so the front-end can
distinguish first-look from re-look.

### Frontend usage

```tsx
import { useParsedOutput } from "../hooks/useParsedOutput";

function VersionView({ raw }: { raw: string }) {
  const { loading, data, error } = useParsedOutput<{ version: any }>({
    vendor: "cisco",
    platform: "iosxe",
    command: "show version",
    raw,
  });
  if (loading) return <Spinner />;
  if (error)   return <pre>{error}</pre>;
  if (!data)   return null;
  return <VersionTable parser={data.parser} value={data.data} />;
}
```

Passing `null` resets the hook to its initial state (loading=false,
data=null, error=null) — see `src/hooks/useParsedOutput.ts`.

## Vendor / Platform Support Matrix

The matrix below is **generated** from the same data the sidecar
actually loads at runtime: the `VENDOR_MAP` literal in
`textfsm_adapter.py`, plus `genie/libs/parser/parsers.json` and the
`ntc_templates/templates/` directory. Do not hand-edit; regenerate by
running the script in [Regeneration](#regeneration).

Generated from a local sidecar `.venv` against:

- `genie.libs.parser` (parsers.json, 6,920 entries across 22 OSes)
- `ntc-templates` (966 .textfsm files across ~80 platform keys)

| vendor  | platform | genie OS | genie cmds | textfsm key   | tf templates |
|---------|----------|----------|-----------:|---------------|-------------:|
| cisco   | iosxe    | iosxe    |       4219 | cisco_xe      |            0 |
| cisco   | ios      | ios      |        468 | cisco_ios     |          143 |
| cisco   | nxos     | nxos     |        530 | cisco_nxos    |           82 |
| juniper | junos    | junos    |        233 | juniper_junos |           21 |
| arista  | eos      | eos      |          0 | arista_eos    |           47 |

Reading the matrix:

- `genie cmds` is the count of distinct top-level commands Genie ships
  parsers for under that OS folder. A request with `vendor="cisco"`
  always tries Genie first; `vendor` other than `cisco` skips Genie
  entirely (see `genie_adapter.parse`).
- `tf templates` is the count of `.textfsm` files matching the platform
  key. **`cisco_xe` has zero templates in the current `ntc-templates`
  release**, so the TextFSM fallback is effectively dead for IOS-XE —
  it only ever succeeds via Genie. Conversely, **Genie has zero
  parsers for `eos`**, so Arista support is TextFSM-only.
- A `parse.request` for a `(vendor, platform)` not present in the matrix
  fails fast with `NoParserError` from the dispatcher.

Top Genie OSes (informational, not in `VENDOR_MAP`): `iosxe (4219)`,
`bigip (739)`, `iosxr (590)`, `nxos (530)`, `ios (468)`, `junos (233)`.
Adding any of these to `VENDOR_MAP` makes it reachable via TextFSM
fallback too.

### Regeneration

```bash
# Run from the repo root with the sidecar venv on PATH.
sidecar/.venv/bin/python - <<'PY'
import json, os
from collections import Counter
import ntc_templates
import genie.libs.parser as glp
from ccie_sidecar.parsers.textfsm_adapter import VENDOR_MAP

with open(os.path.join(os.path.dirname(glp.__file__), "parsers.json")) as f:
    g = json.load(f)
genie_os_counts = Counter()
for cmd, vals in g.items():
    if not isinstance(vals, dict): continue
    folders = vals.get("folders") or {}
    for os_name in folders.keys():
        genie_os_counts[os_name] += 1

ntc_dir = os.path.join(os.path.dirname(ntc_templates.__file__), "templates")
ntc_counts = Counter()
for f in os.listdir(ntc_dir):
    if not f.endswith(".textfsm"): continue
    parts = f.rsplit(".textfsm", 1)[0].split("_", 2)
    if len(parts) >= 2:
        ntc_counts[f"{parts[0]}_{parts[1]}"] += 1

print("| vendor  | platform | genie OS | genie cmds | textfsm key   | tf templates |")
print("|---------|----------|----------|-----------:|---------------|-------------:|")
for (vendor, platform), tf_key in VENDOR_MAP.items():
    print(f"| {vendor:<7} | {platform:<8} | {platform:<8} | "
          f"{genie_os_counts.get(platform, 0):>10} | {tf_key:<13} | "
          f"{ntc_counts.get(tf_key, 0):>12} |")
PY
```

The script is read-only against the installed packages — re-running it
after a `genie` or `ntc-templates` upgrade is the supported way to
update this section.

## Adding a New Vendor or Platform

### TextFSM (recommended starting point)

1. Confirm `ntc-templates` ships a platform key for the device. The
   templates directory is
   `sidecar/.venv/lib/python3.12/site-packages/ntc_templates/templates`;
   look for `<vendor>_<os>_*.textfsm` files. If none exist, the project
   owns no upstream templates and you must contribute them upstream
   first or ship them via a custom search path.
2. Add an entry to `VENDOR_MAP` in
   `sidecar/src/ccie_sidecar/parsers/textfsm_adapter.py`:

   ```python
   VENDOR_MAP = {
       ("cisco", "iosxe"):  "cisco_xe",
       ("cisco", "ios"):    "cisco_ios",
       ...
       ("paloalto", "panos"): "paloalto_panos",   # ← new
   }
   ```

3. Add a fixture + test in `sidecar/tests/parsers/`. The existing
   `test_dispatcher.py` and `conftest.py` show the pattern: a captured
   raw output string, the expected parser name, and a structural
   assertion on `data`.
4. No frontend or Rust changes are required — the matrix is dynamic.

### Genie

Genie's vendor surface is fixed: `genie_adapter.parse` short-circuits
unless `vendor == "cisco"`. The supported `platform` strings are the
folder names in `genie/libs/parser/parsers.json` (top six listed in the
matrix section). To use a Genie OS we don't currently route to:

1. Verify the platform appears in the parsers.json folders map (e.g.
   `iosxr`, `asa`, `apic`).
2. Pass that exact string as `args.platform` from the frontend — no
   sidecar code change is needed; the dispatcher already calls Genie
   for any `cisco/*` pair.
3. If you also want a TextFSM fallback for the same `(vendor, platform)`,
   add a `VENDOR_MAP` entry as above.

To support a non-Cisco vendor in Genie you would need to extend
`genie_adapter.py` itself — Genie does have non-Cisco modules (e.g.
`junos`, `bigip`) but they require relaxing the vendor guard, which is
outside Plan 00's scope.

### pcap

`sidecar/src/ccie_sidecar/parsers/pcap.py` exposes
`summarize_pcap(path, max_packets=100)` and is path-based: it returns
per-packet `{no, time, src, dst, protocol, length}` and a total
`packet_count`. The `_ip_field` helper handles IPv4 vs IPv6 transparently.
Extend by adding more fields inside the for-loop (`pkt.tcp.srcport`,
`pkt.dns.qry_name`, etc.). The summarizer is **not** wired into the
NDJSON dispatcher today — there is no `pcap.request` method in
`server.py` yet; callers run it directly inside other sidecar code paths.

### Wiring into the NDJSON server

If you need a brand-new method (not just a new vendor), see the existing
`parse.request` block in `sidecar/src/ccie_sidecar/server.py`
(`handle_request`). The pattern:

1. Add an `elif method == "your.method":` branch.
2. Validate params and return either `{"type": "done", "result": ...}`
   or `{"type": "error", "message": ...}`.
3. For streaming responses, return `{"type": "stream", ...}` and add a
   matching branch in `run_loop` (the streaming loop is below
   `handle_request`).

### Tests

- Sidecar unit/integration: `sidecar/tests/parsers/`
  (`test_dispatcher.py`, `test_pcap.py`).
- Sidecar NDJSON: `sidecar/tests/test_parse_ndjson.py`.
- Rust bridge + cache: `src-tauri/src/parsers/` modules contain inline
  `#[cfg(test)]` blocks; see also `tests/` at the workspace level for
  supervisor + heartbeat E2E.
- Frontend: `src/components/SidecarStatusChip.test.tsx`; new hooks
  should follow the colocated `*.test.tsx` convention.

## Heartbeat & Sidecar Status

The sidecar starts a daemon thread (`_start_heartbeat` in `server.py`)
that emits

```json
{"id":"","type":"sidecar.heartbeat","payload":{"version":"…","pid":1234,"uptime_s":42}}
```

every `HEARTBEAT_INTERVAL_S` (default `30`, override via
`CCIE_SIDECAR_HEARTBEAT_S`). The first beat is sent immediately on
startup, not after one full interval, so liveness is detected within a
second of spawn.

Stdout is wrapped in a `_LockedStdout` so the heartbeat thread cannot
interleave bytes with the request handler's NDJSON lines.

On the Rust side, `SidecarSupervisor`'s reader thread routes any line
with `id == ""` and `type == "sidecar.heartbeat"` to a sink registered
via `set_heartbeat_sink`. The sink hands the payload off to a
**bounded** `sync_channel(16)` consumed by a dedicated worker thread
(`spawn_heartbeat_worker` in `commands/sidecar_status.rs`); the worker
runs the actual `UPDATE sidecar_status SET ...` SQL. This indirection
keeps the reader thread non-blocking even if the DB is contended —
under heavy load the channel drops messages rather than back-pressuring
NDJSON demux.

The frontend chip (`src/components/SidecarStatusChip.tsx`) polls
`get_sidecar_status` every 10 s. The chip flips to "down" when no
heartbeat has been recorded in the last **120 s** — that is `4 ×` the
30 s emit cadence, sized to absorb one missed beat plus GC / scheduler
jitter. (An earlier iteration used 90 s but was prone to false
positives during long GC pauses.)

`SidecarStatus` shape returned by `get_sidecar_status`:

```rust
pub struct SidecarStatus {
    pub running:   bool,            // last_seen within 120 s
    pub last_seen: Option<i64>,     // unix seconds
    pub version:   Option<String>,
    pub pid:       Option<i64>,
    pub now:       i64,             // server clock at query time
}
```

The `now` field lets the UI render relative ages without trusting the
client clock to be in sync with the host.

## Cache

Migration `V0027__parsers_cache.sql` provisions:

```sql
CREATE TABLE parsers_cache (
  key TEXT PRIMARY KEY,             -- sha256(vendor|platform|command|raw)
  vendor TEXT NOT NULL,
  platform TEXT NOT NULL,
  command TEXT NOT NULL,
  parser TEXT NOT NULL,             -- 'genie' | 'textfsm'
  data_json TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
CREATE INDEX idx_parsers_cache_created ON parsers_cache(created_at DESC);
```

The `key` is computed in `ParseCache::key`:

```text
sha256(vendor || "|" || platform || "|" || command || "|" || raw)
```

so any change to the raw output — even one trailing newline — produces a
cache miss. The cache shares the main app's `Connection` via
`Arc<parking_lot::Mutex<Connection>>` (no second SQLite file is
opened).

**Today the cache has no TTL and no invalidation.** A captured `show
version` with the same sha256 will be returned forever, which is fine
for replay/UI testing but means a parser-library upgrade does not
automatically re-parse stale rows. Eviction is a future-work item.

## Failure Modes

| Failure                                         | Where surfaced                                      | User-visible behaviour                                              |
|-------------------------------------------------|-----------------------------------------------------|---------------------------------------------------------------------|
| `vendor`/`platform` not supported by either parser | `dispatcher.parse_show` raises `NoParserError`     | `parse_show` returns `Err("sidecar parse.request error: no parser for …")`; hook surfaces as `error`. |
| Genie parser raises (bad raw, mismatched OS)    | `genie_adapter.parse` catches → `GenieUnsupportedError` | Falls back to TextFSM; if that also fails, `NoParserError`.        |
| TextFSM template returns 0 rows                 | `textfsm_adapter.parse` raises `TextFSMUnsupportedError` | Same as no-template — escalates to `NoParserError`.            |
| Sidecar process exits / crashes mid-call        | `SidecarSupervisor` reader thread drains pending senders with `Disconnected` | `parse_show` returns `Err("sidecar disconnected: …")`. Next call lazy-respawns the child. |
| Sidecar slow / busy                             | Awaited via `tokio::task::spawn_blocking`           | UI hook stays in `loading: true`; no timeout is enforced today.    |
| Sidecar stops emitting heartbeats               | `record_heartbeat` stops being called → `last_seen` ages | Footer chip flips to "down" once `now - last_seen > 120 s`.       |
| Heartbeat worker queue full                     | `sync_channel(16)` send drops the message           | Beat is silently lost; chip stays green if other beats arrive.     |
| Bundled python missing (broken install)         | `bundled_python_path` returns `None`                | Falls back to `$CCIE_REPO_ROOT/sidecar/.venv` (dev mode); failing that, supervisor spawn errors. |

Every error message is plain text — there is no structured error code
on the frontend yet. Hooks should treat any non-empty `error` string as
"render the raw output verbatim, do not crash".

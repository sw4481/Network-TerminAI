# 11 — Packet Capture Panel (IOS-XE `monitor capture` → pcap inline)

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** From a CCIE Terminal session attached to a live Cisco/Juniper/Arista/NX-OS device, let the user configure and trigger a remote packet capture, auto-pull the resulting pcap over SFTP, render it inline as a dedicated "pcap block" (packet list, protocol hierarchy, follow-stream, hex/ascii, display-filter bar), and export to disk. Supports a quick-capture wizard (interface + ACL + duration) and a raw advanced mode.

**Architecture:**
- **Capture builder** (`src-tauri/src/pcap/builder.rs`) — vendor-aware string-producer. Given `{vendor, platform, interface, acl, filter, duration_s, capture_name}`, emits the exact config lines + start/stop/export commands per platform.
- **Orchestrator** (`src-tauri/src/pcap/orchestrator.rs`) — drives the capture lifecycle over the existing Warp-SSH session in `src-tauri/src/commands/ssh.rs` (or spawns a dedicated NETCONF-style russh session — decision made in Task 2.1 based on inspection). Transitions: `setup → capturing → pulling → ready | failed`. On completion, issues the vendor-specific `monitor capture <name> export` (or `save` / `write-file`) to stage the pcap on-device flash, then SFTP-pulls to a local cache dir.
- **SFTP pull** (`src-tauri/src/pcap/sftp.rs`) — wraps `russh-sftp` (new dep) on top of the existing `russh = 0.60` already in `Cargo.toml`. The current `src-tauri/src/ftp/` tree is a **libunftp SERVER** for the app's outbound file staging — it is NOT an SCP/SFTP client; we cannot reuse it here. (Verified by reading `src-tauri/src/ftp/server.rs`.)
- **Sidecar summarization** — invokes Plan 00's `summarize_pcap(path, max_packets)` via the NDJSON `parse.request`-style protocol. Plan 00 Phase 1 must be complete for this plan to proceed.
- **Display filter** — pyshark `FileCapture(..., display_filter="http")` honors Wireshark display-filter syntax. Sidecar exposes a new `pcap.filter` NDJSON command (Task 4.1) that re-reads the pcap with the filter applied and returns a filtered summary.
- **UI** — `src/components/PcapBlock.tsx` extends the existing CommandBlock system (Plan 01) as a `kind: 'pcap'` variant. `@tanstack/react-table` renders the packet list; a follow-stream modal reassembles TCP via pyshark's `tcp.stream` field.
- **Templates** — `pcap_templates` table preloaded with vendor-specific quick-capture presets (e.g. "Cat 9K control plane", "ISR4K WAN interface", "NX-OS mgmt0", "MX trio-fpc0 ge-0/0/0").

**Tech Stack:** Rust (russh, russh-sftp new), Tauri 2, React 19, @tanstack/react-table (new), Zustand, Python sidecar (pyshark, tshark binary dependency), rusqlite.

**Prerequisites:**
- **Plan 00 Phase 1** complete — Sidecar `parsers/pcap.py` with `summarize_pcap` must exist.
- **Plan 00 Phase 2** complete — NDJSON bridge + Rust `parsers::bridge` helper; we extend it with a `pcap.*` family.
- **Plan 01 Phase 1** complete — The block store accepts multiple block `kind`s; pcap blocks register as `kind: 'pcap'`.

**Downstream consumers:** None in current roadmap. This plan is a leaf.

---

## Phase 0 — Vendor-command verification (no-code prework)

> **MANDATORY before Phase 1.** The IOS-XE `monitor capture` flow has several "gotcha" variants (capture point vs. embedded packet capture, with/without ACL referencing). Do not guess syntax.

### Task 0.1 — Confirm IOS-XE monitor capture canonical flow  `SEQUENTIAL`

- [ ] **Step 1: Query Context7 docs.**

```
mcp__plugin_context7_context7__resolve-library-id("cisco ios-xe monitor capture")
mcp__plugin_context7_context7__query-docs("cisco ios-xe embedded packet capture monitor capture match access-list export")
```

- [ ] **Step 2: Web-verify** against the Cisco Configuration Guide for IOS-XE 17.x — specifically the "Configuring Packet Capture" chapter. Record the authoritative URL.

- [ ] **Step 3: Document the canonical flow** in `docs/packet-capture/ios-xe-flow.md`:

The IOS-XE embedded packet capture (EPC) flow on 17.x is:
```
! 1. Define the capture (buffer-based, not capture-point-based on 17.x IOS-XE)
monitor capture CAP interface <intf> both
monitor capture CAP match ipv4 any any           ! or: access-list <acl>
monitor capture CAP buffer circular size 10
monitor capture CAP limit duration <seconds>
! 2. Start
monitor capture CAP start
! 3. (wait for completion signal — explicit `stop` after duration, or poll `show monitor capture CAP` until state=Inactive)
monitor capture CAP stop
! 4. Export to on-box storage
monitor capture CAP export flash:CAP.pcap        ! 17.x supports direct pcap export
! 5. Cleanup
no monitor capture CAP
```

**Gotcha documented:** some older IOS-XE (16.6 and earlier) and classic IOS 15.x require separate `monitor capture point` + `monitor capture buffer` + `associate` commands. Feature-gate on platform version detected via `show version`. Default path is 17.x; fall back is detected+errored ("upgrade to 17.x or use advanced raw mode") in Phase 1.

- [ ] **Step 4: Confirm NX-OS `ethanalyzer` flow.**

```
ethanalyzer local interface inband capture-filter "host 10.1.1.1" limit-captured-frames 100 write bootflash:CAP.pcap
! No explicit stop — blocks until frame limit or duration hit.
```

- [ ] **Step 5: Confirm Junos `monitor traffic write-file` flow.**

```
monitor traffic interface ge-0/0/0 write-file /var/tmp/cap.pcap size 65535 count 200
! CLI blocks; runs until count reached or CTRL+C. For scripted: use `start shell` + `tcpdump -i`.
```

- [ ] **Step 6: Confirm Arista EOS flow** (best-effort, low priority).

```
! EOS uses a tcpdump-style syntax via bash pass-through
bash timeout 30 sudo tcpdump -i Ethernet1 -w /mnt/flash/cap.pcap
```

- [ ] **Step 7: Commit**

```bash
git add docs/packet-capture/ios-xe-flow.md
git commit -m "docs(pcap): cite canonical vendor monitor-capture flows for Plan 11"
```

**Sources to cite in `docs/packet-capture/ios-xe-flow.md`:**
- Cisco IOS XE 17.x Configuration Guide — "Configuring Packet Capture" chapter.
- NX-OS Troubleshooting Guide — `ethanalyzer` reference (9.3+).
- Junos OS CLI Reference — `monitor traffic`.
- Arista EOS User Manual — CLI bash + `tcpdump`.
- All URLs recorded in the doc; any change to vendor syntax in Phase 1 must update this doc in the same commit.

---

## Phase 1 — Schema + vendor capture command builder (pure, fully unit-tested)

### Task 1.1 — Migration V0038  `SEQUENTIAL`

**Files:**
- Create: `src-tauri/migrations/V0038__pcap_captures.sql`

- [ ] **Step 1: Write migration**

```sql
CREATE TABLE IF NOT EXISTS pcap_captures (
  id TEXT PRIMARY KEY,                              -- uuid
  session_id TEXT,                                  -- FK-ish to ssh/agent session; nullable for ad-hoc
  device_ref TEXT NOT NULL,                         -- hostname or ssh_connections.id
  device_kind TEXT NOT NULL,                        -- 'iosxe' | 'nxos' | 'junos' | 'eos'
  interface TEXT NOT NULL,
  filter TEXT,                                      -- display filter or acl ref
  started_at INTEGER,
  ended_at INTEGER,
  status TEXT NOT NULL CHECK (status IN ('setup','capturing','pulling','ready','failed')),
  local_path TEXT,                                  -- pcap on host after pull
  packet_count INTEGER,
  size_bytes INTEGER,
  error TEXT,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
CREATE INDEX IF NOT EXISTS idx_pcap_captures_session ON pcap_captures(session_id);
CREATE INDEX IF NOT EXISTS idx_pcap_captures_status ON pcap_captures(status);
CREATE INDEX IF NOT EXISTS idx_pcap_captures_created ON pcap_captures(created_at DESC);

CREATE TABLE IF NOT EXISTS pcap_templates (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  vendor TEXT NOT NULL,
  platform TEXT NOT NULL,
  interface TEXT,                                   -- may be a placeholder like '<WAN_IF>'
  acl TEXT,
  duration_s INTEGER NOT NULL DEFAULT 30,
  builtin INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
CREATE INDEX IF NOT EXISTS idx_pcap_templates_vendor ON pcap_templates(vendor, platform);

-- Seed 4 built-in templates
INSERT INTO pcap_templates (id, name, vendor, platform, interface, acl, duration_s, builtin) VALUES
  ('tpl-iosxe-wan',  'IOS-XE WAN any-any',             'cisco',   'iosxe', '<WAN_IF>',           NULL,       30, 1),
  ('tpl-iosxe-cp',   'IOS-XE control-plane',           'cisco',   'iosxe', 'control-plane',      NULL,       20, 1),
  ('tpl-nxos-mgmt',  'NX-OS mgmt0 ethanalyzer',        'cisco',   'nxos',  'mgmt0',              NULL,       30, 1),
  ('tpl-junos-ge',   'Junos monitor traffic ge-0/0/0', 'juniper', 'junos', 'ge-0/0/0',           NULL,       30, 1);
```

- [ ] **Step 2: Apply + test**

```bash
cargo test --manifest-path src-tauri/Cargo.toml --lib db::tests::migrations_apply
```

- [ ] **Step 3: Commit**

```bash
git add src-tauri/migrations/V0038__pcap_captures.sql
git commit -m "feat(db): V0038 pcap_captures + pcap_templates with builtin seeds"
```

### Task 1.2 — Capture builder module  `SEQUENTIAL` (depends on 1.1)

**Files:**
- Create: `src-tauri/src/pcap/mod.rs`
- Create: `src-tauri/src/pcap/builder.rs`
- Create: `src-tauri/src/pcap/types.rs`
- Modify: `src-tauri/src/lib.rs` — `pub mod pcap;`

- [ ] **Step 1: Types**

`src-tauri/src/pcap/types.rs`:
```rust
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum DeviceKind { IosXe, Nxos, Junos, Eos }

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CaptureSpec {
    pub capture_name: String,     // sanitized [A-Z0-9_]{1,15}
    pub device_kind: DeviceKind,
    pub interface: String,
    pub acl: Option<String>,      // e.g. "101" or "ACL_NAME"
    pub duration_s: u32,
    pub buffer_mb: u32,           // default 10
    pub on_device_path: String,   // e.g. "flash:CAP.pcap" or "bootflash:CAP.pcap"
}

#[derive(Debug, Clone, Serialize)]
pub struct CaptureScript {
    pub setup: Vec<String>,       // lines to apply before start
    pub start: Vec<String>,       // command(s) to start
    pub poll: Option<String>,     // show cmd to detect completion (IOS-XE); None for NX-OS/Junos which block
    pub stop: Vec<String>,        // stop+export
    pub cleanup: Vec<String>,     // remove capture config
    pub remote_pcap_path: String, // where the pcap lives on-device post-stop
}
```

- [ ] **Step 2: Write the failing unit tests — exhaustive vendor coverage**

`src-tauri/src/pcap/builder.rs` (test module):
```rust
#[cfg(test)]
mod tests {
    use super::*;
    use super::super::types::{CaptureSpec, DeviceKind};

    fn spec(kind: DeviceKind, iface: &str, acl: Option<&str>, dur: u32) -> CaptureSpec {
        CaptureSpec {
            capture_name: "CAP".into(),
            device_kind: kind,
            interface: iface.into(),
            acl: acl.map(String::from),
            duration_s: dur,
            buffer_mb: 10,
            on_device_path: match kind {
                DeviceKind::IosXe => "flash:CAP.pcap".into(),
                DeviceKind::Nxos  => "bootflash:CAP.pcap".into(),
                DeviceKind::Junos => "/var/tmp/CAP.pcap".into(),
                DeviceKind::Eos   => "/mnt/flash/CAP.pcap".into(),
            },
        }
    }

    #[test]
    fn iosxe_builds_17x_flow_no_acl() {
        let s = build(&spec(DeviceKind::IosXe, "GigabitEthernet0/0/1", None, 30)).unwrap();
        assert_eq!(
            s.setup,
            vec![
                "monitor capture CAP interface GigabitEthernet0/0/1 both",
                "monitor capture CAP match ipv4 any any",
                "monitor capture CAP buffer circular size 10",
                "monitor capture CAP limit duration 30",
            ],
        );
        assert_eq!(s.start, vec!["monitor capture CAP start"]);
        assert_eq!(s.poll.as_deref(), Some("show monitor capture CAP | include State"));
        assert_eq!(s.stop, vec![
            "monitor capture CAP stop",
            "monitor capture CAP export flash:CAP.pcap",
        ]);
        assert_eq!(s.cleanup, vec!["no monitor capture CAP"]);
        assert_eq!(s.remote_pcap_path, "flash:CAP.pcap");
    }

    #[test]
    fn iosxe_uses_acl_when_provided() {
        let s = build(&spec(DeviceKind::IosXe, "Gi0/0/1", Some("MGMT_ACL"), 15)).unwrap();
        assert!(s.setup.iter().any(|l| l == "monitor capture CAP match access-list MGMT_ACL"));
        assert!(s.setup.iter().any(|l| l == "monitor capture CAP limit duration 15"));
    }

    #[test]
    fn nxos_ethanalyzer_single_line() {
        let s = build(&spec(DeviceKind::Nxos, "mgmt0", None, 30)).unwrap();
        assert!(s.setup.is_empty());
        assert_eq!(s.start, vec![
            "ethanalyzer local interface mgmt0 limit-captured-frames 0 autostop duration 30 write bootflash:CAP.pcap",
        ]);
        assert!(s.poll.is_none());          // blocks until autostop
        assert_eq!(s.stop, Vec::<String>::new());
        assert_eq!(s.cleanup, Vec::<String>::new());
        assert_eq!(s.remote_pcap_path, "bootflash:CAP.pcap");
    }

    #[test]
    fn nxos_ethanalyzer_with_capture_filter() {
        let mut sp = spec(DeviceKind::Nxos, "mgmt0", None, 30);
        sp.acl = Some("host 10.1.1.1".into());   // ethanalyzer accepts BPF-style in `capture-filter`
        let s = build(&sp).unwrap();
        assert_eq!(s.start, vec![
            r#"ethanalyzer local interface mgmt0 capture-filter "host 10.1.1.1" limit-captured-frames 0 autostop duration 30 write bootflash:CAP.pcap"#,
        ]);
    }

    #[test]
    fn junos_monitor_traffic_write_file() {
        let s = build(&spec(DeviceKind::Junos, "ge-0/0/0", None, 30)).unwrap();
        // Junos monitor traffic is interactive; we use `count` as an upper bound and `size` for snaplen.
        assert_eq!(s.start, vec![
            "monitor traffic interface ge-0/0/0 write-file /var/tmp/CAP.pcap size 65535 count 2000 no-resolve",
        ]);
        assert!(s.poll.is_none());
        assert_eq!(s.remote_pcap_path, "/var/tmp/CAP.pcap");
    }

    #[test]
    fn eos_tcpdump_via_bash() {
        let s = build(&spec(DeviceKind::Eos, "Ethernet1", None, 30)).unwrap();
        assert_eq!(s.start, vec![
            "bash timeout 30 sudo tcpdump -i Ethernet1 -U -w /mnt/flash/CAP.pcap",
        ]);
    }

    #[test]
    fn capture_name_is_sanitized() {
        let mut sp = spec(DeviceKind::IosXe, "Gi0/0/1", None, 30);
        sp.capture_name = "my cap!".into();
        let s = build(&sp).unwrap();
        // Invalid chars stripped; result uppercased, <=15 chars.
        assert!(s.setup[0].contains("MYCAP"));
    }

    #[test]
    fn rejects_empty_interface() {
        let mut sp = spec(DeviceKind::IosXe, "", None, 30);
        sp.interface = "".into();
        assert!(build(&sp).is_err());
    }

    #[test]
    fn rejects_duration_zero() {
        let mut sp = spec(DeviceKind::IosXe, "Gi0/0/1", None, 0);
        sp.duration_s = 0;
        assert!(build(&sp).is_err());
    }

    #[test]
    fn rejects_duration_too_long() {
        let mut sp = spec(DeviceKind::IosXe, "Gi0/0/1", None, 4000);
        sp.duration_s = 4000;         // cap at 3600s
        assert!(build(&sp).is_err());
    }
}
```

- [ ] **Step 3: Run — expect FAIL (no impl yet)**

```bash
cargo test --manifest-path src-tauri/Cargo.toml pcap::builder
```

- [ ] **Step 4: Implement `builder.rs`**

```rust
use super::types::{CaptureScript, CaptureSpec, DeviceKind};
use anyhow::{anyhow, Result};

const MAX_DURATION_S: u32 = 3600;

fn sanitize_name(n: &str) -> String {
    n.chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '_')
        .collect::<String>()
        .to_uppercase()
        .chars()
        .take(15)
        .collect()
}

pub fn build(spec: &CaptureSpec) -> Result<CaptureScript> {
    if spec.interface.trim().is_empty() {
        return Err(anyhow!("interface is required"));
    }
    if spec.duration_s == 0 {
        return Err(anyhow!("duration_s must be > 0"));
    }
    if spec.duration_s > MAX_DURATION_S {
        return Err(anyhow!("duration_s must be <= {}", MAX_DURATION_S));
    }
    let name = sanitize_name(&spec.capture_name);
    if name.is_empty() {
        return Err(anyhow!("capture_name sanitized to empty"));
    }

    Ok(match spec.device_kind {
        DeviceKind::IosXe => build_iosxe(&name, spec),
        DeviceKind::Nxos  => build_nxos(&name, spec),
        DeviceKind::Junos => build_junos(&name, spec),
        DeviceKind::Eos   => build_eos(&name, spec),
    })
}

fn build_iosxe(name: &str, spec: &CaptureSpec) -> CaptureScript {
    let match_line = match &spec.acl {
        Some(acl) => format!("monitor capture {name} match access-list {acl}"),
        None      => format!("monitor capture {name} match ipv4 any any"),
    };
    CaptureScript {
        setup: vec![
            format!("monitor capture {name} interface {} both", spec.interface),
            match_line,
            format!("monitor capture {name} buffer circular size {}", spec.buffer_mb),
            format!("monitor capture {name} limit duration {}", spec.duration_s),
        ],
        start: vec![format!("monitor capture {name} start")],
        poll: Some(format!("show monitor capture {name} | include State")),
        stop: vec![
            format!("monitor capture {name} stop"),
            format!("monitor capture {name} export {}", spec.on_device_path),
        ],
        cleanup: vec![format!("no monitor capture {name}")],
        remote_pcap_path: spec.on_device_path.clone(),
    }
}

fn build_nxos(_name: &str, spec: &CaptureSpec) -> CaptureScript {
    let filter = spec.acl.as_ref()
        .map(|f| format!(r#" capture-filter "{f}""#))
        .unwrap_or_default();
    CaptureScript {
        setup: vec![],
        start: vec![format!(
            "ethanalyzer local interface {}{} limit-captured-frames 0 autostop duration {} write {}",
            spec.interface, filter, spec.duration_s, spec.on_device_path
        )],
        poll: None,
        stop: vec![],
        cleanup: vec![],
        remote_pcap_path: spec.on_device_path.clone(),
    }
}

fn build_junos(_name: &str, spec: &CaptureSpec) -> CaptureScript {
    // `count` scales with duration; conservative 2000 frames default.
    CaptureScript {
        setup: vec![],
        start: vec![format!(
            "monitor traffic interface {} write-file {} size 65535 count 2000 no-resolve",
            spec.interface, spec.on_device_path,
        )],
        poll: None,
        stop: vec![],
        cleanup: vec![],
        remote_pcap_path: spec.on_device_path.clone(),
    }
}

fn build_eos(_name: &str, spec: &CaptureSpec) -> CaptureScript {
    CaptureScript {
        setup: vec![],
        start: vec![format!(
            "bash timeout {} sudo tcpdump -i {} -U -w {}",
            spec.duration_s, spec.interface, spec.on_device_path,
        )],
        poll: None,
        stop: vec![],
        cleanup: vec![],
        remote_pcap_path: spec.on_device_path.clone(),
    }
}
```

- [ ] **Step 5: Run — expect PASS** (`cargo test pcap::builder`)

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/pcap/ src-tauri/src/lib.rs
git commit -m "feat(pcap): vendor capture command builder (IOS-XE/NX-OS/Junos/EOS)"
```

### Task 1.3 — Template CRUD  `PARALLEL with 1.4`

**Files:**
- Create: `src-tauri/src/pcap/templates.rs`
- Create: `src-tauri/src/commands/pcap.rs`
- Create: `src-tauri/tests/pcap_templates_test.rs`
- Modify: `src-tauri/src/commands/mod.rs` — `pub mod pcap;`

- [ ] **Step 1: Write failing tests** for `list_templates`, `create_template`, `update_template`, `delete_template`, with builtin templates being read-only (delete returns error).

- [ ] **Step 2: Implement** following the exact pattern in `src-tauri/src/commands/ssh.rs` (rusqlite + `State<AppState>`, lock mutex, uuid via the same helper used by blocks).

- [ ] **Step 3: Register commands in `lib.rs`:**
  - `pcap_list_templates`
  - `pcap_create_template`
  - `pcap_update_template`
  - `pcap_delete_template`

- [ ] **Step 4: Commit** `feat(pcap): template CRUD tauri commands`

### Task 1.4 — Capture row CRUD  `PARALLEL with 1.3`

**Files:**
- Modify: `src-tauri/src/commands/pcap.rs`
- Create: `src-tauri/tests/pcap_captures_test.rs`

- [ ] **Step 1: Write failing tests** for:
  - `pcap_capture_create(device_ref, device_kind, interface, filter)` — returns id, status = 'setup'
  - `pcap_capture_update_status(id, status, error?)` — state machine: setup→capturing→pulling→ready | any→failed
  - `pcap_capture_finalize(id, local_path, packet_count, size_bytes)` — sets ended_at + status='ready'
  - `pcap_capture_get(id)` / `pcap_capture_list(session_id?)`
  - `pcap_capture_delete(id)` — also removes `local_path` file from disk
- [ ] **Step 2: Implement.**
- [ ] **Step 3: State-transition guard — reject invalid transitions (e.g. ready→setup).**
- [ ] **Step 4: Commit** `feat(pcap): capture row CRUD + state machine`

### Task 1.5 — Phase 1 regression  `SEQUENTIAL`

- [ ] **Step 1:** `cargo test --manifest-path src-tauri/Cargo.toml pcap` — all green (>= 20 tests).
- [ ] **Step 2:** `bun run test` — no regressions.
- [ ] **Step 3:** `bunx playwright test --grep @smoke` — green.
- [ ] **Step 4: Dispatch `feature-dev:code-reviewer`** with prompt:
  > "Review Phase 1 of Plan 11 (`/Plans/11-packet-capture-panel.md`). Focus: vendor command-string correctness against `docs/packet-capture/ios-xe-flow.md`, state-machine transitions, builtin-template immutability. Report `must-fix` vs `nits`."
- [ ] **Step 5: Update plan file** — check Phase 1 boxes, append `## Phase 1 — COMPLETED YYYY-MM-DD` block with a 2-3 line summary.
- [ ] **Step 6: Commit plan update.**

---

## Phase 2 — Capture orchestration (SSH send + wait + SFTP pull)

### Task 2.1 — Decide session strategy  `SEQUENTIAL`

- [ ] **Step 1: Read `src-tauri/src/commands/ssh.rs` fully.** Confirm whether it exposes a reusable `send_command(conn_id, cmd) -> String` — or only the CRUD for saved connections. As of plan authoring date, it's CRUD-only; the actual interactive PTY lives elsewhere (search: `rg "russh::client::connect" src-tauri/src`).

- [ ] **Step 2: Document the outcome** at the top of `src-tauri/src/pcap/orchestrator.rs` as a module doc comment. Two acceptable paths:
  - **(A)** Reuse the interactive PTY — issue commands through whatever PTY handle the rest of the app uses, sniff the prompt-echo to detect completion.
  - **(B)** Open a fresh russh session dedicated to this capture (mirrors `src-tauri/src/netconf_runner/transport.rs:connect_and_open_subsystem` but requests `shell` or `exec` rather than `netconf`).
  Path **(B)** is the default unless the PTY layer exposes a clean API. Cite the specific file/line that drove the decision.

- [ ] **Step 3: Commit** the decision comment (no impl yet). `docs(pcap): session strategy decision recorded in orchestrator.rs`

### Task 2.2 — Add `russh-sftp` dependency  `SEQUENTIAL`

**Files:**
- Modify: `src-tauri/Cargo.toml`

- [ ] **Step 1: Query Context7**

```
mcp__plugin_context7_context7__resolve-library-id("russh-sftp")
mcp__plugin_context7_context7__query-docs("russh-sftp client open download file")
```

- [ ] **Step 2: Add to `[dependencies]`**

```toml
russh-sftp = "2.0"
```

- [ ] **Step 3: Build** `cargo build --manifest-path src-tauri/Cargo.toml` — confirm no feature-flag conflicts with existing `russh = "0.60"`.
- [ ] **Step 4: Commit** `chore(deps): add russh-sftp for pcap pull`

### Task 2.3 — SSH exec wrapper  `SEQUENTIAL` (depends on 2.1+2.2)

**Files:**
- Create: `src-tauri/src/pcap/ssh_exec.rs`
- Create: `src-tauri/tests/pcap_ssh_exec_test.rs` (integration-style; behind `#[ignore]` when no test device env var)

- [ ] **Step 1: Public API**

```rust
pub struct DeviceConn {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub password: String,
}

/// Open an ssh session, run each command in `lines` sequentially, return combined stdout.
pub async fn exec_lines(conn: &DeviceConn, lines: &[String], per_cmd_timeout: Duration) -> anyhow::Result<String>;

/// Open a shell, send `cmd`, poll `done_when_stdout_matches` against stream every 1s until timeout.
pub async fn exec_and_poll<F: Fn(&str) -> bool + Send>(
    conn: &DeviceConn,
    cmd: &str,
    done_predicate: F,
    poll_timeout: Duration,
) -> anyhow::Result<String>;
```

- [ ] **Step 2: Implementation pattern** mirrors `src-tauri/src/netconf_runner/transport.rs` but replaces `request_subsystem("netconf")` with `channel.exec(true, cmd)` and reads until channel closes, or uses `channel_open_session()` + `request_shell` for the poll variant.

- [ ] **Step 3: Unit test the command-string plumbing** (mock russh via trait boundary OR run against a locally-spawned `sshd` fixture if available; if neither, mark test `#[ignore]` and document manual reproduction steps in a doc comment).

- [ ] **Step 4: Commit** `feat(pcap): ssh exec helpers for monitor capture`

### Task 2.4 — SFTP pull  `SEQUENTIAL` (depends on 2.2)

**Files:**
- Create: `src-tauri/src/pcap/sftp.rs`
- Create: `src-tauri/tests/pcap_sftp_test.rs` (integration, `#[ignore]` w/o env)

- [ ] **Step 1: Public API**

```rust
pub async fn pull_file(
    conn: &DeviceConn,
    remote_path: &str,       // e.g. "flash:CAP.pcap" → strip "flash:" for IOS-XE SFTP; NX-OS uses "/bootflash/"; Junos uses "/var/tmp/"
    local_path: &Path,
    progress_cb: impl Fn(u64, Option<u64>) + Send,
) -> anyhow::Result<u64>;   // returns bytes pulled
```

- [ ] **Step 2: Remote-path normalization helper**

```rust
pub fn normalize_remote_path(device_kind: DeviceKind, raw: &str) -> String {
    match device_kind {
        DeviceKind::IosXe => raw.strip_prefix("flash:").map(|s| format!("/flash/{s}")).unwrap_or_else(|| raw.to_string()),
        DeviceKind::Nxos  => raw.strip_prefix("bootflash:").map(|s| format!("/bootflash/{s}")).unwrap_or_else(|| raw.to_string()),
        DeviceKind::Junos | DeviceKind::Eos => raw.to_string(),
    }
}
```

- [ ] **Step 3: Unit-test `normalize_remote_path` exhaustively** for all four vendors.

- [ ] **Step 4: Implement `pull_file`** using `russh-sftp::client::SftpSession::open` + streaming read; write to a temp file under `$APPDATA/ccie-terminal/pcaps/` then atomically rename on full success.

- [ ] **Step 5: Commit** `feat(pcap): sftp pull with vendor path normalization`

### Task 2.5 — Orchestrator  `SEQUENTIAL` (depends on 2.3+2.4)

**Files:**
- Create: `src-tauri/src/pcap/orchestrator.rs`
- Modify: `src-tauri/src/commands/pcap.rs` — add `pcap_start_capture(spec, conn) -> capture_id` and `pcap_cancel(capture_id)`.

- [ ] **Step 1: Write failing state-machine test** (pure, no SSH) — the orchestrator accepts an injected `Executor` trait so we can mock the SSH layer. Verify transitions `setup → capturing → pulling → ready` and the failure branch cleans up via `cleanup` commands on both IOS-XE-success and IOS-XE-failure paths.

- [ ] **Step 2: Trait boundary**

```rust
#[async_trait::async_trait]
pub trait Executor: Send + Sync {
    async fn exec_lines(&self, lines: &[String]) -> anyhow::Result<String>;
    async fn poll_until(&self, poll_cmd: &str, done: Box<dyn Fn(&str) -> bool + Send>, timeout: Duration) -> anyhow::Result<()>;
    async fn sftp_pull(&self, remote: &str, local: &Path) -> anyhow::Result<u64>;
}
```

- [ ] **Step 3: Orchestration body**

```rust
pub async fn run<E: Executor>(
    exec: &E,
    spec: CaptureSpec,
    capture_id: &str,
    db: &Arc<Mutex<Connection>>,
    emit: impl Fn(CaptureEvent) + Send,
) -> anyhow::Result<PathBuf> {
    // 1. setup
    update_status(db, capture_id, "capturing");
    let script = builder::build(&spec)?;
    if !script.setup.is_empty() { exec.exec_lines(&script.setup).await?; }
    // 2. start
    exec.exec_lines(&script.start).await?;
    emit(CaptureEvent::Started);
    // 3. wait for completion
    if let Some(poll) = &script.poll {
        // IOS-XE: poll "show monitor capture ... State" until "Inactive"
        exec.poll_until(poll, Box::new(|out| out.contains("Inactive")), Duration::from_secs(spec.duration_s as u64 + 30)).await?;
    } else {
        // NX-OS/Junos/EOS: start command blocks for ~duration seconds; just wait duration + 5s slack.
        tokio::time::sleep(Duration::from_secs(spec.duration_s as u64 + 5)).await;
    }
    // 4. stop + export
    if !script.stop.is_empty() { exec.exec_lines(&script.stop).await?; }
    // 5. pull
    update_status(db, capture_id, "pulling");
    let remote = sftp::normalize_remote_path(spec.device_kind, &script.remote_pcap_path);
    let local = pcap_cache_dir()?.join(format!("{}.pcap", capture_id));
    let bytes = exec.sftp_pull(&remote, &local).await?;
    // 6. cleanup (best-effort; errors here are logged but do not fail capture)
    if !script.cleanup.is_empty() {
        if let Err(e) = exec.exec_lines(&script.cleanup).await {
            tracing::warn!("pcap cleanup failed for {capture_id}: {e}");
        }
    }
    // 7. finalize
    finalize(db, capture_id, &local, bytes)?;
    Ok(local)
}
```

- [ ] **Step 4: Failure path:** on any error from steps 1–5, push `status='failed'`, `error=<msg>` AND attempt `script.cleanup` once, best-effort.

- [ ] **Step 5: Emit progress via Tauri event** `pcap://progress/<capture_id>` with payload `{ phase, bytes_pulled?, error? }`.

- [ ] **Step 6: Run unit tests — expect PASS.**

- [ ] **Step 7: Commit** `feat(pcap): capture orchestrator with pluggable executor + cleanup`

### Task 2.6 — Phase 2 regression  `SEQUENTIAL`

- [ ] Full test suite (bun, cargo, playwright smoke).
- [ ] Dispatch `feature-dev:code-reviewer`: "Review Phase 2 of Plan 11. Focus: SFTP path normalization per vendor, cleanup-on-failure path executes the `no monitor capture` command even when earlier steps failed, state transitions guarded, no `.unwrap()` on SSH I/O."
- [ ] Update plan file — check Phase 2 boxes + completion block.
- [ ] Commit plan update.

---

## Phase 3 — Pcap block renderer UI (pre + post design review)

### Task 3.1 — Pre-impl UI spec via `frontend-design`  `SEQUENTIAL`

- [ ] **Step 1: Dispatch `frontend-design` skill** with brief:
  > "Design a pcap block for a Warp-inspired terminal app (React 19, Zustand, existing palette in `src/App.css`). The block is a variant of an existing command block (see `src/components/CommandBlock.tsx`). Layout: a header strip showing device/interface/duration/status chips, a tabbed body with three tabs: (1) **Packet list** — virtualized rows `no · time · src · dst · proto · length`, clickable; (2) **Protocol hierarchy** — tree with byte/percentage breakdown; (3) **Hex + ASCII** — two-column view for the selected packet. Follow-stream opens as a modal from a packet-list row action. Include a sticky display-filter input at the top of the packet-list tab and a size/packet-count summary. macOS-native feel, compact density. Deliver ASCII wireframes + class names + data-testid conventions."
- [ ] **Step 2: Save spec to** `docs/design/pcap-block.md` and commit.

### Task 3.2 — Install `@tanstack/react-table`  `PARALLEL with 3.3`

- [ ] **Step 1:** `bun add @tanstack/react-table @tanstack/react-virtual` (virtual may already be installed via Plan 01 — skip if present).
- [ ] **Step 2: Commit** `chore: add @tanstack/react-table for pcap`

### Task 3.3 — Sidecar `pcap.summarize` NDJSON command  `PARALLEL with 3.2`

**Files:**
- Modify: `sidecar/src/ccie_sidecar/server.py` — add `pcap.summarize` handler (wraps Plan 00's `summarize_pcap`)
- Create: `sidecar/tests/test_pcap_ndjson.py`

- [ ] **Step 1: Failing test** — NDJSON round-trip: request `{type: 'pcap.summarize', payload: { path, max_packets }}` → response `{type: 'pcap.summary', payload: { packet_count, packets: [...] }}`.
- [ ] **Step 2: Implement** — re-use Plan 00's `summarize_pcap` import; handle `FileNotFoundError` → emit `pcap.error`.
- [ ] **Step 3: Commit** `feat(sidecar): expose pcap.summarize over NDJSON`

### Task 3.4 — Rust bridge + Tauri command  `SEQUENTIAL` (depends on 3.3)

**Files:**
- Create: `src-tauri/src/pcap/summarize.rs` — thin wrapper mirroring `parsers/bridge.rs` pattern
- Modify: `src-tauri/src/commands/pcap.rs` — `pcap_summarize(capture_id) -> PcapSummary`

```rust
#[derive(Serialize)]
pub struct PcapPacket { pub no: u32, pub time: f64, pub src: Option<String>, pub dst: Option<String>, pub protocol: String, pub length: u32 }

#[derive(Serialize)]
pub struct PcapSummary { pub packet_count: u32, pub packets: Vec<PcapPacket>, pub size_bytes: u64 }

#[tauri::command]
pub async fn pcap_summarize(capture_id: String, bridge: State<'_, SidecarBridge>, db: State<'_, Db>) -> Result<PcapSummary, String> { ... }
```

- [ ] **Step 1: Failing test** using a mocked sidecar bridge + fixture capture row pointing at `sidecar/tests/fixtures/tiny.pcap`.
- [ ] **Step 2: Implement + register command.**
- [ ] **Step 3: Commit** `feat(pcap): pcap_summarize tauri command`

### Task 3.5 — `PcapBlock.tsx` + packet-list table  `SEQUENTIAL` (depends on 3.2+3.4)

**Files:**
- Create: `src/components/PcapBlock.tsx`
- Create: `src/components/PcapBlock.css`
- Create: `src/components/PcapPacketList.tsx`
- Create: `src/components/PcapProtocolHierarchy.tsx`
- Create: `src/components/PcapHexView.tsx`
- Create: `src/lib/pcap.ts` — Tauri invoke wrappers
- Create: `src/hooks/usePcapSummary.ts`
- Test: `.test.tsx` alongside each component

- [ ] **Step 1: Failing component tests** — render with mocked `usePcapSummary` returning 3 fixture packets; assert columns, row click selects packet, sticky filter bar exists.
- [ ] **Step 2: Implement** using @tanstack/react-table with virtualization for >100 packets.
- [ ] **Step 3: Hex view** — render `bytes` from pyshark's `pkt.get_raw_packet()` (add to sidecar in Task 4.1). Until Task 4.1 lands, stub the hex view with a "Loading raw bytes…" placeholder.
- [ ] **Step 4: Register `PcapBlock` as a `kind: 'pcap'` in `blocksStore.ts`.**
- [ ] **Step 5: Commit each component in its own commit.**

### Task 3.6 — Follow-stream modal  `SEQUENTIAL` (depends on 3.5)

**Files:**
- Create: `src/components/FollowStreamModal.tsx`
- Modify: `sidecar/src/ccie_sidecar/parsers/pcap.py` — add `follow_stream(path, stream_index) -> { client_bytes, server_bytes, packets }`
- Modify: `sidecar/src/ccie_sidecar/server.py` — `pcap.follow_stream` handler
- Modify: `src-tauri/src/commands/pcap.rs` — `pcap_follow_stream(capture_id, stream_index)`

- [ ] **Step 1: Sidecar `follow_stream`** — iterate pcap with `display_filter=f"tcp.stream eq {n}"`, reassemble `tcp.payload` by direction using the first packet's src/dst 4-tuple. Emit JSON `{client: "...", server: "...", packets: [...]}` with ASCII fallback for non-printable bytes.
- [ ] **Step 2: Tests (sidecar + rust bridge + UI).**
- [ ] **Step 3: Modal component** — two-pane diff-style view client/server bytes, toggle ASCII/Hex, copy buttons.
- [ ] **Step 4: Commit** `feat(pcap): follow-stream modal`

### Task 3.7 — Post-impl design review + Phase 3 regression  `SEQUENTIAL`

- [ ] `bun run tauri dev` + `bunx playwright` — capture screenshot of pcap block with fixture capture rendered.
- [ ] Dispatch `frontend-design` skill with screenshots; apply fixes until sign-off.
- [ ] Full regression: `bun run test`, `cargo test`, `bunx playwright test`.
- [ ] Dispatch `feature-dev:code-reviewer`.
- [ ] Update plan file — check Phase 3 boxes + completion block.
- [ ] Commit.

---

## Phase 4 — Display-filter bar (pyshark display_filter plumbing)

### Task 4.1 — Sidecar filter + raw-bytes additions  `SEQUENTIAL`

**Files:**
- Modify: `sidecar/src/ccie_sidecar/parsers/pcap.py` — add `summarize_pcap(path, max_packets, display_filter=None)` and `packet_bytes(path, index) -> { hex, ascii }`
- Modify: `sidecar/src/ccie_sidecar/server.py` — extend `pcap.summarize` payload with optional `display_filter`; add `pcap.packet_bytes` handler

- [ ] **Step 1: Failing sidecar test** — fixture pcap has 3 packets (2 ICMP, 1 DNS); `display_filter="icmp"` returns 2.
- [ ] **Step 2: Implement** — pass `display_filter=...` into `pyshark.FileCapture`. Handle pyshark's `TSharkCrashException` / invalid-filter errors and return `{type: 'pcap.error', payload: { code: 'invalid_filter', message }}`.
- [ ] **Step 3: Commit** `feat(sidecar): display_filter + raw packet bytes`

### Task 4.2 — Rust + frontend propagation  `SEQUENTIAL` (depends on 4.1)

**Files:**
- Modify: `src-tauri/src/commands/pcap.rs` — `pcap_summarize` accepts `display_filter: Option<String>`
- Modify: `src/lib/pcap.ts` + `src/hooks/usePcapSummary.ts` — accept filter arg
- Modify: `src/components/PcapPacketList.tsx` — debounced 300ms filter input; red outline on `invalid_filter`; "Showing X of Y packets" count chip.

- [ ] **Step 1: Failing hook test** — changing filter re-invokes with new arg.
- [ ] **Step 2: Implement.**
- [ ] **Step 3: Failing UI test** — type `tcp.port==443`, assert debounced call fires once after 300ms.
- [ ] **Step 4: Commit** `feat(pcap): display filter bar wired end-to-end`

### Task 4.3 — Phase 4 regression  `SEQUENTIAL`

- [ ] Full test suite. Code review. Update plan. Commit.

---

## Phase 5 — Templates library UI, export, size guardrails, docs

### Task 5.1 — Templates library UI  `PARALLEL with 5.2`

**Files:**
- Create: `src/components/PcapTemplateLibrary.tsx`
- Create: `src/components/PcapQuickCaptureWizard.tsx`
- Create: `src/components/PcapAdvancedForm.tsx`

- [ ] **Step 1: Pre-impl design spec** via `frontend-design` — split pane: left = template list (searchable, vendor-filter chips), right = wizard form (interface, optional ACL, duration slider 5–300s) OR advanced raw textarea. "Run capture" button calls `pcap_start_capture`.
- [ ] **Step 2: Failing tests.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Post-impl design review.**
- [ ] **Step 5: Commit.**

### Task 5.2 — Export to disk  `PARALLEL with 5.1`

**Files:**
- Modify: `src-tauri/src/commands/pcap.rs` — `pcap_export(capture_id, dest_path)` copies the cached file.
- Modify: `src/components/PcapBlock.tsx` — add "Export pcap…" action using `@tauri-apps/plugin-dialog`'s `save()`.

- [ ] **Step 1: Failing tests for copy + dialog invocation.**
- [ ] **Step 2: Implement.**
- [ ] **Step 3: Commit** `feat(pcap): export captured pcap to disk`

### Task 5.3 — Size-threshold warnings  `SEQUENTIAL` (depends on 5.1+5.2)

**Files:**
- Modify: `src-tauri/src/pcap/orchestrator.rs` — after SFTP pull, if `size_bytes > 100 * 1024 * 1024` emit `pcap://size_warning` event; UI surfaces a banner "Pcap is 142 MB — summarization may be slow; consider a shorter duration or narrower filter."
- Modify: `src/components/PcapBlock.tsx` — render the banner; offer "Export only" (skip in-app summarize) button.
- Constant: `const PCAP_SIZE_WARN_BYTES = 100 * 1024 * 1024;` centralized in `src-tauri/src/pcap/mod.rs`.

- [ ] **Step 1: Failing orchestrator test** — inject `sftp_pull` that returns 150 MB; assert warning event emitted.
- [ ] **Step 2: UI test** — event triggers banner.
- [ ] **Step 3: Commit** `feat(pcap): size threshold warnings for large captures`

### Task 5.4 — Docs  `PARALLEL with 5.3 completion`

**Files:**
- Create: `docs/PACKET_CAPTURE.md`

- [ ] **Step 1: Sections**
  - Architecture diagram (wizard → orchestrator → device → SFTP → sidecar → UI)
  - Vendor support matrix (table: vendor, platform, flow, limitations)
  - Template syntax + how to add a builtin
  - Display filter cheat sheet (link to Wireshark docs)
  - Size threshold behaviour
  - Troubleshooting (tshark missing, SFTP auth, flash: full)
- [ ] **Step 2: Commit** `docs: packet capture user guide`

### Task 5.5 — Phase 5 regression + close-out  `SEQUENTIAL`

- [ ] Full regression (bun, cargo, playwright).
- [ ] Code review subagent (full plan diff).
- [ ] UI review subagent (final screenshots).
- [ ] Update `/Plans/README.md` status column to ✅ Complete.
- [ ] Update this plan: all boxes checked, append final `## Phase 5 — COMPLETED YYYY-MM-DD` block.
- [ ] Commit.

---

## Self-review checklist (before marking plan complete)

- [ ] Migration number **V0038** matches `/Plans/README.md` reservation.
- [ ] Every phase ends with regression + code review + plan-file update.
- [ ] Type names (`CaptureSpec`, `CaptureScript`, `DeviceKind`, `Executor`, `PcapSummary`, `PcapPacket`) consistent across tasks.
- [ ] Phase 0 vendor-flow doc cited in `docs/packet-capture/ios-xe-flow.md` with authoritative URLs.
- [ ] Builder has unit tests for **all four** vendors + 3 validation-error paths.
- [ ] Orchestrator cleanup runs on **both** success and failure.
- [ ] SFTP path normalization tested per vendor.
- [ ] pyshark `display_filter` errors surface as `invalid_filter` (not a blanket crash).
- [ ] Sidecar `pcap.summarize`, `pcap.follow_stream`, `pcap.packet_bytes` all go through the existing NDJSON protocol (Plan 00 pattern) — no bespoke channel.
- [ ] Size-warning threshold centralized, not magic-number-duplicated.
- [ ] `builtin=1` templates are read-only in the CRUD layer.
- [ ] FTP module (`src-tauri/src/ftp/`) explicitly noted as a libunftp **server** — not reused for client-side SFTP pulls.
- [ ] UI phases (3 + 5) include BOTH pre-impl design spec AND post-impl screenshot review.
- [ ] No placeholders. Every step has code, commands, or a dispatch spec.
- [ ] Parallel vs sequential labels correct (sub-tasks that touch the same file are sequential).

## Completion log

## Phase 0 — COMPLETED 2026-05-19
Vendor command flow doc landed at `docs/packet-capture/ios-xe-flow.md`
covering IOS-XE 17.x EPC, NX-OS ethanalyzer, Junos `monitor traffic`,
Arista EOS `bash + tcpdump`, plus the SFTP path-prefix table.

## Phase 1 — COMPLETED 2026-05-19
V0038 migration + builder.rs (vendor command emitter, all four vendors +
3 validation paths) + templates CRUD with builtin read-only enforcement +
capture-row CRUD with state machine. 27 unit tests.

## Phase 2 — COMPLETED 2026-05-19
russh-sftp dependency, ssh_exec.rs (exec_lines + exec_and_poll),
sftp.rs (atomic temp-and-rename pull, vendor path normalization),
orchestrator.rs (Executor trait, cleanup-on-failure, size-warning event),
live_executor.rs glue. Session-strategy decision recorded: dedicated
russh sessions per capture (path B). 11 new tests, 38 pcap tests total.

## Phase 3 — COMPLETED 2026-05-19
Sidecar `pcap.summarize` / `pcap.packet_bytes` / `pcap.follow_stream`
NDJSON handlers; PcapBridge in Rust; PcapBlock + PcapPacketList
(virtualized @tanstack/react-table) + PcapHexView +
PcapProtocolHierarchy + FollowStreamModal. 4 new component tests; 14
sidecar tests.

## Phase 4 — COMPLETED 2026-05-19
Display-filter pipeline already wired through Phase 3; added explicit
hook tests (no-op when null, refetch on filter change, invalidFilter
flag). 3 new tests.

## Phase 5 — COMPLETED 2026-05-19
pcap_export tauri command + Export button via plugin-dialog,
PcapTemplateLibrary with search + vendor chips, PcapQuickCaptureWizard
with 5–300s slider, PcapAdvancedForm raw textarea, PACKET_CAPTURE.md
user guide. 3 new tests; 888/888 frontend, 129/129 Rust.

V0038 used. Next free migration: V0039.

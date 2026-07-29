# pyATS CLI + Agent + Tabs Integration — Design

**Date:** 2026-05-31
**Author:** brainstormed via superpowers:brainstorming
**Status:** Approved, awaiting implementation plan
**Companion to:** `2026-05-21-meraki-cli-design.md` (this design deliberately mirrors that pattern)

---

## 1. Problem & Goal

TerminAI ships `terminai-meraki` (`meraki_cli/`): a pip-installable package that introspects the
Meraki SDK into a 933-tool catalog, exposes a `MerakiClient.call(resource, action, **kwargs)`
returning a typed envelope, a `meraki-cli` console script, blast-radius gating, and a bundled
`react-code` agent. It is the proven template.

We want the same pattern for **Cisco pyATS/Genie**, modeled on the
[`automateyournetwork/pyats_mcp`](https://github.com/automateyournetwork/pyats_mcp) tool surface.
Build `terminai-pyats` so that it is:

1. A **curated catalog of ~15 device verbs** (`run-show-command`, `learn`, `configure-with-diff`,
   `ping`, `get-neighbors`, `find-interface-by-ip`, `device-health`, `rollback-config`, …) **plus a
   raw pyATS code executor** as an escape hatch.
2. Usable **standalone** (`pip install terminai-pyats` → `pyats-cli run-show-command …`) reading a
   **standard pyATS `testbed.yaml` + `.env`** (the `%ENV{}` convention `pyats_mcp` uses).
3. Available to **all AI agents** as a bundled agent (`bundled-agents/pyats/`) via the existing
   `react-code` execution mode.
4. Usable from **tabs** (topology discovery, click-to-SSH device info) with a **Settings toggle:
   sshpass (default) vs pyATS**.
5. **Fully GUI-managed** — the user never hand-edits `testbed.yaml` or `.env`. A new
   **Settings → pyATS** tab manages the device inventory and regenerates those files on save.

This spec is **pyATS-specific.** The architecture generalizes (Catalyst Center, ISE already
considered in the Meraki spec) but those remain out of scope here.

### Key product difference from Meraki

Meraki is **one cloud API key** and 933 auto-introspected endpoints. pyATS is **per-device**
(IP/OS/username/password/enable per device) and a small, hand-curated set of verbs. This reshapes
the credential model (a testbed, not a single key) and the catalog (hand-authored, not introspected).

### Security trade-off (explicit user decision)

Device passwords are stored in a **persistent plaintext `.env`** (chmod 600), GUI-managed. This is a
deliberate choice for transparency and standalone-package compatibility, accepted as a regression
versus the encrypted Plan-14 Vault. The Settings tab surfaces this trade-off in its UI copy.
Encrypted-at-rest storage with on-demand materialization is noted as a future option (§10).

## 2. Architecture

Two artifacts in one repo folder, exactly like Meraki:

1. **`terminai-pyats`** — pip-installable package at `pyats_cli/` (new top-level dir, peer of
   `meraki_cli/` and `sidecar/`). Wraps Cisco's `pyats` + `genie` (both already installed at 26.4 in
   the sidecar venv). Exposes an importable `PyatsClient`, a `pyats-cli` console script, and a
   `pyats-cli tools dump` catalog.
2. **Runtime glue** — a sidecar bridge (`ccie_sidecar/pyats/bridge.py`), a bundled agent
   (`bundled-agents/pyats/`), GUI Tauri commands (`commands/pyats.rs`), and a tab transport branch.
   **No new Rust crate; no loader changes** — `attached-tools`, `react-code`, blast-radius gating,
   and bundled-agent loading already exist and are vendor-agnostic.

### Boundary diagram

```
┌──────────────────────────────────────────────────────────────┐
│ TerminAI (Tauri)                                              │
│  Settings → pyATS tab ──► commands/pyats.rs                   │
│    (device inventory CRUD,  ├─ pyats_save_testbed             │
│     transport toggle,       ├─ pyats_test_connection          │
│     import-from-topology)   ├─ pyats_run  (tabs call this)    │
│                             └─ pyats_import_from_topology     │
│         │ writes (chmod 600)         │ JSON-RPC               │
│         ▼                            ▼                        │
│  ~/.ccie-terminal/pyats/      Sidecar (Python)                │
│    ├─ testbed.yaml            ccie_sidecar/pyats/bridge.py     │
│    └─ .env                      └─ imports terminai_pyats      │
│                                         │ in-process          │
│  Agent (react-code) ──► execute_pyats_code  ◄───┐             │
│         + tools.json catalog                    │             │
│  Tabs (sshpass default | pyATS) ────────────────┘             │
└──────────────────────────────────────────┼───────────────────┘
                                            ▼
                          terminai-pyats  (new pkg, pyats_cli/)
                            PyatsClient.call(verb, device=…, **args)
                                            ▼
                          pyATS / Genie / Unicon  (installed 26.4)
                                            ▼
                              SSH ──► network devices
```

### Key choices

- **No new Rust crate.** `commands/pyats.rs` + a sidecar bridge module, mirroring Meraki.
- **pyATS/Genie 26.4 already in the sidecar venv** — no new heavy dependency to bundle.
- **Path dependency** of `sidecar/` (dev edits immediate); publishable standalone unchanged.
- **Tabs default to today's verified sshpass path**; pyATS is opt-in via the Settings toggle — nothing
  that works today breaks.
- **Identical envelope shape** to `terminai-meraki`, so the sidecar bridge and UI tool-call cards are
  reused, not rebuilt.

## 3. The Package (`terminai-pyats`, dir `pyats_cli/`)

### Layout (mirrors `meraki_cli/`)

```
pyats_cli/
├── pyproject.toml              # name = "terminai-pyats", entry: pyats-cli
├── README.md
├── src/terminai_pyats/
│   ├── __init__.py             # exports PyatsClient, get_catalog
│   ├── client.py               # PyatsClient — connect/disconnect, .call(verb, device, **args)
│   ├── catalog.py              # ~15 curated VERB specs (hand-authored, not introspected)
│   ├── verbs/                  # one module per verb family
│   │   ├── show.py             # run-show-command (+ multi-device), Genie parse w/ raw fallback
│   │   ├── learn.py            # learn(feature): bgp/ospf/isis/interface/routing/platform…
│   │   ├── config.py           # configure, configure-with-diff, rollback
│   │   ├── ops.py              # ping, device-health, get-neighbors, find-interface-by-ip
│   │   ├── inventory.py        # list-devices, search-devices
│   │   └── code_exec.py        # run-pyats-code: sandboxed raw pyATS/Genie script
│   ├── testbed.py              # load testbed.yaml + %ENV{} from .env; build Genie testbed
│   ├── blast_radius.py         # verb → low|medium|high|destructive + destructive-keyword screen
│   ├── safety.py               # show-command validation; config keyword screen
│   ├── output.py               # JSON|table|yaml renderers (reuse Meraki shape)
│   ├── errors.py               # structured error envelope (same shape as Meraki)
│   └── cli/
│       ├── __init__.py
│       ├── main.py             # Typer root — registers verbs from catalog
│       ├── tools_cmd.py        # pyats-cli tools dump|list
│       └── version_cmd.py
└── tests/
    ├── conftest.py             # mock-testbed fixtures + live markers
    ├── test_catalog.py
    ├── test_blast_radius.py
    ├── test_safety.py          # keyword screening (reload/erase/format, pipes)
    ├── test_testbed.py         # %ENV{} substitution, build from yaml
    ├── test_verbs_mocked.py    # Unicon/Genie mocked
    └── test_live.py            # @pytest.mark.live_device against a lab device
```

### The curated catalog (`catalog.py`)

Unlike Meraki (933 auto-introspected endpoints), pyATS verbs are **hand-authored** — a fixed list
with explicit JSON-schema args and blast-radius tiers. v1 verb set is full `pyats_mcp` parity:

| Verb (`pyats.<verb>`)       | Action                                      | Blast      |
|-----------------------------|---------------------------------------------|------------|
| `list-devices`              | enumerate testbed devices                   | low        |
| `search-devices`            | fuzzy name/alias search                     | low        |
| `run-show-command`          | validated show cmd → Genie-parsed or raw    | low        |
| `run-show-command-multi`    | same, concurrent across devices             | low        |
| `learn`                     | Genie `learn(feature)` structured state     | low        |
| `device-health`             | CPU/mem/interfaces/routing snapshot         | low        |
| `get-neighbors`             | CDP/LLDP                                     | low        |
| `find-interface-by-ip`      | locate interface owning an IP               | low        |
| `ping`                      | ping from device                            | low        |
| `run-linux-command`         | host/linux exec                             | medium     |
| `configure`                 | apply config lines                          | high       |
| `configure-multi`           | multi-device config                         | high       |
| `configure-with-diff`       | apply + before/after diff                   | high       |
| `rollback-config`           | revert to last snapshot                     | high       |
| `run-pyats-code`            | sandboxed raw pyATS/Genie script            | computed*  |

\* `run-pyats-code` is classified at call time by the destructive-keyword screen: `low` if the script
is read-only, escalating to `high`/`destructive` if it contains config or destructive keywords.

### `PyatsClient` (the importable surface)

```python
from terminai_pyats import PyatsClient

client = PyatsClient.from_testbed("~/.ccie-terminal/pyats/testbed.yaml")  # or .from_dict(...)
env = client.call("run-show-command", device="CORE1", command="show ip ospf neighbor")
```

`call()` returns the **identical envelope shape** as `terminai-meraki`:

```json
{"ok": true,  "data": {"...parsed...": "..."},
 "meta": {"verb": "run-show-command", "device": "CORE1",
          "blast_radius": "low", "parsed": true, "duration_ms": 412}}
{"ok": false, "error": {"code": "connect", "message": "…", "hint": "…"},
 "meta": {"verb": "run-show-command", "device": "CORE1", "duration_ms": 30021}}
```

The Python API and the console script return the **same envelope** — the CLI JSON-serializes it.
Default output JSON; `--format table|yaml` for humans.

### Safety (`safety.py`) — pyATS-specific, no Meraki equivalent

- **Show validation:** reject `|`, `>`, `;`, backticks, and a denylist; only permit `show …` / `ping …`
  style read verbs through `run-show-command`.
- **Config screening:** scan config payloads for destructive keywords (`reload`, `erase`,
  `write erase`, `delete`, `format`, `boot system`) → forces the `destructive` tier regardless of
  base classification.
- **Code-exec sandbox:** banned imports (`os`, `sys`, `subprocess`, `socket`), wall-clock timeout —
  mirrors the existing `ccie_sidecar/agents/code_exec.py` restrictions.

### Blast-radius classifier (`blast_radius.py`)

Table-driven `classify(verb, args) -> (tier, destructive)`. Base tier comes from the catalog table
above; the destructive-keyword screen can escalate any config-bearing verb (including
`run-pyats-code`) to `destructive`. Per-verb overrides allowed for pyATS-specific knowledge.

### Credentials / testbed (`testbed.py`)

Loads a standard pyATS `testbed.yaml` whose secret fields are `%ENV{DEVICENAME_FIELD}` placeholders,
resolving them from a sibling `.env` (the `pyats_mcp` convention). Builds a Genie `Testbed` object.
`os=generic` triggers Unicon OS autodetect on first connect. No TerminAI-specific dependency — the
package works in any environment that has the two files.

## 4. GUI — Settings → pyATS tab

The "no files by hand" requirement. A new **Settings → pyATS** tab
(`src/components/settings/PyatsSettingsTab.tsx`) is the only surface the user touches.

**Device inventory table** — columns: name, IP/host, OS
(`iosxe`/`iosxr`/`nxos`/`ios`/`eos`/`junos`/`linux`/`generic`-autodetect), port, username, password,
enable password, platform. Add/edit/delete rows. A **Test Connection** button per row calls
`pyats_test_connection`.

**Import from topology** — one click pulls devices the app already discovered (topology inventory)
into the table, pre-filling IP/OS where known. Backed by `pyats_import_from_topology`.

**Transport toggle** — global app setting `tab_transport: "sshpass" | "pyats"` (default **sshpass**),
consumed by topology discovery and click-to-SSH info.

**On save** → `pyats_save_testbed` writes two files to `~/.ccie-terminal/pyats/` (chmod 600):

- `testbed.yaml` — devices with `%ENV{DEVICENAME_FIELD}` placeholders (no secrets in this file).
- `.env` — `CORE1_IP=…`, `CORE1_PASSWORD=…`, etc. **Plaintext** (explicit user choice), chmod 600,
  documented in the tab UI: "Device passwords are stored unencrypted on this machine."

This keeps the package standalone-compatible (it reads the two standard files) while the user only
ever interacts with the GUI.

## 5. Agent integration (`bundled-agents/pyats/`)

A bundled agent exactly like Meraki's:

```
bundled-agents/pyats/
├── AGENT.md      # execution-mode: react-code, attached-tools: [{id: pyats, catalog: tools.json}]
└── tools.json    # `pyats-cli tools dump` output (the 15-verb catalog)
```

`AGENT.md`'s system prompt teaches the device-verb workflow ("to answer about OSPF on CORE1:
`run-show-command "show ip ospf neighbor"`, or `learn("ospf")`"; "always confirm before
`configure`"). It uses the **existing `react-code` loop** — the agent gets an `execute_pyats_code`
tool wired to `PyatsClient`, blast-radius gating through the existing `ToolApprovalModal`, and audit
logging into the existing tool-call table.

**No Rust/loader changes.** `attached-tools`, `react-code`, blast-radius, and bundled-agent loading
already exist and are vendor-agnostic. The sidecar bridge (`ccie_sidecar/pyats/bridge.py`) is the only
new sidecar code: it builds the testbed from the GUI-managed files and exposes `PyatsClient` to the
sandbox, the same way Meraki's key is injected.

## 6. Tabs & transport toggle

A `Transport` enum drives topology discovery and click-to-SSH device info:

- **sshpass (default):** unchanged — today's `ssh_exec` / `topology_discover_device` path. Zero
  regression.
- **pyATS:** `commands/pyats.rs::pyats_run` → sidecar → `PyatsClient` connect + `learn('cdp')` /
  `learn('lldp')` / `run-show-command`, returning richer structured neighbor/interface/routing data.

The toggle is read in `topology_discover_device` and the click-to-SSH info resolver: a thin branch
picks the engine. Both paths converge on the **same normalized neighbor shape**
(`ccie_sidecar/topology/neighbors.py` already exists), so downstream graph code is untouched.
`pyats_run` is also directly callable from the frontend for on-demand structured device info in tabs.

## 7. Data, State & Storage

| Data                          | Persisted? | Where                                                  | Why |
|-------------------------------|------------|--------------------------------------------------------|-----|
| Device inventory (+passwords) | yes        | `~/.ccie-terminal/pyats/.env` (plaintext, chmod 600) + `testbed.yaml` (placeholders) | GUI-managed; package reads standard files; standalone-compatible. Plaintext = explicit user choice. |
| Transport toggle              | yes        | app settings (`tab_transport`, default `sshpass`)      | drives tab engine selection |
| Tool catalog JSON             | yes (regen)| `bundled-agents/pyats/tools.json`                      | `pyats-cli tools dump`; loaded by agent loop |
| Agent definition              | yes        | `bundled-agents/pyats/AGENT.md`                        | existing bundled-agent path |
| Tool-call audit               | yes        | existing tool-call audit table                         | every verb: device, command, blast tier, approval, duration |
| Connected Unicon sessions     | per-process| sidecar memory                                         | one connection per device, cached, disconnected on idle |
| Config rollback snapshots     | yes        | `~/.ccie-terminal/pyats/snapshots/<device>/`           | `configure-with-diff` / `rollback-config` need last-known-good |
| Show/parse output bodies      | **no**     | in-process only                                        | too large; envelope summary only in audit |

**No new SQL migration needed** — files + existing settings + the existing audit table cover
everything. pyATS reuses the same `react-code` infrastructure Meraki uses, which already has its
tables.

### Failure modes

| Failure | Behavior |
|---|---|
| Device unreachable / auth fail | `{ok:false, error:{code:"connect", hint:"check IP/creds in Settings → pyATS, or Test Connection"}}` |
| No Genie parser for a command | Fall back to raw text; `meta.parsed=false` |
| Destructive keyword in config | Forced `destructive` tier → ToolApprovalModal |
| `.env` / `testbed.yaml` missing | Error pointing to the Settings → pyATS tab |
| pyATS transport fails in a tab | Surfaced as an error — **no silent fallback** to sshpass (explicit-toggle design); user flips back |
| Connection timeout | 30s default per call; returned as error envelope |

## 8. Testing

```
pyats_cli/tests/
├── test_catalog.py         # 15 verbs present, valid JSON-schema args
├── test_blast_radius.py    # table-driven, every verb tier asserted
├── test_safety.py          # pipes/redirects blocked; reload/erase/format → destructive
├── test_testbed.py         # %ENV{} substitution, build Genie testbed from yaml
├── test_verbs_mocked.py    # Unicon connect + Genie parse mocked (no real device)
└── test_live.py            # @pytest.mark.live_device  (lab device via .env)
```

- `pytest -m "not live_device"` → CI default, no secrets, no hardware.
- `pytest -m live_device` → manual, against a lab device.
- **Frontend:** `PyatsSettingsTab.test.tsx` (inventory CRUD, import-from-topology, transport toggle,
  save → file-write mock). Reuse existing agent tool-call card tests (same envelope shape).
- **Rust:** `commands/pyats.rs` tests — testbed materialization (chmod 600 asserted), `pyats_run`
  JSON-RPC round-trip mocked at the sidecar boundary, transport-branch selection in topology
  discovery.

## 9. Roll-out (Phase Plan)

Six phases, each merges to main on its own.

| Phase | Scope | Acceptance |
|---|---|---|
| **1. Package core** | `pyats_cli/` skeleton, `PyatsClient`, `testbed.py` (yaml + .env), `output.py`/`errors.py` (envelope), `pyats-cli` entry point. Read verbs only: `list/search-devices`, `run-show-command`, `learn`, `ping`. | `pyats-cli run-show-command --device CORE1 --command "show version"` works standalone against a lab device. |
| **2. Full verb catalog + safety + blast-radius** | Remaining verbs (`configure*`, `rollback-config`, `device-health`, `get-neighbors`, `find-interface-by-ip`, `run-linux-command`, `run-pyats-code`), `safety.py`, `blast_radius.py`, `tools dump`. | `pyats-cli tools dump` → valid 15-verb catalog; `test_safety`/`test_blast_radius` green. |
| **3. Sidecar bridge + bundled agent** | `ccie_sidecar/pyats/bridge.py`, `bundled-agents/pyats/{AGENT.md,tools.json}`, path-dep in sidecar `pyproject.toml`. | A `pyats` agent in AgentPanel answers "show OSPF neighbors on CORE1" end-to-end; writes gate via ToolApprovalModal. |
| **4. Settings → pyATS GUI** | `PyatsSettingsTab.tsx`, `commands/pyats.rs` (`pyats_save_testbed`, `pyats_test_connection`, `pyats_import_from_topology`), file materialization (chmod 600). | User adds a device in the GUI, hits Test Connection (green), saves → `testbed.yaml`+`.env` written; agent uses them with zero hand-editing. |
| **5. Tab transport toggle** | `tab_transport` setting, branch in `topology_discover_device` + click-to-SSH resolver, `pyats_run` callable from frontend. | Flipping the toggle to pyATS makes topology discovery use pyATS `learn(cdp/lldp)`; default sshpass path unchanged. |
| **6. Live tests + docs** | `live_device` suite, `pyats_cli/README.md`, `docs/PYATS_CLI.md`, USER_GUIDE section. | Manual live run reproducible; docs cover standalone `pip install` + GUI workflow. |

## 10. Out of Scope (YAGNI v1)

- **Encrypted-at-rest device creds.** User chose plaintext `.env` for v1. Future option: store creds
  in the Plan-14 Vault and materialize a temporary `testbed.yaml`+`.env` (chmod 600) on demand,
  deleting after the run.
- **Non-Cisco deep parsing** beyond what Genie/Unicon already supports out of the box.
- **Auto / per-device transport fallback.** Explicit sshpass-vs-pyATS toggle only.
- **pyATS Clean / image-upgrade workflows.**
- **Catalyst Center / ISE / SNA pyATS-style packages.** Same architecture scales to them; each is its
  own spec.

## 11. Open Questions

None at design approval. The implementation plan (next, via `superpowers:writing-plans`) turns each
phase row into a concrete task breakdown.

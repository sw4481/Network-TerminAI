# NMAP — Deep host/service/OS discovery for agents

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every AI agent in CCIE Terminal an `nmap` capability so it can run
deep discovery scans — enumerate open ports/services, fingerprint applications
(product + version via `-sV`/`-sC` NSE scripts), and detect host/OS type (`-O`/`-A`) to
classify **what a device is and what it is running**. The capability is prepackaged (the
tool is always present in the sandbox); the `nmap` binary itself is detected on PATH with
guided-install fallback.

## Context

There is **no scanning capability anywhere** in the repo today (`grep -ri nmap` / `port
scan` / `host discovery` → nothing). Agents reach vendor/tool capabilities through a
**code-execution sandbox**: a Python facade object is pre-bound into the sandbox namespace
and the agent drives it via the single `execute_python_code` tool. The established shape
for such a facade is the `proxmox_api/` package. This plan replicates that shape for nmap
and binds it **zero-config into every agent's sandbox** (exactly like `proxmox`, `drawio`,
`uml`).

**Decisions (locked in with the operator):**
- **Binary shipping — Auto-detect + guided install.** Do NOT bundle the nmap binary or its
  datadir. Detect via `shutil.which("nmap")`; if missing, the tool returns a clear
  `brew install nmap` / `apt install nmap` message. Matches the existing
  terraform/tshark/sshpass "native CLI tools live on PATH" convention.
- **Privileged scans — Supported.** OS detection (`-O`), SYN (`-sS`) and aggressive (`-A`)
  scans need root. Run directly if already root; on macOS prompt once via `osascript ... with
  administrator privileges`; on non-root non-macOS return a clear elevation-needed error.
- **Agent surface — Global tool only.** No dedicated agent/persona and no `tools.json`. Bind
  `nmap` unconditionally so the Network Architect and all agents can call it.
- **Safety — No gate.** No `confirm=True` step and no target allowlist. Scans run immediately.

## Reference files (mirror; do NOT modify)

- `sidecar/src/ccie_sidecar/proxmox_api/{facade,catalog,helper,config,ops,client}.py` — the
  multi-file facade + catalog + helper shape to copy.
- `sidecar/src/ccie_sidecar/agents/iac_lint.py` — the `shutil.which(...)` guard →
  `subprocess.run([...], capture_output=True, text=True, timeout=N)` → structured-dict pattern.
- `sidecar/src/ccie_sidecar/agents/code_exec.py:192-199` — the zero-config `install_proxmox(...)`
  block to imitate for `install_nmap(...)`.
- `sidecar/pyproject.toml` — `lxml>=5.2` is already a dependency (use it to parse nmap XML;
  no new dep needed).

## Architecture

New package `sidecar/src/ccie_sidecar/nmap_api/` (shell out to the `nmap` binary, parse
`-oX -` XML with `lxml`):

- `client.py` — locate + execute nmap across privilege tiers.
- `parse.py` — nmap XML → compact structured dict (hosts/ports/services/os).
- `ops.py` — stateless scan functions, each returning `{"ok": ...}`.
- `catalog.py` — `Capability` list + `help`/`search`/`get` (on-demand discovery).
- `facade.py` — `NmapFacade` the agent calls (no confirm gate).
- `helper.py` — `install_nmap(globals_dict, emit=None)` binds it as global + module.
- `__init__.py` — exports `install_nmap`, `NmapFacade`.
- `test_nmap.py` — unit tests.

**Zero Rust/Tauri, zero migration, zero Settings-tab, zero pip dep, zero new bundled binary.**

## Tasks

### Task 1 — `client.py`: locate + run nmap
- [ ] `find_nmap() -> str | None` using `shutil.which("nmap")`.
- [ ] `run_nmap(argv: list[str], timeout: int = 300, privileged: bool = False) -> dict`:
  - [ ] If `find_nmap()` is None → `{"ok": False, "error": "nmap is not installed. Install
        it with `brew install nmap` (macOS) or `apt install nmap` (Linux), then retry."}`.
  - [ ] Always append `-oX -` (XML to stdout) to the argv the ops layer passes.
  - [ ] Execution tiers:
    - not `privileged`, OR `os.geteuid() == 0` → `subprocess.run(["nmap", *argv], capture_output=True, text=True, timeout=timeout)`.
    - `privileged` + not root + macOS → run via `osascript -e 'do shell script "nmap ..."
      with administrator privileges'` (one-shot admin prompt — NOT a daemon). Shell-quote args.
    - `privileged` + not root + non-macOS → `{"ok": False, "error": "OS/SYN scan needs root.
      Re-launch the app elevated, or give nmap cap_net_raw."}`.
  - [ ] Wrap in try/except; on `subprocess.TimeoutExpired` and any exception return
        `{"ok": False, "error": ...}`. Non-zero exit with usable XML on stdout still parses.
  - [ ] Success → `{"ok": True, "raw_xml": stdout}`.

### Task 2 — `parse.py`: XML → structured dict
- [ ] `parse_nmap_xml(xml: str) -> dict` with `lxml.etree`. Per host extract: addresses
      (addr/addrtype), hostnames, `status/@state`; per port: protocol, portid, `state/@state`,
      and `service` name/product/version/extrainfo/ostype + `cpe`; plus `os` (`osmatch` name +
      accuracy) and `osclass` (type/vendor/osfamily/accuracy).
- [ ] Return compact `{"hosts": [...]}` — this is the "what device / what apps" payload.
      Never return raw XML to the agent.

### Task 3 — `ops.py`: scan operations
Mirror `proxmox_api/ops.py` `_ok`/`_err`. Each builds argv → `client.run_nmap` →
`parse.parse_nmap_xml`, returns a dict.
- [ ] `discover_hosts(targets)` → `-sn` (host sweep, unprivileged).
- [ ] `scan_ports(targets, ports=None)` → `-sT` (`-p <ports>` if given; unprivileged).
- [ ] `service_scan(targets, ports=None)` → `-sV -sC` (version + default NSE; unprivileged) —
      primary "what app is running" scan.
- [ ] `os_detect(targets)` → `-O` (privileged=True).
- [ ] `deep_scan(targets)` → `-A` (OS + version + scripts + traceroute; privileged=True) —
      deepest classify-this-device scan.
- [ ] `custom(targets, flags)` → escape hatch. Strip caller-supplied output flags
      (`-oN/-oX/-oG/-oA`) and reject shell metacharacters in `targets`.

### Task 4 — `catalog.py`: discovery
- [ ] Copy `proxmox_api/catalog.py` structure: `Capability(name, group, signature, doc, risk)`,
      `CAPABILITIES` list (one per op), `help(topic)`, `search(query)`, `get(name)`.
- [ ] In each `doc`, state whether the scan needs elevation (so the model knows `os_detect`
      /`deep_scan` may trigger an admin prompt). `risk` is documentation-only (no gate).

### Task 5 — `facade.py` + `helper.py` + `__init__.py`
- [ ] `NmapFacade`: `help`/`search` delegate to catalog; one method per op → `ops.*`.
      **No `confirm` gate** (unlike ProxmoxFacade).
- [ ] `install_nmap(globals_dict, emit=None)` — copy `proxmox_api/helper.py` verbatim,
      swapping names: bind `nmap` as a global AND `sys.modules["nmap"]`. (No clash — the
      third-party `python-nmap` pip package is not installed.)
- [ ] `__init__.py` exports `install_nmap`, `NmapFacade`.

### Task 6 — Wire into the sandbox (BOTH active loops)
Add the zero-config block (copy proxmox block at `code_exec.py:192-199`) to **both**:
- [ ] `sidecar/src/ccie_sidecar/agents/code_exec.py`
- [ ] `sidecar/src/ccie_sidecar/agents/react_code.py`
```python
try:
    from ccie_sidecar.nmap_api.helper import install_nmap
    install_nmap(globals_dict, emit=emit)
except ImportError:
    pass
```
- [ ] No `sandbox_index.py` change (nmap self-documents via `nmap.help()`, like proxmox).

### Task 7 — Tests (`nmap_api/test_nmap.py`)
- [ ] `parse_nmap_xml` against a captured sample XML fixture (hosts/ports/service/os fields).
- [ ] `find_nmap`/`run_nmap` with `shutil.which` monkeypatched to None → guidance error dict.
- [ ] `run_nmap` with `subprocess.run` monkeypatched: asserts `-oX -` appended; privileged
      non-root non-macOS returns the elevation-needed error.
- [ ] `catalog.help()` lists every capability; facade methods return dicts.

## Verification (end-to-end)

1. **Unit:** `cd sidecar && .venv/bin/python -m pytest src/ccie_sidecar/nmap_api/ -q`.
2. **Sandbox bind (dev, app running):** with `brew install nmap` present, ask an agent
   "scan localhost and tell me what services are open." Confirm it calls `nmap.help()` then
   `nmap.service_scan("127.0.0.1")` and reports parsed services. (Dev server must actually be
   running — verify live, don't assume.)
3. **Classification:** point it at a lab device — "what kind of device is 192.168.x.x and what
   is it running?" Confirm `service_scan`/`deep_scan` returns service product/version + OS guesses.
4. **Elevation (macOS):** ask for OS detection; confirm the one-shot admin prompt appears and
   `os_detect` returns OS matches after auth.
5. **Missing binary:** rename nmap off PATH; confirm the `brew install nmap` guidance is
   returned instead of a traceback.

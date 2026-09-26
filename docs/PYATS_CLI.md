# pyATS CLI (`terminai-pyats`)

Cisco pyATS/Genie device automation as a CLI, an importable Python client, and a bundled TerminAI agent. Returns a typed `{ok, data/error, meta}` envelope.

## Inside TerminAI (recommended)

1. Open **Settings → pyATS** (⌘,).
2. Click **Add Device** (or **Import from Topology**) and fill in name, host/IP, OS, username, and password. Click **Test** to verify reachability.
3. Click **Save** — the app writes `~/.ccie-terminal/pyats/testbed.yaml` and a `.env` (file permissions 600). **Device passwords are stored unencrypted.**
4. Open the **pyats** agent in the Agent panel (⌘⇧A) and ask, e.g. *"show OSPF neighbors on CORE1"* or *"learn the BGP state on EDGE2"*. Writes (`configure*`, `rollback`) prompt for approval.

### Tab transport toggle

Settings → pyATS has a **Use pyATS for tabs** checkbox. Off (default): topology discovery and click-to-SSH use the `sshpass` path. On: they use pyATS `get-neighbors` for richer structured data.

## Standalone (`pip install terminai-pyats`)

Create `testbed.yaml`:

```yaml
devices:
  CORE1:
    os: iosxe
    credentials:
      default:
        username: "%ENV{CORE1_USERNAME}"
        password: "%ENV{CORE1_PASSWORD}"
    connections:
      cli:
        protocol: ssh
        ip: "%ENV{CORE1_IP}"
        port: "%ENV{CORE1_PORT}"
```

and a sibling `.env`:

```
CORE1_IP=10.0.0.1
CORE1_PORT=22
CORE1_USERNAME=admin
CORE1_PASSWORD=secret
```

Then:

```bash
pyats-cli run-show-command --device CORE1 --command "show version"
pyats-cli learn --device CORE1 --feature ospf
pyats-cli tools list
```

Or from Python:

```python
from terminai_pyats import PyatsClient
client = PyatsClient.from_testbed("testbed.yaml")
print(client.call("get-neighbors", device="CORE1"))
```

## Verbs

| Verb | Blast | Notes |
|------|-------|-------|
| list-devices / search-devices | low | testbed inventory |
| run-show-command / -multi | low | Genie-parsed, raw fallback |
| learn | low | structured feature state |
| device-health | low | platform/interface/routing snapshot |
| get-neighbors | low | CDP + LLDP |
| find-interface-by-ip | low | |
| ping | low | |
| run-linux-command | medium | host/Linux devices |
| configure / -multi / -with-diff | high | requires approval |
| rollback-config | high | restores last with-diff snapshot |
| run-pyats-code | computed | raw script; escalates on config/destructive keywords |

## Safety

`run-show-command` rejects pipes, redirects, and non-read commands. Config payloads containing `reload`, `erase`, `format`, `delete`, `boot system`, etc. are forced to the `destructive` tier and always require approval.

## Architecture

- **Package**: `pyats_cli/` - standalone pip-installable CLI + Python client
- **Sidecar bridge**: `sidecar/src/ccie_sidecar/pyats/bridge.py` - testbed loader for react-code execution
- **Bundled agent**: `bundled-agents/pyats/` - AgentPanel integration with tools.json catalog
- **Settings GUI**: React components + Tauri commands for device management
- **Transport toggle**: Optional pyATS integration for topology discovery (default: sshpass)

## Testing

```bash
# Package tests (85 passing)
cd pyats_cli && python -m pytest -v

# Sidecar tests (6 passing)  
cd sidecar && python -m pytest tests/pyats/ -v

# Live device tests (skipped by default)
export PYATS_TEST_TESTBED=~/testbed.yaml
export PYATS_TEST_DEVICE=CORE1
cd pyats_cli && python -m pytest tests/test_live.py -v
```

## Security Note

**Device passwords are stored unencrypted** in `~/.ccie-terminal/pyats/.env` (file permissions 600). This is a deliberate trade-off for transparency and standalone-package compatibility. The `.env` file is GUI-managed and never committed to git.

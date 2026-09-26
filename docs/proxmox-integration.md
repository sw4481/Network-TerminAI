# Proxmox VE Integration

Proxmox VE control is available to **every** agent through the single
`execute_python_code` sandbox tool — following Anthropic's "code execution with
MCP" pattern. The LLM sees one tool, not 30 Proxmox schemas.

## For users

1. Open **Settings → Proxmox**.
2. Enter host (e.g. `proxmox.example.test`), user (`root@pam`), and either an API token
   (recommended) or a password. Save.
3. Ask any agent to work with Proxmox ("list my VMs", "snapshot VM 105").

Connection details are stored locally in the app config DB (same as your AI
provider key), not in the encrypted vault, so all agents can use them without
unlocking anything.

## For the model

Inside `execute_python_code`:

```python
import proxmox
proxmox.help()                       # list capabilities
proxmox.help("snapshot")             # signatures for a topic
vms = proxmox.get_vms()              # {"ok": True, "vms": [...]}
proxmox.create_snapshot("pve1", "105", "pre-change")
proxmox.rollback_snapshot("pve1", "105", "pre-change", confirm=True)  # destructive
```

## Safety (v1)

Destructive operations (`delete_vm`, `delete_container`, `delete_snapshot`,
`rollback_snapshot`, `restore_backup`, `delete_backup`, `delete_iso`,
`execute_vm_command`, `execute_container_command`) refuse to run unless called
with `confirm=True`. The agent persona is instructed to confirm intent with the
user first. A UI approval modal is a planned follow-up (the reverse-RPC and IaC
interrupt channels don't fit in-sandbox calls — see the design doc).

## Source

Operation logic adapted from
[ProxmoxMCP-Plus](https://github.com/RekklesNA/ProxmoxMCP-Plus) (MIT), with the
FastMCP server layer removed; ops return plain dicts and run in-process.

See `docs/superpowers/specs/2026-06-15-proxmox-code-api-design.md` for the full
design.

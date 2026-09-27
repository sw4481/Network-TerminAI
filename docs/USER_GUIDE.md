# TerminAI User Guide

TerminAI is a terminal, network-operations workspace, and AI assistant for engineers. This guide explains what each feature is for and where to open it.

## First launch

1. Open TerminAI.
2. Open **Settings → General**.
3. Choose your AI provider and model.
4. Enter the provider API key or local base URL.
5. Click **Save Configuration**.
6. Click **Test Connection**.
7. Open a terminal tab or configure an integration in Settings.

If you do not want cloud AI, use a local provider such as Ollama or vLLM and enter its local base URL.

## Terminal basics

### Tabs and panes

- **New tab:** `Cmd+T` / `Ctrl+T`, or use the tab bar.
- **Close tab or pane:** `Cmd+W` / `Ctrl+W`.
- **Switch tabs:** click a tab or use `Cmd+1` through `Cmd+9`.
- **Reopen recently closed:** `Cmd+Shift+O`.
- **Split vertically:** `Cmd+D`.
- **Split horizontally:** `Cmd+Shift+D`.
- **Move pane focus:** `Cmd+Alt+Arrow`.

Tabs, panes, scrollback, and sessions restore after restart.

### Terminal Mode

Use **Terminal Mode** for normal interactive shells and programs:

- SSH sessions
- network device CLIs
- `vim`, `less`, `top`, `python`, and other interactive tools

### Blocks Mode

Use **Blocks Mode** when you want each command and result saved as a clean block.

A block can be:

- collapsed or expanded;
- copied;
- rerun;
- bookmarked;
- pinned;
- tagged;
- searched;
- sent to a workflow or notebook.

Use Terminal Mode for interactive programs. Blocks Mode is for simple command runs and readable history.

## Command Palette

Open with `Cmd+K` / `Ctrl+K`.

Use it to find commands, tabs, saved items, blocks, devices, workflows, notebooks, skills, and app actions.

Type a few letters, choose the item, and press Enter.

## AI features

### AI panel

Open the AI panel from the tab bar or with `Cmd+Shift+A` / `Ctrl+Shift+A`.

Use it to:

- ask questions about output;
- generate commands;
- explain failures;
- use RAG sources;
- run skills;
- use MCP tools;
- use configured network integrations.

Review commands and approval prompts before allowing any action.

### Voice dictation

1. Open the Agent panel.
2. Click the microphone.
3. Speak.
4. Click the microphone again.
5. Review the inserted text.
6. Send when ready.

Dictation is local and editable. It does not auto-send.

### Natural-language commands

Type `>` at the start of terminal input, then describe the command you want.

Example:

```text
> list files changed today
```

Review the generated command before running it.

## SSH, SFTP, serial, FTP, and TFTP

### SSH saved connections

Open **SSH → Saved Connections…**.

Use saved connections for devices you use often. Store hostname, port, username, folders, and tags. Test a connection before using it in automation.

### SFTP

Open **SSH → SFTP…**.

Use it to browse remote folders, upload, download, rename, delete, and cancel transfers.

### Serial console

Open **SSH → Serial Console…**.

Choose the USB serial port, baud rate, data bits, parity, stop bits, and flow control. Use **Break** when a device needs a break signal.

### FTP and TFTP servers

Open **Settings → FTP Server** or **Settings → TFTP Server**.

Use these for lab file transfers. Start the service, confirm the port, and watch the footer status pill. Port 69 may require elevated permission on macOS.

## API and NETCONF workspaces

### API workspace

Create an API tab for HTTP work.

Use it to:

- send requests;
- save requests;
- use environments;
- import OpenAPI or Postman data;
- review request history;
- ask AI to explain a response;
- pipe results to the terminal or AI panel.

### NETCONF workspace

Create a NETCONF tab for device RPC work.

Use it to:

- save device profiles;
- write and run YANG/RPC payloads;
- save common RPCs;
- inspect response history;
- ask AI to explain output.

Review config-changing RPCs before running them.

## Editor and IaC Studio

### Editor

Create an Editor tab to work on files.

Features include:

- Monaco editor;
- split and detached editor panes;
- search and replace;
- bookmarks;
- Git status, diff, and history;
- Python debug controls;
- YAML and HCL support;
- Cisco IOS-XE and NX-OS offline diagnostics.

### IaC Studio

Open with `Cmd+Shift+E` or **Operate → IaC**.

Use it to edit Terraform and Ansible-oriented projects, generate code with AI, review diffs, run approved operations, push to Git, and inspect CI status.

### Terraform state browser

Open with `Cmd+Shift+S` or **Operate → IaC → Open Terraform State**.

Use it to open a project state directory, search resources, and inspect state.

## Workflows and notebooks

### Workflows

Open with `Cmd+Shift+W` or **Operate → Tools → Workflows**.

Use workflows for repeatable multi-step command templates. Create, edit, import, export, pin, and run them with parameters.

### Notebooks and MOPs

Open with `Cmd+Shift+N` or **Operate → Tools → Notebooks**.

Use notebooks to write runbooks with:

- Markdown cells;
- command cells;
- assertion cells;
- prompt cells;
- narrative evidence.

Run a notebook against a selected device and pause or resume execution as needed.

## Audit tools

### Change verification

Open with `Cmd+Shift+C` or **Audit → Change**.

Use it for pre-check and post-check bundles. Capture command output, compare diffs, record approvals, and export a Markdown report.

Shortcuts:

- `Cmd+Shift+1`: run pre-check
- `Cmd+Shift+2`: run post-check

### Fan-Out

Open with `Cmd+Shift+F` or **Audit → Fan-Out**.

Use it to run one command across a group of devices. Review per-device status, retry failures, cancel work, and export results.

### Drift

Open with `Cmd+Shift+D` or **Audit → Drift**.

Use it to define intended config, bind devices, run checks, schedule checks, acknowledge findings, and review history.

### Guardrails

Open with `Cmd+Shift+G` or **Audit → Guardrails**.

Use it to review risk classifications, edit rules, approve or deny actions, request second opinion, and inspect the decision log.

### Troubleshooting

Open with `Cmd+Shift+T` or **Audit → Troubleshoot**.

Use it to choose a symptom, run a playbook, answer prompts, gather evidence, and review a conclusion.

Open the playbook editor with `Cmd+Alt+T`.

### Heartbeats

Open with `Cmd+Shift+H` or **Operate → Heartbeat**.

Use it for recurring checks. Create a heartbeat, pause or resume it, run it now, and inspect history.

## Network operations tools

### Packet captures

Open with `Cmd+Shift+K` or **Operate → Captures**.

Use templates or advanced parameters to start IOS-XE EPC captures, fetch PCAP files, inspect packets, view hex/protocol details, scan findings, and export evidence.

### Topology

Create a Topology tab or use inline topology from supported output.

TerminAI can ingest CDP, LLDP, BGP, OSPF, and IS-IS neighbors. Use the graph to inspect nodes, filter links, discover devices, save neighbors, and open SSH or NETCONF.

### Diagrams

Open with `Cmd+Shift+I` or **Operate → Diagrams**.

Use it to view agent-produced Mermaid or draw.io-style diagrams and export them.

### Subnet tools

Open with `Cmd+Shift+U` or **Operate → Tools → Subnet Calculator**.

Use it for CIDR calculations, subnet splitting, VLSM design, supernetting, IP checks, visualization, and quick reference.

### Browser window

Open with `Cmd+Shift+B` or **Operate → Browser**.

Use it to open a controlled browser window for a URL. Configure browser-control behavior in Settings.

## Security features

### Credential Vault

Open with `Cmd+Shift+V` or **Operate → Vault**.

Use it to create encrypted envelopes, add secrets, reveal secrets, import 1Password or Bitwarden CSV, lock envelopes, and review the audit log.

Shortcut:

- `Cmd+L`: lock active vault envelope

### Recording

Open with `Cmd+Shift+R` or **Operate → Recording**.

Use it to record a terminal session with redaction, replay it, scrub playback, and export a redacted cast. Review exports before sharing.

## Knowledge and AI configuration

### RAG library

Open **Settings → RAG**.

Add PDF, HTML, Markdown, or text knowledge sources. Tag them, manage indexing, and inspect retrieved snippets from AI answers.

### Agents

Open **Settings → Agents**.

Manage agent definitions, tools, sources, and behavior. Use the Agent panel to ask typed or dictated questions.

### Skills

Open **Settings → Skills**.

Discover, reload, create, and invoke reusable AI workflows with prompts and helper scripts.

### MCP servers

Open **Settings → MCP Servers**.

Add, import, enable, disable, remove, and review external Model Context Protocol servers. Set approval policies before using tools.

### Network Architect and SOUL

Open **Settings → Network Architect**.

Use the Network Architect agent for cross-vendor design, troubleshooting, and diagrams. Configure its sources and behavior before using it on real environments.

### Vendor Keywords

Open **Settings → Vendor Keywords**.

Use this to tune how TerminAI routes vendor-specific requests to the right integration or agent.

### Agent Computers

Open **Settings → Agent Computers**.

Configure sandbox computers or VMs agents can use for approved automation. Test connectivity before assigning one to an agent.

## Integrations

Configure integrations under **Settings**. Save and test each one before using its agent.

Supported settings surfaces include:

- ACI
- Catalyst Center
- Cisco XDR
- CML
- FMC
- ISE
- Meraki
- Secure Endpoint
- Stealthwatch
- ThousandEyes
- gNMI
- Juniper Mist
- NetBox
- pyATS
- Topolograph
- Grafana
- Prometheus
- Splunk
- Zabbix
- Proxmox
- Sketchfab
- WhatsApp
- Git / CI

Use placeholders in docs and examples. Do not commit real endpoints, tokens, keys, passwords, customer names, or private device output.

## Keyboard shortcuts

On macOS, use Cmd. On Windows and Linux, use Ctrl where the native menu provides it.

| Shortcut | Action |
| --- | --- |
| Cmd+K | Command Palette |
| Cmd+Shift+W | Workflows |
| Cmd+Shift+N | Notebooks |
| Cmd+Shift+U | Subnet Calculator |
| Cmd+Shift+O | Reopen Closed Tab |
| Cmd+Shift+B | New Browser Window |
| Cmd+Shift+I | Diagram Viewer |
| Cmd+Shift+L | Toggle Pane Metadata Card |
| Cmd+Shift+M | Focus Next Pane Needing Attention |
| Cmd+Shift+Enter | Compose Input |
| Cmd+1 / Cmd+2 / Cmd+3 | Raw, Structured, Diff output |
| Cmd+Shift+C | Change Window |
| Cmd+Shift+1 / Cmd+Shift+2 | Pre-check, Post-check |
| Cmd+Shift+F | Fan-Out |
| Cmd+Shift+D | Drift Sidebar |
| Cmd+Shift+G | Guardrail Rule Editor |
| Cmd+Shift+K | Captures Panel |
| Cmd+Shift+E | IaC Studio |
| Cmd+Shift+S | Terraform State |
| Cmd+Shift+V | Vault |
| Cmd+L | Lock Active Vault Envelope |
| Cmd+Shift+R | Start/stop recording |
| Cmd+Shift+T | Troubleshoot |
| Cmd+Alt+T | Troubleshoot Playbook Editor |
| Cmd+Shift+H | Heartbeats |
| F1 | User Guide |
| Cmd+/ | Quick Start and Shortcuts |

## Troubleshooting checklist

### AI is not responding

1. Open **Settings → General**.
2. Confirm provider, model, API key, and base URL.
3. Click **Test Connection**.
4. Check the sidecar status and diagnostic logs.

### A command or tool did not run

1. Read the approval card.
2. Confirm the active tab and device target.
3. Confirm the selected integration is configured and tested.
4. Retry only after you know what failed.

### SSH or device access fails

1. Test the same target from a normal shell.
2. Check hostname, port, username, and auth method.
3. Confirm VPN or network reachability.
4. Re-test the saved connection.

### Blocks are missing

1. Confirm the tab is in Blocks Mode.
2. Run a simple command.
3. Confirm shell integration is active if you expect OSC command boundaries.

### An integration agent fails

1. Open that integration's Settings tab.
2. Re-enter placeholder-safe config or credentials.
3. Run the tab's test action.
4. Check logs before retrying.

## More documentation

- [Configuration](CONFIG.md)
- [Troubleshooting](TROUBLESHOOTING.md)
- [Security](SECURITY.md)
- [Command Blocks](COMMAND_BLOCKS.md)
- [Workflows](WORKFLOWS.md)
- [Notebooks](NOTEBOOKS.md)
- [Structured Output](STRUCTURED_OUTPUT.md)
- [Change Verification](CHANGE_VERIFICATION.md)
- [Fan-Out](FANOUT.md)
- [Drift](DRIFT.md)
- [Guardrails](GUARDRAILS.md)
- [Packet Capture](PACKET_CAPTURE.md)
- [Topology](TOPOLOGY.md)
- [Vault and Recording](VAULT_AND_RECORDING.md)
- [MCP Setup](MCP_SETUP.md)
- [Meraki CLI](MERAKI_CLI.md)

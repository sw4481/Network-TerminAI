# TerminAI

TerminAI is a desktop terminal and network-operations workspace for engineers
who need interactive shells, device access, AI assistance, repeatable checks,
and evidence they can keep with a change record.

It combines xterm.js terminals, SSH/SFTP/serial access, command blocks,
structured network output, an embedded editor, API and NETCONF workspaces,
AI agents, workflows, notebooks, packet capture, topology, IaC, and local
security and audit features in one application.

## Download and install

Download the latest installer from
[GitHub Releases](https://github.com/sw4481/Network-TerminAI/releases/latest).

| Platform | Supported system | Download |
| --- | --- | --- |
| macOS | macOS 15 or newer, Apple Silicon | `.dmg` |
| Windows | Windows 11, x64 | NSIS `-setup.exe` |
| Linux | Ubuntu 22.04 or 24.04, x64 | `.AppImage` or `.deb` |

The installers include the application sidecar. End users do not need Rust,
Bun, or Python to run the packaged product.

### Verify the download

Every release includes `SHA256SUMS.txt`. Verify the checksum before launching
an installer, especially because the zero-cost release artifacts do not carry
paid Apple Developer ID or Windows Authenticode publisher signatures.

### macOS

1. Download the Apple Silicon `.dmg` and `SHA256SUMS.txt`.
2. In Terminal, run `shasum -a 256 TerminAI_*.dmg` and compare the result with
   the matching line in `SHA256SUMS.txt`.
3. Open the DMG and drag **TerminAI** to **Applications**.
4. Launch TerminAI once. macOS may block the first launch because the app is
   not notarized with a paid Developer ID.
5. Open **System Settings → Privacy & Security**, choose **Open Anyway** for
   TerminAI, authenticate, and then select **Open**.

### Windows

1. Download the x64 `-setup.exe` installer and `SHA256SUMS.txt`.
2. In PowerShell, run:

   ```powershell
   Get-FileHash .\TerminAI*-setup.exe -Algorithm SHA256
   ```

   Compare the result with the matching release checksum.
3. Run the installer. If SmartScreen shows **More info → Run anyway**, use
   that override only after verifying the checksum and GitHub source.
4. Complete the NSIS installer prompts.

Smart App Control or an organization policy can block an unsigned installer;
there is no supported bypass for a policy-enforced block.

### Linux

For an AppImage:

```bash
sha256sum TerminAI_*.AppImage
chmod +x TerminAI_*.AppImage
./TerminAI_*.AppImage
```

For Debian/Ubuntu:

```bash
sha256sum TerminAI_*.deb
sudo apt install ./TerminAI_*.deb
```

Compare the printed hash with `SHA256SUMS.txt` before launching or installing.

## First launch

1. Open **Settings → General**.
2. Choose an AI provider and model. TerminAI supports Anthropic, OpenAI,
   Google Gemini, NVIDIA, vLLM-compatible endpoints, and Ollama.
3. Enter the provider credential or local base URL, select **Save
   Configuration**, then select **Test Connection**.
4. Open **SSH → Saved Connections…** to create a reusable device entry, or
   use the terminal like a normal local shell and connect with `ssh`.
5. Press `F1` for the in-app User Guide or `Cmd+/` for Quick Start and
   Shortcuts.

If you are using a local provider, configure its reachable base URL rather
than entering a cloud API key. Keep credentials out of shell history and
shared workflow files; use the Credential Vault for reusable secrets.

## The everyday workflow

### Connect and work in a terminal

Create a terminal tab, connect through a saved SSH profile, or use the local
shell. Use **Terminal Mode** for interactive programs such as `vim`, `top`,
and device shells. Use **Blocks Mode** when you want each command and result
to remain a separate, searchable work unit.

Split a tab horizontally or vertically to compare devices or keep a reference
session visible. Each pane has its own PTY. Sessions, tabs, pane layouts, and
scrollback are restored across launches unless you remove them.

### Review output as evidence

Run a supported `show` command and switch between raw text, structured output,
and diff views. Structured output can be filtered, sorted, copied as Markdown,
or exported as CSV/JSON. Pin or bookmark important blocks, add tags such as
`mop` or `incident`, collapse noisy output, rerun a command, and send a block
to a workflow or notebook.

### Use AI with a review boundary

The AI panel can translate natural language into commands, explain failures,
answer questions using local RAG sources, invoke skills and MCP tools, and
work through troubleshooting playbooks. Commands and tool calls remain subject
to guardrails and approval prompts. Review the target, command, and stated
risk before approving a change.

### Record a change

Use **Audit → Change** for a pre-check/post-check bundle, **Audit → Drift** to
compare device state with intent, or **Audit → Fan-Out** to run a read or
approved operation across a device group. Export the resulting report or
archive as part of the change record.

## Feature guide

The in-app User Guide is the most convenient complete reference. The table
below maps each major capability to its starting point and the task it solves.

| Area | Open it | Use it for |
| --- | --- | --- |
| Terminal and panes | New terminal tab; pane controls | Local shells, device sessions, split-screen operations, tab restore, pane focus, metadata, notifications, and detach/pop-in windows |
| Command blocks | Run commands in Blocks Mode | Collapse, rerun, copy, tag, bookmark, pin, share, search, and convert command results into notebooks or workflows |
| SSH and SFTP | **SSH → Saved Connections…** or **SSH → SFTP…** | Saved device inventory, folders/tags, SSH connections, file transfer, remote folders, rename/delete, and canceled transfers |
| Serial console | **SSH → Serial Console…** | USB serial access with port refresh, baud, data bits, parity, stop bits, flow control, disconnect, and break |
| API workspace | Create an API tab | HTTP requests, saved requests, environments, OpenAPI/Postman import, request history, response explanation, and piping results to the terminal or AI |
| NETCONF workspace | Create a NETCONF tab | Device profiles, YANG/RPC editing, saved RPCs, response history, response explanation, and read/approved device operations |
| Editor | Create an Editor tab | Workspace files, split and detached panes, search/replace, bookmarks, Git status/diff/history, Python debug controls, YAML/HCL support, and Cisco IOS-XE/NX-OS offline diagnostics |
| AI providers | **Settings → General** | Select provider/model, save or test connectivity, choose streaming behavior, and optionally enable the experimental Context Graph |
| Agents | **Settings → Agents** | Manage agent definitions and tool/source configuration; use the Agent panel for typed requests or editable local microphone dictation |
| Skills | **Settings → Skills** | Discover, reload, create, and invoke reusable AI workflows with prompts and helper scripts |
| MCP servers | **Settings → MCP Servers** | Add, import, enable, disable, and remove external Model Context Protocol servers and review tool access |
| Workflows | `Cmd+Shift+W` or **Operate → Tools → Workflows** | Run parameterized multi-step command templates; create, edit, import, export, and pin workflows |
| Notebooks / MOPs | `Cmd+Shift+N` or **Operate → Tools → Notebooks** | Write Markdown runbooks with command, assertion, prompt, and narrative cells; run against a selected device and pause/resume execution |
| Command Palette | `Cmd+K` | Search commands, blocks, devices, workflows, notebooks, skills, and other app actions from one place |
| Change verification | `Cmd+Shift+C` or **Audit → Change** | Capture pre/post command bundles, review diffs, record approvals, and export Markdown reports |
| Fan-out | `Cmd+Shift+F` or **Audit → Fan-Out** | Manage device groups, run a command across multiple SSH targets, inspect per-device status, retry/cancel work, and export results |
| Configuration drift | `Cmd+Shift+D` or **Audit → Drift** | Create Jinja-style intent templates, bind devices, run checks, schedule checks, acknowledge findings, and review history |
| Guardrails | `Cmd+Shift+G` or **Audit → Guardrails** | Review risk classifications, edit rules, approve/deny/second-opinion requests, and inspect the decision log |
| Troubleshooting | `Cmd+Shift+T` or **Audit → Troubleshoot** | Match symptoms to playbooks, execute read-only steps, answer prompts, review evidence, and author YAML playbooks |
| Heartbeats | `Cmd+Shift+H` or **Operate → Heartbeat** | Schedule recurring checks, filter/sort them, pause/resume, run immediately, and inspect execution history |
| Packet capture | `Cmd+Shift+K` or **Operate → Captures** | Start IOS-XE EPC captures from templates or advanced parameters, fetch the PCAP, inspect packets/hex/protocols, scan findings, and export |
| Topology | Create a Topology tab or use inline topology | Ingest CDP, LLDP, BGP, OSPF, and IS-IS neighbors; filter the graph, inspect nodes, discover devices, save neighbors, and open SSH/NETCONF |
| Diagrams | `Cmd+Shift+I` or **Operate → Diagrams** | View agent-produced Mermaid/draw.io-style diagrams and export the rendered diagram |
| Subnet tools | `Cmd+Shift+U` or **Operate → Tools → Subnet Calculator** | CIDR calculation, subnet splitting, VLSM design, supernetting, IP checks, visualization, and quick reference |
| Browser window | `Cmd+Shift+B` or **Operate → Browser** | Open a controlled browser window for a supplied URL and configure browser-control integration in Settings |
| IaC Studio | `Cmd+Shift+E` or **Operate → IaC** | Edit Terraform/Ansible-oriented resources and pipelines, review generated diffs, run approved operations, push to Git, and inspect GitHub Actions/GitLab CI runs |
| Terraform state | `Cmd+Shift+S` or **Operate → IaC → Open Terraform State** | Open a project state directory, search resources, and inspect state without leaving the app |
| Credential Vault | `Cmd+Shift+V` or **Operate → Vault** | Create encrypted envelopes, add/reveal secrets, import 1Password/Bitwarden CSV, lock envelopes, and review the audit log |
| Recording | `Cmd+Shift+R` or **Operate → Recording** | Record a terminal session with redaction, replay it, scrub playback, and export a redacted cast |
| RAG library | **Settings → RAG** | Add PDF/HTML/Markdown/text knowledge, tag it, manage indexing, and inspect retrieved source snippets from AI answers |
| Integrations | **Settings** | Configure FTP/TFTP, Git/CI, pyATS, Proxmox, Stealthwatch, ISE, CML, Catalyst Center, Splunk, ACI, gNMI, FMC, ThousandEyes, Meraki, Secure Endpoint, Cisco XDR, Juniper Mist, Grafana, Zabbix, Prometheus, NetBox, Sketchfab, and WhatsApp |

## Security and data handling

TerminAI keeps application data, sessions, local embeddings, recordings, and
vault data on the local machine. The selected AI provider receives requests
you send to it; configure the provider deliberately and review tool approvals.
Vault secrets are protected by an envelope passphrase and encrypted storage.
Recordings redact recognized credentials while streaming, but you should still
review exported recordings before sharing them.

The app preserves the historical `ccie-terminal` identifiers and data roots
for upgrade compatibility:

| Platform | Configuration | Application data |
| --- | --- | --- |
| macOS | `~/Library/Application Support/ccie-terminal` | same application-support root |
| Windows | `%APPDATA%\\ccie-terminal` | same application-data root |
| Linux | `~/.config/ccie-terminal` | `~/.local/share/ccie-terminal` |

TerminAI checks the signed GitHub updater feed at launch and from **Settings →
Updates**. It downloads an update only after the Tauri signature verifies.

## Configuration and troubleshooting

For provider profiles, environment variables, data locations, and sidecar
behavior, see [Configuration](docs/CONFIG.md). For common launch, sidecar,
provider, SSH, MCP, and session issues, see
[Troubleshooting](docs/TROUBLESHOOTING.md).

Useful first checks:

1. Confirm the provider URL/key in **Settings → General** and use **Test
   Connection**.
2. Check the sidecar status indicator in the footer.
3. Open **Settings → Terminal → Diagnostic logs** to locate application and
   sidecar logs.
4. For an SSH problem, test the same host from a normal shell, then inspect
   the saved connection's hostname, port, username, and authentication mode.
5. For a tool or agent problem, inspect the approval card and the agent/MCP
   source drawer before retrying.

## Documentation

- In-app **User Guide**, **Quick Start**, **Shortcuts**, and **About**: press
  `F1` or `Cmd+/`.
- [Configuration](docs/CONFIG.md)
- [Troubleshooting](docs/TROUBLESHOOTING.md)
- [Security](docs/SECURITY.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Command Blocks](docs/COMMAND_BLOCKS.md)
- [Workflows](docs/WORKFLOWS.md)
- [Notebooks](docs/NOTEBOOKS.md)
- [Structured Output](docs/STRUCTURED_OUTPUT.md)
- [Change Verification](docs/CHANGE_VERIFICATION.md)
- [Fan-Out](docs/FANOUT.md)
- [Drift](docs/DRIFT.md)
- [Guardrails](docs/GUARDRAILS.md)
- [Packet Capture](docs/PACKET_CAPTURE.md)
- [Topology](docs/TOPOLOGY.md)
- [Vault and Recording](docs/VAULT_AND_RECORDING.md)
- [MCP Setup](docs/MCP_SETUP.md)
- [Meraki CLI](docs/MERAKI_CLI.md)
- [API and sidecar protocol](docs/API.md)
- [Contributing](CONTRIBUTING.md)

## Run from source

### Requirements

- Rust 1.97.0, pinned by `rust-toolchain.toml`
- Node 22+
- Bun 1.3.6 or newer
- Python 3.12
- `uv` for the frozen sidecar environment
- Credentials for at least one AI provider if you want AI features

```bash
git clone https://github.com/sw4481/Network-TerminAI.git
cd Network-TerminAI
./setup.sh
bun run tauri dev
```

### Build and test

```bash
bun run build
bun run test
cargo test --manifest-path src-tauri/Cargo.toml --locked
cd sidecar && uv run --frozen --extra dev pytest -v
```

To build a release bundle:

```bash
cd sidecar && ./scripts/build_sidecar.sh && cd ..
bun tauri build -- --locked
```

Build artifacts are written under `src-tauri/target/release/bundle/`.

## Project status

The current release is **TerminAI 1.1.0**. The repository is under active
development; the in-app guide and linked feature documents describe the
behavior shipped by the current checkout. Integrations may require their own
service credentials, reachable endpoints, or platform-specific permissions.

## Using with Claude Code

This repository includes [`CLAUDE.md`](CLAUDE.md) with the project commands,
architecture, key files, and configuration notes. Run Claude Code from the
repository root so it can use that context.

```bash
claude
```

Do not provide credentials, tokens, private device output, or customer data in
prompts.

## License

TerminAI is released under the MIT License. See [`LICENSE`](LICENSE).

## Contributing

Bug reports, feature requests, and pull requests are welcome. Start with
[CONTRIBUTING.md](CONTRIBUTING.md), include reproducible steps, and avoid
including credentials, tokens, private device output, or customer data.

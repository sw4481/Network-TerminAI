export const USER_GUIDE_MD = String.raw`# TerminAI User Guide

TerminAI is a local desktop workspace for network operations. It combines
interactive terminals, device connections, structured output, AI assistance,
repeatable checks, an editor, and evidence-oriented exports.

> **Start here:** press Cmd+K to find an action, F1 to return to this
> guide, or Cmd+/ for the five-minute Quick Start. Search this help window
> for any device, feature, menu, or shortcut name.

The exact data available to a feature depends on the connected device, provider
credentials, endpoint permissions, and installed integration. When a feature
can change infrastructure, TerminAI shows an approval or guardrail step before
the operation is sent.

## 1. Start, configure, and understand the workspace

### First launch

1. Open **Settings → General**.
2. Select an AI provider and model.
3. Enter the provider API key or local base URL, then choose **Save
   Configuration**.
4. Choose **Test Connection** before using AI features.
5. Create a saved device under **Operate → SSH → Saved Connections…**, or use
   the terminal as a normal local shell.

Supported AI provider choices are Anthropic, OpenAI, Google Gemini, NVIDIA,
vLLM-compatible endpoints, and Ollama. Cloud providers use their normal
service endpoint; vLLM and Ollama use the base URL configured in Settings.

The footer reports sidecar and application health. The Python sidecar supports
parsing, AI clients, structured results, and related helpers. It starts when a
feature needs it and remains available while the app is open. If it is not
healthy, open **Settings → Terminal → Diagnostic logs** before restarting.

### Tabs and session restore

The workspace can contain terminal, API, NETCONF, editor, IaC Studio,
topology, vault, recordings, troubleshooting, subnet, recording-player, and
heartbeat tabs. The active tab is shown in the tab bar; close a tab from its
tab action and use **View → Reopen Closed Tab** or **View → Recently Closed…**
to recover a recently closed terminal tab.

TerminAI saves tabs, pane layouts, and terminal scrollback locally. Restored
tabs may still require reconnecting to a remote device. A saved SSH profile is
an inventory entry; it is not proof that a live PTY is currently connected.

## 2. Terminal modes, panes, and command blocks

### Terminal Mode and Blocks Mode

Use **Terminal Mode** for interactive programs, full-screen commands, shells,
SSH sessions, vim, and top. Use **Blocks Mode** when each command/result
pair should remain a separate unit that can be searched, copied, tagged, and
reviewed later. Switch modes from the terminal mode control.

Each terminal pane owns an independent PTY. Split right or split down from the
pane controls, drag the divider to resize, and focus a pane before running a
command. The pane metadata card shows connection and activity information;
toggle it with Cmd+Shift+L. When a pane needs attention, the activity
indicator and notification center identify it.

Use **Pane → Compose Input…** or Cmd+Shift+Enter for multi-line input. This
is useful for a pasted configuration block or a command that should be
reviewed before submission.

### Command blocks

In Blocks Mode, a command and its output appear in a block. A block can be:

- collapsed to reduce noise;
- rerun from its action menu;
- copied without terminal control sequences;
- bookmarked or pinned for later reference;
- tagged and filtered with the tag bar;
- shared through the local ccie-terminal:// block link;
- sent to a workflow or used to create a runnable notebook/MOP.

Blocks retain command, output, exit status, duration, timestamp, and working
directory metadata. Use the search bar to find commands, AI conversations,
and skills. The block notebook stores a selected set of blocks as a reusable
working record.

Shell integration improves block boundaries. The bundled shell snippets use
OSC 133 markers so the app can distinguish prompts, commands, output, and
completion. If blocks are not forming correctly, open the repository
Troubleshooting guide from the README.

## 3. SSH, SFTP, serial, FTP, and TFTP

### Saved SSH connections

Open **Operate → SSH → Saved Connections…** to create or edit a device entry.
Store a display name, host, port, username, authentication details, tags, and
folders. Search the inventory by name or tag and select a connection to open a
terminal tab. Use the inventory import option when you already have a supported
SSH inventory file.

Saved inventory and live connection state are different. If a device does not
appear as a live target for a feature, connect it first and wait for its PTY to
be ready.

### SFTP

Open **Operate → SSH → SFTP…**, select a saved SSH connection, and connect.
The two-pane browser supports remote path navigation, refresh, upload,
download, creating folders, renaming, deleting, and canceling transfers.
Confirm the selected path before destructive file operations.

### Serial console

Open **Operate → SSH → Serial Console…**. Refresh the available USB ports,
choose a port, then set baud rate, data bits, parity, stop bits, and flow
control before connecting. Disconnect before changing serial parameters. Use
**Send Break** only when the target device and your procedure call for it.

### FTP and TFTP servers

Configure the embedded servers under **Settings → FTP Server** and **Settings
→ TFTP Server**. Start or stop the service, review the bind address and
directory, and check the status indicator. TFTP on a privileged port may
require the platform authorization prompt. Treat the served directory as
shared network state and avoid placing credentials there.

## 4. API and NETCONF workspaces

### API requests

Create an API tab from the tab/new-workspace controls. Build a request with its
method, URL, headers, query values, body, and selected environment. Save a
request for reuse, inspect response headers/body/status, and open request
history for previous runs.

Import an OpenAPI description or a Postman collection when you want to start
from an existing catalog. Create environments and variables instead of
copying secrets into each request. A response can be sent to the terminal or
provided to the AI explanation flow. Review the destination and method before
sending a write request.

### NETCONF sessions

Create a NETCONF tab, choose or create a device profile, and connect. Use the
YANG browser and RPC editor to build a request, then send it and inspect the
response. Save frequently used RPCs, review request history, and use response
explanation when you need help interpreting modeled data.

For operational state, use the device's modeled get path; for configuration,
use get-config or a modeled edit operation as appropriate. The app does not
turn every CLI command into a NETCONF RPC automatically. Confirm the device,
datastore, namespace, and operation before sending a change.

## 5. Editor and code workspaces

### Files and editing

Create an Editor tab and choose a workspace folder. The Explorer creates files
and folders and opens files in buffer tabs. Use split-right or split-down to
compare files, detach a pane into a separate window, or bring it back into the
main workspace. Unsaved buffers show a dirty marker; save before closing or
switching repositories.

Find and Replace searches the active file. Workspace Search searches matching
files using a query and file pattern. Editor Settings control font size, tab
size, word wrap, and related editing preferences. The global **Settings →
Editor** tab selects the editor style, theme, Vim mode, and column selection.

The editor's command palette and context menu provide multi-cursor editing,
line operations, indentation and case transforms, folding, and bookmarks. Use
**Toggle Bookmark** and **Next Bookmark** to move through a file.

### Cisco editor mode and diagnostics

The Editor tab can enable the offline Cisco profile for **IOS-XE** or **NX-OS**.
The validator is local and read-only: it reports syntax/profile findings in
the editor and Problems panel, but it does not connect to a device or apply a
configuration. Click a Problems row to jump to the relevant line. Guardrails
classify command risk; they are not a complete Cisco syntax validator.

### Git and Python debugging

Open the Git panel for the active workspace repository. Rescan repositories,
switch branches, inspect remotes, clone a repository, review staged and
unstaged diffs, commit with a message, and search repository history. Review
the diff before committing or pushing.

Python projects can expose debug controls in the editor: toggle breakpoints,
start/pause, step over, step into, step out, restart, stop, and show or hide
the debug panel. Debug behavior depends on the project and available Python
debug configuration.

## 6. AI agents, skills, MCP, search, and the Context Graph

### Agent panel

The Agent panel accepts natural-language requests. It can translate a request
into a command, explain a failure, call configured tools, retrieve local RAG
sources, and continue a multi-step investigation. The Sources drawer shows
which local documents informed a grounded answer. A tool approval card shows
the tool, target, and parameters before an enabled consequential action runs.

Use the agent activity indicator to see whether a request is working, waiting,
or needs attention. A successful HTTP response or a generated sentence is not
itself proof that a device change completed; verify the actual device result.

#### Voice dictation

Click the microphone in the Agent panel to start recording. Speak normally,
then click the microphone again to stop and insert the local Whisper transcript.
Review or edit the transcript and press Enter or click **Send** when it is ready.

Voice dictation does not send automatically, and text already in the composer
is preserved. The first use may trigger a microphone permission prompt. If
speech input is unsupported or permission is denied, continue using the normal
typed composer. TerminAI includes a local Whisper model; advanced users can set
TERMINAI_WHISPER_MODEL to test another ggml model file.

### Skills

Open **Settings → Skills** to list installed skills, reload them, or create a
new one. A skill packages reusable instructions and optional helper scripts.
Use a precise description and document the required inputs, tools, and safe
operating boundary. Invoke it from the Agent panel or Command Palette when
its trigger matches your task.

### MCP servers

Open **Settings → MCP Servers** to add a server manually or import its
configuration. Review the command/URL, arguments, environment requirements,
enabled state, and exposed tools. Disable a server when it is not needed.
MCP tool approval is separate from ordinary local shell execution; review the
server and action before allowing a write-capable tool.

### Full-text search and Command Palette

The search bar searches command history, AI conversations, and skills. The
Command Palette (Cmd+K) searches commands, blocks, saved devices,
workflows, notebooks, and application actions. Type a few distinctive words,
use the scope controls when available, move with the arrow keys, and press
Enter to act. Press Escape to close without changing the workspace.

### Context Graph

The experimental Context Graph is configured under **Settings → General** and
is off by default. When enabled, an agent can query related topology, drift,
knowledge-base, and persistent fact/decision context. Set the memory freshness
window so older facts are treated as stale. Disable it to restore the prior
agent context behavior immediately.

## 7. Workflows and notebooks

### Workflows

Open **Operate → Tools → Workflows** or press Cmd+Shift+W. Choose a
workflow, fill its parameters, and run it in the active terminal. A workflow
can contain multiple commands and AI-assisted steps; output appears as normal
blocks so it can be reviewed and reused.

Use the workflow editor to set a name, description, vendor/platform scope,
tags, parameters, defaults, and command steps. Import and export YAML to share
templates. Pin commonly used workflows in the global command bar. Treat an
imported workflow as untrusted until you review every command and parameter.

### Runnable notebooks / MOPs

Open **Operate → Tools → Notebooks** or press Cmd+Shift+N. Create or import
a Markdown MOP, select its target device, enter parameters, and run cells in
order. Supported cell types include narrative text, command cells, assertions,
and operator prompts. A command cell runs through the selected terminal and
captures its result; assertions compare structured values to expected values.

Pause or resume a run from the notebook toolbar. Use **Create MOP from
blocks** when you already have a useful command sequence in the terminal.
Open the target SSH/terminal session before running device-bound cells.

## 8. Output, change verification, fan-out, drift, and guardrails

### Structured output

Run a supported show command, then choose **View → Show Raw Output**
(Cmd+1), **Show Structured** (Cmd+2), or **Show Diff** (Cmd+3).
Structured tables can be sorted and filtered. Compare a later snapshot with a
previous one to highlight added, removed, or changed rows. Use the in-block
export/copy controls for CSV, JSON, or Markdown.

Parsing depends on the available Genie/TextFSM coverage and the command's
vendor/platform output. If parsing is unavailable, the raw output remains the
source of truth.

### Pre/post change verification

1. Open **Audit → Change** or press Cmd+Shift+C.
2. Select an existing command bundle, or use **New Bundle…** to define the
   pre/post commands and metadata.
3. Run **Pre-Check** (Cmd+Shift+1) and review the captured results.
4. Make the planned change, subject to guardrail approval.
5. Run **Post-Check** (Cmd+Shift+2) and inspect the diff report.
6. Export the report as Markdown and attach it to the change record.

Use **Manage Bundles…** to edit or remove bundles. A pre/post report documents
what was observed; it does not replace a device-side commit or rollback plan.

### Multi-device fan-out

Open **Audit → Fan-Out** or press Cmd+Shift+F. Manage device groups first,
including CSV import where supported. Select a group and command, review the
target count, and start the run. The panel shows per-device progress, output,
exit state, and failures. Cancel the run or retry an individual straggler when
available, then export the result archive.

Fan-out is intentionally bounded for safety. Confirm group membership and
command scope before starting; a read-only command is the safer first test.

### Configuration drift

Open **Audit → Drift** or press Cmd+Shift+D, then use **Manage Intent
Templates…**. Create an intent with the expected template and variables,
associate it with a device, and run an on-demand or scheduled check. The Drift
Sidebar groups added, removed, and changed lines with surrounding context.

Pause or resume schedules, acknowledge findings, and open historical reports
to distinguish a reviewed exception from an unresolved drift. The expected
configuration is an intent; the check does not silently remediate the device.

### Guardrails and decision log

Guardrails classify typed and AI-generated commands by risk. Read-only work is
normally allowed; higher-risk commands display the classification, matched
rule, target context, and blast-radius summary before execution. Choose
**Approve**, **Deny**, or **Second Opinion** when offered.

Open **Audit → Guardrails → Rule Editor…** or press Cmd+Shift+G to inspect
and edit rules. Use its regex test with representative commands, and export or
import a ruleset when sharing policy. Open **Decision Log…** to review prior
approvals and denials. A guardrail warning is advisory about command risk; it
does not prove that the command is syntactically valid or that a device
accepted it.

## 9. Troubleshooting and heartbeat monitoring

### AI troubleshooting playbooks

Open **Audit → Troubleshoot** or press Cmd+Shift+T. Describe a symptom,
choose a matching playbook, provide optional variables, and select **Start**.
The executor walks the playbook, runs read-only steps, displays evidence and
narration, and pauses for operator prompts. Tier-1 and higher operations still
require explicit approval.

Open **Playbook Editor…** with Cmd+Alt+T to create or edit YAML playbooks.
Use **Browse Builtin Playbooks** to inspect the starting examples. Validate
the vendor/platform scope, symptom keywords, step IDs, branch cases, command
steps, assertions, and expected values before saving.

### Heartbeats

Open **Operate → Heartbeat → Heartbeats…** or press Cmd+Shift+H. Create a
heartbeat with its name, interval, target, and check instructions. Filter by
enabled/disabled state and sort by name, next run, or last run. Expand a card
to inspect executions, run it immediately, pause/resume it, or delete it.
Deleting a heartbeat also removes its execution history, so confirm that
action carefully.

## 10. Packet capture, topology, diagrams, subnetting, and browser

### Packet capture

Open **Operate → Captures** or press Cmd+Shift+K. Use a quick-capture
template or the advanced form to select the interface, ACL/filter expression,
buffer, and duration. Start the IOS-XE Embedded Packet Capture, wait for the
capture to finish, fetch the PCAP, and inspect it in the viewer.

The viewer provides packet rows, protocol hierarchy, hex data, and stream
inspection where available. Findings can scan built-in rules and show evidence
packets. Export the PCAP and review the destination path before sharing it.

### Topology

Create a Topology tab or use the inline topology panel attached to recognized
neighbor output. Run supported CDP, LLDP, BGP, OSPF, or IS-IS commands and
ingest the result. The graph can be filtered by vendor, platform, protocol,
and site data where present.

Select a node to inspect management reference, platform, neighbors, and
available actions. Save a neighbor when it should become a reusable device
entry, discover a device from the topology flow, or open SSH/NETCONF from the
inspector. Saving can warn before replacing an existing edge. Topology is an
observation and inventory aid; it does not automatically change a device.

### Diagrams

Open **Operate → Diagrams** or press Cmd+Shift+I to view an agent-produced
diagram. Review the source before trusting the visual interpretation, then
use the viewer's export action when you need an image or document artifact.

### Subnet calculator

Open **Operate → Tools → Subnet Calculator** or press Cmd+Shift+U. Choose
one of the six tools:

- **CIDR** calculates network, broadcast, host range, and related values.
- **Split** divides a network into smaller subnets.
- **VLSM** designs variable-length subnets from requirements.
- **Super** combines compatible networks into a supernet.
- **Check** validates an IP, mask, CIDR, or membership relationship.
- **Visual** displays the address/subnet relationship graphically.

Use **Quick Reference** for the common mask and host-count reference while
working.

### Browser window

Open **Operate → Browser → New Browser Window…** or press Cmd+Shift+B,
enter a URL, and review the opened page. Browser-control integration can be
configured under **Settings → Browser**. Treat imported cookies and authenticated
browser sessions as sensitive; use the browser only with sites and accounts
you intend to expose to the configured workflow.

## 11. IaC Studio, Terraform state, and Git/CI

### IaC Studio

Open **Operate → IaC → Open IaC Studio** or press Cmd+Shift+E. Select a
project/workspace and open files in the editor. Use **New Resource…** to
describe a Terraform or Ansible resource, review the generated diff, and
accept or reject it. Use **New Pipeline…** to choose a CI platform, tool,
flow, and optional auth/environment details.

**Get Started with Pipelines…** walks through repository, operation, runner,
target, and connection choices before generating a pipeline proposal. Review
the generated files and diff before writing them. IaC operations display an
approval modal with resource and risk information; approve only the exact
operation you intend.

Use the Git controls to initialize or select a repository, commit selected
paths, configure a remote, and push. The GitHub/GitLab run panels show CI
status when the repository and credentials are configured.

### Terraform state

Open **Operate → IaC → Open Terraform State** or press Cmd+Shift+S. Choose
the project directory, search resources, and inspect state entries. State can
contain sensitive values; do not paste it into public issues or untrusted AI
prompts.

## 12. Credential Vault and session recordings

### Credential Vault

Open **Operate → Vault** or press Cmd+Shift+V. Create an envelope with a
strong passphrase, unlock it, and add named secrets with usernames, passwords,
notes, or an identity-file path. Reveal only what you need and lock the active
envelope with Cmd+L; **Lock All Envelopes** closes every unlocked envelope.

Use **Import from 1Password/Bitwarden CSV…** only with an export you trust,
then verify the imported records and remove the temporary export. The audit
log records vault actions such as reveal and rotation. Auto-lock and idle
timeout behavior can require the passphrase again.

### Session recording

Press Cmd+Shift+R to start or stop recording the active terminal tab. Recordings
use the asciinema v2 cast format. Open
**Operate → Recording → Open Recordings** to list casts and open the player.
The player supports replay controls and scrubbing; export a redacted cast only
after reviewing it for device output and customer data.

Recording redaction operates while the stream is written, but no automatic
redactor catches every possible secret. Do not treat an exported recording as
safe until you review it.

## 13. RAG library and integrations

### RAG library

Open **Settings → RAG**. Add PDF, HTML, Markdown, or text documents, give them
useful titles and vendor/platform tags, and wait for indexing to finish. The
local embedding/index store powers source retrieval for AI responses. Delete
outdated documents or adjust retrieval settings when answers cite the wrong
material. Select a Sources badge in an agent response to inspect the retrieved
snippet.

### Settings overview

The Settings window includes these areas:

- **General** — AI provider/model, API key or base URL, connection test,
  streaming preference, and experimental Context Graph.
- **Appearance** — application theme and visual preferences.
- **Editor** — editor style, theme, Vim mode, and column selection.
- **MCP Servers** — external tool server configuration.
- **Skills** — reusable AI workflow management.
- **Agents** — agent definitions and sources/tools.
- **RAG** — local document ingestion and retrieval.
- **FTP Server / TFTP Server** — embedded file-service configuration.
- **Git / CI** — repository and CI integration settings.
- **Updates** — signed updater status and update checks.
- **pyATS, Proxmox, Stealthwatch, ISE, CML, Catalyst Center, Splunk, ACI,
  gNMI, FMC, ThousandEyes, Meraki, Secure Endpoint, Cisco XDR, Juniper Mist,
  Grafana, Zabbix, Prometheus, NetBox, Sketchfab, and WhatsApp** — endpoint,
  authentication, TLS, and integration-specific settings.
- **Terminal** — terminal appearance, command suggestions, notifications,
  and diagnostic log locations.
- **Browser** — browser-control setup and compatible client instructions.

Save and test each integration before using its agent or workspace. Credentials
are not interchangeable between integrations; configure the provider expected
by the specific agent.

## 14. Keyboard and help

On macOS, Cmd is the modifier shown below. On Windows/Linux, use the
equivalent Ctrl shortcut where the native menu provides it.

| Shortcut | Action |
| --- | --- |
| Cmd+K | Command Palette |
| Cmd+Shift+W | Workflows |
| Cmd+Shift+N | Notebooks |
| Cmd+Shift+U | Subnet Calculator |
| Cmd+Shift+B | New Browser Window |
| Cmd+Shift+I | Diagram Viewer |
| Cmd+Shift+L | Toggle Pane Metadata Card |
| Cmd+Shift+M | Focus Next Pane Needing Attention |
| Cmd+Shift+Enter | Compose Input |
| Cmd+1, Cmd+2, Cmd+3 | Raw, Structured, Diff output |
| Cmd+Shift+O | Reopen Closed Tab |
| Cmd+Shift+C | Change Window |
| Cmd+Shift+1, Cmd+Shift+2 | Pre-Check, Post-Check |
| Cmd+Shift+F | Fan-Out |
| Cmd+Shift+D | Drift Sidebar |
| Cmd+Shift+G | Guardrail Rule Editor |
| Cmd+Shift+K | Captures Panel |
| Cmd+Shift+E | IaC Studio |
| Cmd+Shift+S | Terraform State |
| Cmd+Shift+V | Vault |
| Cmd+L | Lock Active Vault Envelope |
| Cmd+Shift+R | Start/Stop Recording |
| Cmd+Shift+T | Troubleshoot |
| Cmd+Alt+T | Troubleshoot Playbook Editor |
| Cmd+Shift+H | Heartbeats |
| F1 | User Guide |
| Cmd+/ | Quick Start and Shortcuts |

Use the **Help** menu for the same help surfaces when a shortcut is unavailable
or conflicts with a platform/browser key binding. The editor's context menu
contains additional Monaco/Zed commands, including bookmarks, multi-cursor,
folding, and Vim-mode actions.

## 15. Troubleshooting checklist

### AI is not responding

Check the provider, model, API key/base URL, and **Test Connection** result in
Settings. For a local endpoint, verify that the host is reachable from the
machine running TerminAI. Check the sidecar status and diagnostic logs.

### A command or tool did not run

Read the approval card and risk classification. Confirm the active tab, live
connection, device identity, and selected environment. For MCP, confirm the
server is enabled and its tool is available. For agents, inspect the Sources
drawer and activity detail.

### Structured output is empty

Use Raw output first. Confirm that the command is supported for the device
vendor/platform and that the response is complete. Parser coverage varies;
raw output is retained when no structured parser matches.

### SSH/SFTP/serial problems

Check host, port, username, authentication, and local network reachability.
For SFTP, connect from a saved SSH entry. For serial, refresh ports and verify
line settings before connecting. For TFTP, review bind permissions and the
served directory.

### Help or shortcuts look wrong

Use the native **Help** menu to confirm the current accelerator. The menu is
the authoritative platform-specific shortcut source; editor keybindings can
also change when Vim or Zed mode is enabled.

For deeper recovery steps, see the repository Troubleshooting guide, Security
guide, and the per-feature documents listed in the README.
`;

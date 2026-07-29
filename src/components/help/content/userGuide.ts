// User Guide content — full reference for every feature shipped across Plans 00–15.
// Authored as a markdown string so react-markdown can render it directly.
//
// Sections deliberately read top-to-bottom: a brand-new operator can scan once
// to learn the whole app, while a returning user can jump via the in-modal
// search box.

export const USER_GUIDE_MD = String.raw`# TerminAI — User Guide

TerminAI is a Warp-inspired, AI-augmented terminal built specifically for
network engineers. It runs locally as a desktop app (Tauri + React + Rust), with
a Python sidecar for parsing and AI features. Every feature documented below is
shipped and exercised by the regression test suite.

> **Tip:** Press \`Cmd+/\` for the Quick Start, \`F1\` for this guide, and use
> the search box at the top of this modal to jump to any section.

---

## 1. Foundation & Sidecar (Plan 00)

**What it does** — Boots the long-running Python sidecar that hosts Genie /
TextFSM parsers, AI clients, and structured-output helpers. The sidecar is
launched on first feature use and kept alive via a heartbeat thread.

**How to open it** — Nothing to open: it just runs. The status footer at the
bottom-right shows a green dot when the sidecar is healthy.

**Typical workflow**
- Run any \`show\` command in a terminal tab — the sidecar parses the output
  in the background.
- Watch the footer chip flip green within a few seconds of boot.
- If the chip stays red, restart the app (rebuilding from a stale
  \`target/debug/python/\` is the most common cause).

**Tips**
- Parser cache lives in the SQLite app DB; clearing the DB resets it.
- Sidecar logs land in your platform log directory — search for
  \`ccie_sidecar.log\`.

---

## 2. Command Blocks (Plan 01)

**What it does** — Every prompt-to-output pair becomes a *block* — a discrete,
collapsible card with its own actions: copy, share via \`ccie-terminal://\`
deep link, pin, tag, and bookmark.

**How to open it** — Blocks render inline as you run commands. Click the
header to collapse, the **⋯** menu for actions, and the tag chips to filter.

**Typical workflow**
- Run a command — a new block appears.
- Click the **pin** icon to keep the block visible while you scroll.
- Click **share** to mint a \`ccie-terminal://block/<id>\` URL — clicking
  the URL anywhere on the same machine reopens the block.
- Tag blocks with \`#mop\`, \`#troubleshoot\`, etc., then filter via the tag
  chip strip at the top of the tab.

**Tips**
- The Block toolbar exposes Re-Run and Send-to-Workflow.
- Collapsed state is persisted per-block; closing the tab does not lose it.

---

## 3. Workflows (Plan 02)

**What it does** — Parameterised, multi-step command templates. Workflows are
authored in YAML and seeded on first run; you can also add your own from the
**Tools → Workflows** menu.

**How to open it** — \`Cmd+Shift+W\` or **Tools → Workflows**.

**Typical workflow**
- Open the workflow picker.
- Pick a workflow (e.g. *Interface Health Check*).
- Fill the parameter form (interface name, VRF, timeout, etc.).
- The workflow runs in the active tab as a sequence of blocks.

**Tips**
- Workflows can call the AI agent for natural-language steps.
- Use **Export / Import** in the WorkflowPicker to share \`.yaml\` files.

---

## 4. Notebooks / Runnable MOPs (Plan 03)

**What it does** — Markdown notebooks where code fences become *runnable
cells*. Use them as living MOPs (Method of Procedure) — narrative, command
cells, expected output, and verification all in one document.

**How to open it** — \`Cmd+Shift+N\` or **Tools → Notebooks**.

**Typical workflow**
- Open the notebook library, click **New** or **Import**.
- Author markdown with \`\`\`cisco\`\`\` or \`\`\`bash\`\`\` fenced cells.
- Open the notebook in a panel and click **Run** on each cell — the active
  terminal tab executes the command, and a result block is captured back into
  the notebook.
- Pause / Resume the run from the notebook header.

**Tips**
- Notebooks are tied to a tab via PTY wiring; open a target SSH session first.
- Use **Create-MOP from blocks** in the BlockToolbar to seed a notebook from
  a series of blocks you already ran.

---

## 5. Command Palette (Plan 04)

**What it does** — Single-keystroke fuzzy search across history, blocks,
saved devices, workflows, notebooks, and more.

**How to open it** — \`Cmd+K\` or **Tools → Command Palette**.

**Typical workflow**
- Press \`Cmd+K\`.
- Start typing — results group by category (Commands / Blocks / Devices).
- Use \`Tab\` to scope to a single category; \`Enter\` to action.

**Tips**
- The palette tracks usage so frequently picked items rise to the top
  (boot-time trim caps usage at 5000 rows per type).
- Scope filters: \`>device\` only searches saved hosts, \`@cmd\` filters to
  command history.

---

## 6. Structured Show-Output (Plan 05)

**What it does** — Parses \`show\` command output via Genie / TextFSM into
structured tables. Each block can be viewed as raw, structured, or diff.

**How to open it** — Run any supported \`show\` command, then use the
**View** menu or shortcuts: \`Cmd+1\` (Raw) / \`Cmd+2\` (Structured) / \`Cmd+3\`
(Diff).

**Typical workflow**
- Run \`show interfaces\`.
- Switch to **Structured** view — sortable, filterable table appears.
- Pin a snapshot with \`Cmd+Shift+P\`.
- Re-run later, switch to **Diff** view — added / removed / changed rows
  highlight automatically.
- Export via **View → Export Structured as CSV / JSON** or copy as
  Markdown table.

**Tips**
- The structured view stores snapshots in a public API (\`diff_snapshots\`)
  consumed by Plans 06 and 08.
- Cell-level severity chips highlight admin-down interfaces, errors, etc.

---

## 7. Pre/Post Change Verification (Plan 06)

**What it does** — Capture a *pre* snapshot of a curated command bundle,
make your change, capture a *post* snapshot, and generate a side-by-side
diff report.

**How to open it** — \`Cmd+Shift+C\` (Open Change Window) or **Change** menu.

**Typical workflow**
- Open the Change Window, pick (or create) a bundle of commands.
- Click **Run Pre-Check** (\`Cmd+Shift+1\`).
- Make your change in the terminal.
- Click **Run Post-Check** (\`Cmd+Shift+2\`) — the diff report opens.
- Click **Export Report as Markdown** to save the change record.

**Tips**
- Built-in bundles cover most common change classes (interface, BGP, ACL).
- Approvals can be appended to a report for audit purposes.

---

## 8. Multi-Device Fan-Out (Plan 07)

**What it does** — Run the same command across up to 50 devices concurrently
over SSH (russh). Per-device output, progress, and exit status surface in a
single panel; ZIP export bundles everything.

**How to open it** — \`Cmd+Shift+F\` or **Fan-Out → Open Fan-Out Panel**.

**Typical workflow**
- Manage device groups via **Fan-Out → Manage Device Groups…** (CSV import
  supported).
- Open the Fan-Out Panel, pick a group + command.
- Watch progress per device; cancel or retry stragglers individually.
- Export the run as a ZIP.

**Tips**
- The 50-device cap is a safety rail; raise it only if your jump-host can
  cope.
- Failed runs leave a \`failed\` row in fanout history; the boot routine
  cleans up *interrupted* runs from a prior crash.

---

## 9. Config Drift (Plan 08)

**What it does** — Define an *intent* (Jinja2 template + variables) and
detect when device config drifts from intent.

**How to open it** — \`Cmd+Shift+D\` (Drift Sidebar) or **Drift → Manage
Intent Templates…**.

**Typical workflow**
- Author an intent (e.g. *standard core router*).
- Bind it to a device via the selector.
- Run **Drift → On-demand check** or schedule one.
- The Drift Sidebar shows a delta — added, removed, changed lines, with
  context.

**Tips**
- Schedules use \`tokio-cron-scheduler\`; pause / resume per-intent.
- Reports are stored per-device — historical drift is queryable.

---

## 10. AI Guardrails / Blast-Radius (Plan 09)

**What it does** — Every command the AI produces (or you type) is classified
into Tier 0–3:
- **Tier 0**: read-only (safe).
- **Tier 1**: low risk (single config touch).
- **Tier 2**: medium risk (multiple touches / interface admin state).
- **Tier 3**: catastrophic (\`reload\`, \`erase\`, route-map deletes).

Tier 1+ surfaces a confirmation modal with rule context, blast-radius summary,
and a *second-opinion* button (re-asks the AI).

**How to open it** — \`Cmd+Shift+G\` (Rule Editor) or **Guardrails → Decision
Log**.

**Typical workflow**
- Enter or accept a command.
- If Tier 1+, the modal explains why and asks for confirmation.
- Approve / cancel / second-opinion. Every decision is logged.
- Edit rules via \`Cmd+Shift+G\` (regex live-test included).

**Tips**
- 278 builtin rules cover Cisco IOS-XE, NX-OS, and IOS-XR primitives.
- Export / import your custom ruleset to share across teams.

---

## 11. Session Chains / Jump-Host Chains (Plan 10)

**What it does** — Multi-hop SSH chains. Define an A → B → C path once and
re-run it on demand; the active tab connects through the chain.

**How to open it** — \`Cmd+Shift+J\` (Manage Chains) or \`Cmd+Alt+J\`
(connect active tab via chain).

**Typical workflow**
- **Chains → New Chain…** — define hops (host, user, auth method).
- Save and validate (per-hop probe).
- On any tab, \`Cmd+Alt+J\` to pick a chain — the tab reconnects through it.
- **Chains → Reconnect Active Chain** to re-run the last chain.

**Tips**
- 4 builtin templates cover common bastion topologies; clone and edit.
- Live PTY/NETCONF dispatch is wired; live execution is stubbed where
  upstream credentials aren't available.

---

## 12. Packet Capture (Plan 11)

**What it does** — Drive an IOS-XE Embedded Packet Capture (\`monitor capture\`),
fetch the resulting \`.pcap\`, and view it inline (packet list, hex, protocol
hierarchy, follow-stream).

**How to open it** — \`Cmd+Shift+K\` (Captures Panel).

**Typical workflow**
- Open the Captures Panel.
- Pick a quick-capture template (or author one) — interface, ACL match,
  buffer size, duration.
- Start the capture; the panel polls until done, downloads via
  \`russh-sftp\`, and opens an inline viewer.
- Export the \`.pcap\` to disk.

**Tips**
- Capture cleanup runs on failure (no orphaned device-side files).
- The PcapPanel can be docked or opened as an overlay.

---

## 13. RAG / AI Completion (Plan 12)

**What it does** — Vendor-aware grounding for the AI agent. Local docs
(uploaded markdown, PDFs, Cisco config guides) are embedded with a local
ONNX MiniLM model (384-dim) and stored in \`sqlite-vec\`. Agent responses
include a **Sources** badge with citations.

**How to open it** — Settings → **RAG** tab; click the **Sources** badge in
any AgentPanel response to open the drawer.

**Typical workflow**
- Settings → RAG → upload docs (or run the optional seed pack).
- Tag docs by vendor / platform.
- Ask the agent a question — the response cites which docs it pulled from.
- Click the badge to inspect the snippet that was retrieved.

**Tips**
- All embeddings happen locally — nothing leaves your machine.
- Adjust top-K and similarity threshold in the RAG settings tab.

---

## 14. Topology Awareness (Plan 13)

**What it does** — Ingest CDP / LLDP / BGP / OSPF / IS-IS neighbor output
from any tab and render the device graph using \`@xyflow/react\` (React Flow
v12). Click a node to SSH into it (resolved via the device registry).

**How to open it** — Open a topology tab from the tab strip, or use the
**Inline Topology Panel** that appears under matching show-blocks.

**Typical workflow**
- Run \`show cdp neighbors detail\` (or LLDP, BGP, OSPF, IS-IS).
- The inline topology panel parses neighbors and offers to save them.
- Open the global Topology tab to see the merged graph.
- Click a node — if the device exists in the registry, a new SSH tab opens.
- Auto-refresh runs on a configurable interval (persisted).

**Tips**
- Save Neighbor Modal warns before overwriting an existing edge.
- Edge color legend distinguishes layer-2 vs. routing protocols.

---

## 15. Credential Vault + Session Recording (Plan 14)

**Credential Vault**

**What it does** — Argon2id-hashed master password unlocks per-envelope
AES-256-GCM secrets. Idle-lock sweep relocks envelopes 30 s after the
configured timeout; CSV import covers 1Password and Bitwarden exports.

**How to open it** — \`Cmd+Shift+V\` or **Vault → Open Vault Tab**.

**Typical workflow**
- Create an envelope (master password).
- Add secrets — username, password, notes, optional \`identity_file\` path.
- Lock the active envelope: \`Cmd+L\`. Lock all: **Vault → Lock All Envelopes**.
- Import: **Vault → Import from 1Password / Bitwarden CSV…**.
- Audit log: **Vault → Audit Log…** — every reveal/rotation is timestamped.

**Tips**
- Idle timeout is per-envelope; set it short for production credentials.
- Auto-lock fires \`vault://auto-locked\` so any open tab re-prompts you.

**Session Recording**

**What it does** — Records terminal sessions in asciinema v2 format with a
streaming credential redactor (red-team corpus tested). Replay in-app via the
embedded CastPlayer.

**How to open it** — \`Cmd+Shift+R\` toggles recording on the active terminal
tab. **Recording → Open Recordings** opens the library.

**Typical workflow**
- \`Cmd+Shift+R\` to start; the tab status indicator turns red.
- Run your session.
- \`Cmd+Shift+R\` to stop. The cast file is saved to your platform's
  app-local data dir under \`recordings/\`.
- Open the Recordings tab, double-click a cast — the player scrubs through
  the session at variable speed.

**Tips**
- Redaction is *streaming* — secrets never land on disk.
- Use **Export** to share a redacted \`.cast\` file externally.

---

## 16. AI Troubleshooting Tree (Plan 15)

**What it does** — Symptom-to-playbook matcher. Type a symptom (e.g.
*"BGP neighbor flapping"*); a hybrid BM25 + embedding matcher picks the best
playbook from your YAML catalogue (6 builtins + your own). The executor
walks the decision tree, runs commands via the active tab, narrates findings
via the AI, and surfaces a root-cause card.

**How to open it** — \`Cmd+Shift+T\` (Troubleshoot tab) or
\`Cmd+Alt+T\` (Playbook Editor).

**Typical workflow**
- Open the Troubleshoot tab.
- Type a symptom → the matcher proposes a playbook.
- Click **Start** — the executor runs Tier-0 commands (hard gate: nothing
  Tier-1+ runs without explicit approval).
- Answer prompts, follow the narration, and accept or reject the AI's
  proposed root cause.
- Author your own playbooks in the Playbook Editor (\`Cmd+Alt+T\`).

**Tips**
- 6 builtin playbooks cover BGP, OSPF, interface, ACL, OSPF area, and
  reachability symptoms.
- Failure-mode E2E tests verify guardrail enforcement.

---

## Reference

- Full docs: \`docs/USER_GUIDE.md\`, plus per-feature docs:
  \`docs/COMMAND_BLOCKS.md\`, \`docs/WORKFLOWS.md\`, \`docs/NOTEBOOKS.md\`,
  \`docs/STRUCTURED_OUTPUT.md\`, \`docs/CHANGE_VERIFICATION.md\`,
  \`docs/FANOUT.md\`, \`docs/DRIFT.md\`, \`docs/GUARDRAILS.md\`,
  \`docs/PACKET_CAPTURE.md\`,
  \`docs/TOPOLOGY.md\`, \`docs/VAULT_AND_RECORDING.md\`.
- Troubleshooting: \`docs/TROUBLESHOOTING.md\`.
- Architecture: \`docs/ARCHITECTURE.md\`.
`;

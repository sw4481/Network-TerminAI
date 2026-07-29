// Comprehensive keyboard-shortcut table.
// Sourced one-to-one from the Tauri menu definitions in
// src-tauri/src/lib.rs (see the `help_*`, `view_*`, `change_*`, etc.
// MenuItem::with_id calls). Update both files together.

export const SHORTCUTS_MD = String.raw`# Keyboard Shortcuts

Every shortcut shipped in the macOS menu bar is listed below. \`Cmd\` on
macOS is \`Ctrl\` on Linux/Windows.

---

## General

| Shortcut | Action |
|----------|--------|
| \`Cmd+K\` | Command Palette |
| \`Cmd+Shift+W\` | Open Workflows |
| \`Cmd+Shift+N\` | Open Notebooks |
| \`F1\` | Open User Guide |
| \`Cmd+/\` | Quick Start & Shortcuts |

---

## View / Block

| Shortcut | Action |
|----------|--------|
| \`Cmd+1\` | Show Raw Output |
| \`Cmd+2\` | Show Structured |
| \`Cmd+3\` | Show Diff |
| \`Cmd+Shift+P\` | Pin Snapshot… |

> Export actions live under the **View** menu (no shortcut by default):
> *Export Structured as CSV*, *Export Structured as JSON*,
> *Copy as Markdown Table*.

---

## Change Verification

| Shortcut | Action |
|----------|--------|
| \`Cmd+Shift+C\` | Open Change Window |
| \`Cmd+Shift+1\` | Run Pre-Check |
| \`Cmd+Shift+2\` | Run Post-Check |

> Bundle management and Markdown export live under the **Change** menu.

---

## Multi-Device Fan-Out

| Shortcut | Action |
|----------|--------|
| \`Cmd+Shift+F\` | Open Fan-Out Panel |

> *Manage Device Groups…* is under the **Fan-Out** menu.

---

## Config Drift

| Shortcut | Action |
|----------|--------|
| \`Cmd+Shift+D\` | Open Drift Sidebar |

> *Manage Intent Templates…* is under the **Drift** menu.

---

## Infrastructure as Code

| Shortcut | Action |
|----------|--------|
| \`Cmd+Shift+E\` | Open IaC Studio (editor workspace) |
| \`Cmd+Shift+S\` | Open Terraform State |

> Both live under the **Operate → IaC** menu.

---

## AI Guardrails

| Shortcut | Action |
|----------|--------|
| \`Cmd+Shift+G\` | Guardrail Rule Editor |

> *Decision Log…* is under the **Guardrails** menu.

---

## Session Chains

| Shortcut | Action |
|----------|--------|
| \`Cmd+Shift+J\` | Manage Chains… |
| \`Cmd+Alt+J\` | Connect Active Tab Using Chain… |

> *New Chain…*, *Chain Templates…*, and *Reconnect Active Chain* are under
> the **Chains** menu.

---

## Packet Capture

| Shortcut | Action |
|----------|--------|
| \`Cmd+Shift+K\` | Open Captures Panel |

---

## Credential Vault

| Shortcut | Action |
|----------|--------|
| \`Cmd+Shift+V\` | Open Vault Tab |
| \`Cmd+L\` | Lock Active Envelope |

> *Lock All Envelopes*, *New Envelope…*, *Import from 1Password/Bitwarden
> CSV…*, and *Audit Log…* are under the **Vault** menu.

---

## Session Recording

| Shortcut | Action |
|----------|--------|
| \`Cmd+Shift+R\` | Start/Stop Recording (Active Tab) |

> *Open Recordings* is under the **Recording** menu.

---

## AI Troubleshooting

| Shortcut | Action |
|----------|--------|
| \`Cmd+Shift+T\` | Open Troubleshoot Tab |
| \`Cmd+Alt+T\` | Playbook Editor… |

> *Browse Builtin Playbooks* is under the **Troubleshoot** menu.

---

## SSH

> *Saved Connections…* is under the **SSH** menu (no shortcut).

---

## Help

| Shortcut | Action |
|----------|--------|
| \`F1\` | User Guide |
| \`Cmd+/\` | Quick Start & Shortcuts |

> *Keyboard Shortcuts Reference* and *About TerminAI* are under the
> **Help** menu.
`;

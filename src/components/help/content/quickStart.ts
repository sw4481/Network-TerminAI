// Quick Start — "get productive in five minutes". Aim for someone who has
// just installed the app and wants to do the most common 5 tasks fast.

export const QUICK_START_MD = String.raw`# Quick Start

Five minutes from launch to confidence. Each section is intentionally tiny —
follow them in order on your first run.

---

## 1. Connect to a device

- Press \`Cmd+K\` to open the **Command Palette**.
- Type the host name (or use the **SSH → Saved Connections…** menu).
- Pick the device → a new tab opens already authenticated.

> *No saved devices yet?* Type \`ssh user@host\` in any tab, run it once,
> and use **Save Connection** in the inline action bar.

---

## 2. Run and view a command

- Run \`show interfaces\` (or any \`show\` command).
- A new **block** appears. Try the view modes:
  - \`Cmd+1\` — raw text
  - \`Cmd+2\` — structured table (sortable, filterable)
  - \`Cmd+3\` — diff vs. a pinned snapshot
- Pin the snapshot with \`Cmd+Shift+P\` so you can diff against it later.

---

## 3. Save credentials securely

- Press \`Cmd+Shift+V\` to open the **Vault** tab.
- Create an envelope (you'll set a master password).
- Add a secret — username, password, optional identity-file path.
- Lock the active envelope with \`Cmd+L\` when you're done.

> CSV import from 1Password or Bitwarden is under
> **Vault → Import from 1Password/Bitwarden CSV…**.

---

## 4. Run a pre/post change check

- \`Cmd+Shift+C\` opens the **Change Window**.
- Pick a bundle (built-in *Interface Health* is a good starter).
- \`Cmd+Shift+1\` runs the **pre-check**.
- Make your change in the terminal.
- \`Cmd+Shift+2\` runs the **post-check** and opens the diff report.

> Export the report as Markdown via the Change menu — drop it straight into
> your change ticket.

---

## 5. AI troubleshooting (new!)

- Press \`Cmd+Shift+T\` to open the **Troubleshoot** tab.
- Type a symptom (e.g. *"BGP neighbor flapping with R2"*).
- Pick a playbook from the suggestions.
- Click **Start** — the executor runs read-only commands, narrates findings,
  and proposes a root cause.
- Review the AI's suggestion before accepting any remediation.

> Tier-1+ commands are gated by guardrails; you'll see a confirmation modal
> with the blast-radius summary before anything runs.

---

## 6. The keyboard shortcuts

The cheat sheet lives one tab over (**Shortcuts**) — \`Cmd+/\` brings up this
modal pre-scrolled to it. Print it once and you'll never need it again.
`;

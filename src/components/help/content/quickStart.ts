export const QUICK_START_MD = String.raw`# Quick Start

Use this path to go from first launch to a verified device check in about five
minutes. Press F1 for the full reference or search this help window for a
specific feature.

## 1. Configure AI (optional)

Open **Settings → General**, choose a provider and model, enter its API key or
local base URL, then select **Save Configuration** and **Test Connection**.
You can use the terminal, SSH, SFTP, serial, API, or NETCONF features without
AI; AI translation, agents, skills, and explanations need a working provider.

## 2. Connect to a device

Open **Operate → SSH → Saved Connections…** and create a device entry, or open
a terminal tab and run an ordinary ssh user@host command. Select the saved
entry to open a device tab. Wait for the live session to finish connecting
before using workflows or device-bound tools.

## 3. Run and review a command

Run a read-only command such as show interfaces. In Blocks Mode, the result
appears as a block. Try:

- Cmd+1 — raw output;
- Cmd+2 — structured output when a parser matches;
- Cmd+3 — compare with an available snapshot.

Collapse or bookmark the block, add a tag, and use the block action menu to
copy, rerun, export, or send it to a workflow/MOP.

## 4. Make the next task repeatable

Press Cmd+Shift+W to open **Workflows**, choose a parameterized template,
fill its inputs, and run it in the active tab. For a narrative procedure,
press Cmd+Shift+N to create a notebook/MOP with narrative, command, prompt,
and assertion cells.

## 5. Capture evidence for a change

Press Cmd+Shift+C to open the Change Window. Run a **Pre-Check**, perform
the approved change, then run a **Post-Check** and export the Markdown report.
For a device fleet, use **Audit → Fan-Out**. For expected configuration, use
**Audit → Drift**.

## Keep credentials safe

Press Cmd+Shift+V to create or unlock a Credential Vault envelope. Add
secrets there instead of pasting them into workflow files. Press Cmd+L to
lock the active envelope when you are finished.

## Find anything else

Press Cmd+K and search for a device, block, workflow, notebook, skill, or
action. Press F1 for the complete feature guide, or open the **Shortcuts**
and **About** sections from the left side of this help window.
`;

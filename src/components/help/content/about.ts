export const ABOUT_MD = String.raw`# About TerminAI

**TerminAI 1.1.0** is a desktop terminal and network-operations workspace for
engineers. It combines React and xterm.js in a Tauri desktop shell, Rust
services and SQLite persistence, and a Python sidecar for parsing and AI
features.

The app keeps sessions, vault data, recordings, and local RAG indexes on the
machine where it runs. Requests sent to a configured cloud or local AI provider
are subject to that provider's handling and retention policies.

## What is included

- Interactive local and SSH terminals with Terminal Mode, Blocks Mode, tabs,
  panes, restore, and shell integration.
- Structured device output, snapshots, change verification, fan-out, drift,
  guardrails, troubleshooting playbooks, and heartbeat monitoring.
- API and NETCONF workspaces, SFTP and serial console access, packet capture,
  topology, diagrams, subnet tools, and a controlled browser window.
- An editor with workspace search, Git, Python debugging, Cisco IOS-XE/NX-OS
  offline diagnostics, IaC Studio, Terraform state, and CI run views.
- AI providers, agents, skills, MCP servers, local RAG, a Credential Vault,
  redacted session recording, workflows, notebooks, and exports.

## Documentation

Start with the in-app **User Guide** and **Quick Start**. The repository's
GitHub README links to the detailed feature references, including:

- docs/CONFIG.md — providers, settings, and data locations
- docs/TROUBLESHOOTING.md — recovery and diagnostics
- docs/SECURITY.md — vault, recording, and security guidance
- docs/ARCHITECTURE.md — frontend, Rust, and sidecar boundaries
- docs/COMMAND_BLOCKS.md, docs/WORKFLOWS.md, and docs/NOTEBOOKS.md
- docs/STRUCTURED_OUTPUT.md, docs/CHANGE_VERIFICATION.md,
  docs/FANOUT.md, docs/DRIFT.md, and docs/GUARDRAILS.md
- docs/PACKET_CAPTURE.md, docs/TOPOLOGY.md, and
  docs/VAULT_AND_RECORDING.md
- docs/MCP_SETUP.md, docs/MERAKI_CLI.md, and docs/API.md

## Safety boundary

The application can help prepare commands and operations, but network changes
remain subject to the active connection, provider/tool permissions, and
guardrail approval. Always verify the target and the resulting device state.
Offline Cisco editor diagnostics are read-only and do not apply configuration.

## Credits

TerminAI builds on Tauri, React, xterm.js, Cisco Genie/pyATS, TextFSM,
asciinema, sqlite-vec, ONNX Runtime, MiniLM, React Flow, russh, russh-sftp,
tokio-cron-scheduler, minijinja, Argon2, AES-GCM, and react-markdown.

See the repository license and contribution guidance for project terms.
`;

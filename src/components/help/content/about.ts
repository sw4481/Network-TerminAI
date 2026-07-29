// About — version, project intent, and credits.

export const ABOUT_MD = String.raw`# About TerminAI

**TerminAI** is a Warp-inspired, AI-augmented terminal built by and for
network engineers preparing for (and running) production CCIE-track work.
It is a desktop-first application (Tauri + React + Rust) with a Python
sidecar for parsing and AI features. Everything runs locally — your
sessions, secrets, and embeddings never leave your machine.

**Version**: 1.0.0
**License**: see \`LICENSE\` in the repo root.

---

## Documentation

The full markdown documentation set ships with the source tree:

- \`docs/USER_GUIDE.md\` — extended user guide
- \`docs/ARCHITECTURE.md\` — three-layer architecture overview
- \`docs/TROUBLESHOOTING.md\` — common issues and fixes
- \`docs/SECURITY.md\` — vault, recording redaction, threat model
- Per-feature: \`COMMAND_BLOCKS\`, \`WORKFLOWS\`, \`NOTEBOOKS\`,
  \`STRUCTURED_OUTPUT\`, \`CHANGE_VERIFICATION\`, \`FANOUT\`, \`DRIFT\`,
  \`GUARDRAILS\`, \`PACKET_CAPTURE\`, \`TOPOLOGY\`,
  \`VAULT_AND_RECORDING\`, \`COMMAND_PALETTE\`, \`PARSING\`.

---

## Plans (all complete)

| # | Plan | One-line summary |
|---|------|------------------|
| 00 | Foundation | Tauri shell, SQLite, sidecar bootstrap |
| 01 | Command Blocks | Collapse / pin / share / tag / bookmark |
| 02 | Workflows | Parameterised multi-step command templates |
| 03 | Notebooks | Markdown notebooks with runnable cells (MOPs) |
| 04 | Command Palette | \`Cmd+K\` fuzzy search across the app |
| 05 | Structured Output | Genie / TextFSM tables + diff snapshots |
| 06 | Change Verification | Pre/post bundle diff reports + Markdown export |
| 07 | Multi-Device Fan-Out | russh, 50-cap, ZIP export |
| 08 | Config Drift | Jinja2 intents + scheduled drift checks |
| 09 | AI Guardrails | 4-tier blast-radius classifier + 278 builtins |
| 10 | Session Chains | Multi-hop SSH, 4 templates |
| 11 | Packet Capture | IOS-XE EPC → inline pcap viewer |
| 12 | RAG | Local ONNX MiniLM + sqlite-vec, sources drawer |
| 13 | Topology | CDP/LLDP/BGP/OSPF/IS-IS → React Flow graph |
| 14 | Vault + Recording | Argon2id+AES-GCM vault, asciinema v2 with redaction |
| 15 | Troubleshooting Tree | YAML playbooks + AI narration + Tier-0 hard gate |

---

## Acknowledgements

Built on a stack of excellent open-source projects:

- **Tauri** — the desktop shell and IPC plumbing.
- **React** + **xterm.js** — the frontend.
- **Cisco Genie / pyATS** + **TextFSM** — structured show parsing.
- **asciinema** v2 cast format — session recording.
- **sqlite-vec** — local vector index for RAG.
- **\`@xyflow/react\`** (React Flow v12) — topology canvas.
- **\`russh\`** + **\`russh-sftp\`** — pure-Rust SSH/SFTP for fan-out and pcap fetch.
- **\`tokio-cron-scheduler\`** — drift schedules.
- **\`minijinja\`** + **\`similar\`** — intent rendering and diff.
- **Argon2** + **\`aes-gcm\`** — vault crypto.
- **ONNX Runtime** + **MiniLM** — local embeddings.
- **\`react-markdown\`** — this very help modal.

Thank you to every upstream maintainer.
`;

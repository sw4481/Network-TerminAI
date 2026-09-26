# Security Policy

## Supported versions

| Version | Supported |
| --- | --- |
| 1.1.x | Yes |
| < 1.1 | No |

## Report a vulnerability

Do **not** open a public issue for a security vulnerability.

Use GitHub Private Vulnerability Reporting for the public repository:

<https://github.com/sw4481/Network-TerminAI/security/advisories/new>

Include:

- what happened;
- steps to reproduce;
- expected impact;
- affected version or commit;
- any safe proof-of-concept details that do not expose real credentials or customer data.

## What TerminAI protects

TerminAI is a local desktop app for network operations. The main trust boundaries are:

1. **You and the UI** choose commands, approvals, credentials, and providers.
2. **The Tauri backend** owns local files, PTYs, SQLite, updater checks, and native commands.
3. **The Python sidecar** runs AI/provider/integration logic.
4. **External systems** include shells, SSH targets, APIs, MCP servers, AI providers, and update feeds.

Treat anything from a terminal, device, model, MCP server, or integration as untrusted until you review it.

## Local data and credentials

TerminAI stores app data locally and keeps the historical `ccie-terminal` data roots for upgrade compatibility.

| Platform | Local data root |
| --- | --- |
| macOS | `~/Library/Application Support/ccie-terminal` |
| Windows | `%APPDATA%\\ccie-terminal` |
| Linux | `~/.config/ccie-terminal` and `~/.local/share/ccie-terminal` |

These locations can contain sessions, scrollback, local indexes, saved settings, vault metadata, recordings, logs, and integration state. Do not commit or upload them.

Use **Settings → General** and the integration-specific Settings tabs for credentials. Use the Credential Vault for reusable secrets. Never paste real API keys, SSH keys, passwords, tokens, customer configs, or private device output into GitHub issues, docs, examples, screenshots, recordings, or tests.

## AI provider data handling

TerminAI only sends AI requests to the provider or local endpoint you configure. That may include prompts, selected context, tool results, command output, or integration responses that you approve or attach.

Before using a provider:

1. Open **Settings → General**.
2. Confirm the provider, model, key, and base URL.
3. Click **Test Connection**.
4. Review each tool approval card before allowing a write or high-risk action.

For local providers, confirm the base URL points to the model service you intend to use.

## Command and tool approvals

AI-generated commands and tool calls must be reviewed before execution. Approval prompts show the target action and risk context when a feature can change systems.

Recommended defaults:

- auto-allow read-only inventory and status actions only when you trust the integration;
- require confirmation for writes, deletes, config pushes, file changes, captures, and workflow steps;
- deny actions you do not understand;
- inspect the decision log when investigating unexpected behavior.

## MCP servers and external tools

MCP servers are external code. Only enable servers you trust.

Before enabling an MCP server:

1. Read the server command, arguments, environment, and requested access.
2. Prefer least-privilege folders and tokens.
3. Set approval policies in **Settings → MCP Servers**.
4. Disable or remove unused servers.

Do not give a public or third-party MCP server broad filesystem access unless you would also give that server direct shell access.

## Updates

TerminAI uses the Tauri updater feed configured in `src-tauri/tauri.conf.json`:

```text
https://github.com/sw4481/Network-TerminAI/releases/latest/download/latest.json
```

Release artifacts are served over HTTPS and updater artifacts are signature-checked by Tauri using the public key in the Tauri manifest. Also verify release checksums when installing manually.

The app keeps the historical bundle identifier and package name for upgrade and data compatibility:

- bundle identifier: `com.ccie.terminal`
- package name: `ccie-terminal`

## Public-repository hygiene

Before publishing or attaching files:

- remove `.env`, private keys, tokens, certificates, database files, logs, packet captures, recordings, screenshots with secrets, and local app data;
- replace real hostnames, serials, IPs, usernames, organizations, and customer names with examples unless they are intentionally public;
- keep `.env.example` placeholder-only;
- run the sanitizer/open-source pipeline before pushing a clean public repository;
- do not push Git history from a private checkout to the public repository.

## Secure usage checklist

- Keep TerminAI updated.
- Verify downloads with `SHA256SUMS.txt`.
- Use the Vault or integration Settings for credentials instead of command history.
- Review generated commands before running them.
- Use read-only checks first during troubleshooting.
- Review recordings and exported reports before sharing.
- Lock Vault envelopes when finished.
- Disable integrations and MCP servers you are not using.
- Keep private device output and customer data out of public issues and examples.

## Last updated

2026-09-22 for TerminAI 1.1.x.

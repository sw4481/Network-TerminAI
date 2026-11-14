# Changelog

All notable changes to TerminAI will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.16] - 2026-10-20

### Fixed

- Restored Windows terminal tabs that had a full screen of history, such as a running Claude Code session, now get a prompt. ConPTY ignored the startup cursor report when it fell outside the size the shell was started with (#15).

### Known limitations

- Packet capture over SCP still requires `sshpass` and does not work on Windows.
- On Windows, very old devices that offer only legacy SSH key-exchange or cipher algorithms may fail to connect, and connection and authentication errors may be worded differently than on macOS and Linux.
- macOS builds remain ad-hoc signed and unnotarized.

## [1.1.15] - 2026-10-19

### Fixed

- Restored terminal tabs on Windows now get a prompt and echo typed text. PowerShell's startup cursor query could arrive before the tab was listening for the reply, leaving the shell waiting forever (#15).
- Popping out a terminal tab or editor pane on Windows no longer leaves a white, frozen window and stops the main window from opening tabs (#17).

### Known limitations

- Packet capture over SCP still requires `sshpass` and does not work on Windows.
- On Windows, very old devices that offer only legacy SSH key-exchange or cipher algorithms may fail to connect, and connection and authentication errors may be worded differently than on macOS and Linux.
- macOS builds remain ad-hoc signed and unnotarized.

## [1.1.14] - 2026-10-18

### Added

- Use Cisco's Genie parsers on Windows. pyATS has no Windows build, so the sidecar now runs the pure-Python Genie parser library on a built-in stand-in for the Genie core, falling back to TextFSM when a parser cannot run.

### Fixed

- Change verification no longer fails when a command returns no data, such as `show ip bgp summary` on a switch without BGP or `show ip ospf neighbor` with no neighbors; the empty result is recorded and the remaining commands run (#14).

### Known limitations

- Packet capture over SCP still requires `sshpass` and does not work on Windows.
- On Windows, very old devices that offer only legacy SSH key-exchange or cipher algorithms may fail to connect, and connection and authentication errors may be worded differently than on macOS and Linux.
- macOS builds remain ad-hoc signed and unnotarized.

## [1.1.13] - 2026-10-17

### Added

- Add Cisco Workflows authoring and approved execution: a bundled Workflows agent and catalog that can author, import, run (after approval) and inspect Meraki workflow instances from the standalone agent and Network Architect, sharing the saved Meraki configuration.

### Fixed

- Run "run against switch" change verification on Windows over the app's built-in SSH client instead of the unavailable `sshpass` (#4).
- Parse IOS-XE show commands such as `show ip interface brief` on Windows, where Genie is unavailable, by using the Cisco IOS TextFSM templates (#9).

### Known limitations

- Packet capture over SCP still requires `sshpass` and does not work on Windows.
- On Windows, very old devices that offer only legacy SSH key-exchange or cipher algorithms may fail to connect, and connection and authentication errors may be worded differently than on macOS and Linux.
- macOS builds remain ad-hoc signed and unnotarized.

## [1.1.12] - 2026-10-15

Includes the changes from the unpublished 1.1.11 release candidate.

### Added

- Add MAC Address Lookup under Operate > Tools with flexible address input, detailed IEEE assignments, address classifications, and copyable normalized formats.
- Bundle the complete offline IEEE registry and add a validated, atomic registry-update button without sending entered MAC addresses over the network.

### Fixed

- Fix Windows installer packaging by replacing the shell-quoted inline macOS signing hook with a standalone script that skips signing on Windows and Linux.
- Repair macOS resource sealing by signing bundled Python native resources before sealing the app and preventing managed Python children from writing bundled bytecode.
- Verify DMG and updater-archive signatures before and after the bundled sidecar startup checks.
- Disable IOS paging before live change-verification show commands.

### Known limitations

- macOS builds remain ad-hoc signed and unnotarized; the signature-integrity repair does not remove Gatekeeper trust warnings.

## [1.1.11] - 2026-10-15

### Added

- Add MAC Address Lookup under Operate > Tools with flexible address input, detailed IEEE assignments, address classifications, and copyable normalized formats.
- Bundle the complete offline IEEE registry and add a validated, atomic registry-update button without sending entered MAC addresses over the network.

### Fixed

- Repair macOS resource sealing by signing bundled Python native resources before sealing the app and preventing managed Python children from writing bundled bytecode.
- Verify DMG and updater-archive signatures before and after the bundled sidecar startup checks.
- Disable IOS paging before live change-verification show commands.

### Known limitations

- macOS builds remain ad-hoc signed and unnotarized; the signature-integrity repair does not remove Gatekeeper trust warnings.

## [1.1.10] - 2026-10-07

### Added

- Add a global maximum-agent-steps setting to General LLM settings, accepting 1–500 steps or a blank value to preserve each execution engine's existing default.
- Apply the configured budget to DeepAgents graph steps and legacy agent iterations, including configured budgets retained across approval pauses.

### Fixed

- Preserve managed Windows SSH connection identity when attaching Network Architect to the focused saved connection.
- Serialize attached-terminal investigation-plan publication with diagnostic execution and recover safely from expected missing-plan tool errors.

### Known limitations

- DeepAgents counts graph steps, not terminal commands; larger limits do not change execution timeouts or approval requirements.
- Attached-terminal input was confirmed in the Windows test build; full investigation completion with a custom step limit remains operator-pending.

## [1.1.9] - 2026-10-06

### Fixed

- Keep Kanban General and Network Architect tasks from decrypting unused merged-catalog vault secrets, while preserving dedicated-agent credential errors.
- Restore Windows editor cursor paint with Windows-only CSP style overrides and the exact Tauri IPC origin, without relaxing script policy or changing macOS behavior.
- Add explicitly launched, visible managed Windows SSH connections with a shared human/agent PTY and authentication, lifecycle, close, history, and lease-generation protection.

### Known limitations

- Native Windows/WebView2, IME, and live SSH acceptance remain unverified.
- Existing unmanaged or manually launched SSH sessions are not adopted; select a saved profile to explicitly open a new managed Windows SSH connection.
- Detaching managed live SSH terminals or their disconnected history remains unsupported.

## [1.1.8] - 2026-10-06

### Fixed

- Stop imported PowerShell history from appearing as running commands and correct command elapsed-time calculations.
- Submit OpenCode launches with the Windows Enter sequence while preserving Unix terminal behavior.
- Add a Windows-only solid editor-caret fallback, including Vim insert mode, without forcing caret visibility during blur or composition.
- Include bundled agent definitions and API catalogs in the Python sidecar wheel and resolve installed assets relative to the package.
- Explain the Windows manual-SSH attachment safety limitation with actionable diagnostic guidance.

### Known limitations

- Native Windows/WebView2 verification of the editor-caret mitigation is still pending.
- Meraki catalog packaging is repaired, but the original Windows Network Architect configuration/eligibility failure still requires live verification.
- Agent execution in manually attached Windows SSH terminals remains unsupported; run diagnostics manually and share redacted output in chat.

## [1.1.7] - 2026-10-05

### Added

- Add the reusable prompt library for saving and inserting common AI prompts.

### Fixed

- Repair Windows editor terminals, PowerShell command-block integration, saved SSH launch fallback, and hidden language-server child windows.
- Keep Network Architect vendor subagents isolated so one unavailable tool does not block other configured vendors.

## [1.1.6] - 2026-10-01

### Fixed

- Detach the mounted macOS disk image by its device before removing the temporary mount directory during release validation.

## [1.1.5] - 2026-10-01

### Added

- Add the SQLite-backed Kanban board, task dispatcher, run history, and live activity updates. Migration V92 creates only Kanban tables and preserves existing application data.

## [1.1.3] - 2026-09-29

### Fixed

- Show the blinking terminal cursor at the correct cell in the packaged macOS app by allowing xterm's generated styles through Tauri's CSP.
- Bundle the xterm runtime and add-ons locally, and focus the owning terminal when selecting a pane.

## [1.1.2] - 2026-09-26

### Fixed

- Bundle prepackaged agents into installed apps and seed them from application resources on first launch.
- Bundle xterm's CSS locally so the terminal cursor and hidden input render correctly in installed apps.
- Clarify missing `sshpass` errors for Windows SSH-direct helpers.
- Keep macOS unsigned like the successful release path and document the `xattr` quarantine removal launch commands.
- Keep Linux releases to the supported Debian package path and refresh release documentation for the corrected trust model.

## [1.1.1] - 2026-09-26

### Fixed

- Superseded by `1.1.2`; no public release was published from the failed `1.1.1` release workflow.

## [1.1.0] - 2026-09-08

### Added

- Offline Cisco IOS-XE and NX-OS editor linting with Monaco diagnostics.
- Workspace search and editor power-editing actions.
- Detachable terminal windows.
- Terminal agent, Zabbix, Postman/API target, and advanced network-operation integrations.
- Improved concurrent fanout workflows and cross-platform SSH handling.

### Fixed

- Cross-platform Rust warnings and strict CI failures in the terminal and AI command paths.
- Fanout stress-test synchronization under concurrent worker load.

## [1.1.4] - 2026-10-01

### Fixed

- Include the TerminAI PyATS client in supported portable sidecar builds and report a clear error when sandbox initialization cannot load it.
- Use the checkout's Python environment for debug sidecars so stale bundled interpreters do not hide source changes.

## [Unreleased]

### Planned

- Enhanced keyboard shortcuts and customization
- Themes and color scheme customization
- Plugin system for community extensions
- Cloud sync for skills and settings
- Advanced command history analytics

## [1.0.0] - 2026-07-31

### Added

#### Core Terminal Features (Phase 0-1)
- Multi-tab terminal emulator using xterm.js 6.0
- Full PTY support via portable-pty with proper session management
- Tab management with create, close, and switch functionality
- Shell integration installer (OSC 133 sequences for Bash and Zsh)
- Command block detection and parsing from shell output
- Automatic session persistence with SQLite database
- Session restoration on app launch with tab state, scrollback, and AI context
- Window resize handling for PTY terminals
- Configurable terminal colors and settings

#### AI Integration (Phase 2-3)
- AI chat panel with streaming responses via Server-Sent Events (SSE)
- Multiple AI provider support: Anthropic Claude, OpenAI, Google Gemini, Ollama, vLLM
- Natural language to command translation via `#` prefix
- Automatic error explanation and suggestions for failed commands
- Per-tab AI conversation history with persistence
- Live-reloading configuration from `~/.config/ccie-terminal/config.toml`
- LLM profile system with per-profile provider, model, and parameters
- Streaming token display with markdown rendering

#### MCP Integration (Phase 4)
- Model Context Protocol (MCP) client implementation with JSON-RPC 2.0
- Support for stdio and SSE transport mechanisms
- MCP server management UI with add, edit, remove, and status monitoring
- Tool invocation with approval gating and policy engine
- Three approval policies: always_allow, always_deny, prompt_each
- Real-time tool discovery and schema display
- Comprehensive error handling for MCP server failures
- MCP server settings persistence in SQLite

#### Skills System (Phase 5)
- Custom skill authoring with AI assistance
- Skill loader with YAML manifest parsing
- Manual skill invocation via `/skill-name` command syntax
- Skills library with CRUD operations (create, read, update, delete)
- Integration with MCP tool invocation from skills
- Automatic prompt template processing with context injection
- Skills persistence in `~/.config/ccie-terminal/skills/` directory
- Support for helper scripts (Python, Bash, etc.) within skills

#### Search and Discovery (Phase 6)
- Full-text search (FTS5) across command history, AI messages, and skills
- Keyboard shortcut (Cmd/Ctrl+F) to open search interface
- Real-time search with match highlighting
- Search results grouped by content type (commands, AI, skills)
- Jump-to-tab functionality from search results

#### Configuration and Settings
- Settings modal with API key management
- Environment variable support via `~/.config/ccie-terminal/.env`
- Hot-reload for configuration changes without restart
- Default profile selection in Settings UI
- MCP server configuration with environment variables
- Structured logging with tracing-subscriber

#### Installers and Updates

- Native installers for Apple Silicon macOS 15+, x64 Windows, and x64 Linux
- Bundled portable Python and `ccie_sidecar` runtime in every installer
- Signed Tauri updater artifacts and a multi-platform `latest.json` feed,
  including installer-specific AppImage and Debian updates on Linux
- SHA-256 checksum manifest for every first-download installer
- Documented Gatekeeper and SmartScreen handling for the zero-cost unsigned
  macOS and Windows installers
- Launch-time and manual update checks with versioned release notes
- Update notification, status-bar indicator, and Settings → Updates controls
- Pre-migration database backups with retention of the three newest snapshots
- Frozen Bun, Cargo, and Python dependency locks for release builds
- Draft-only publication until installers, signatures, and updater metadata pass
  the complete release gate

### Fixed
- Python test isolation issues with mocking
- Rust clippy warnings for better code quality
- MCP SSE transport reconnection handling
- Agent bridge tests for new API parameters
- Skills UI cleanup and unused code removal
- Session restoration race conditions
- PTY deadlock on tab close (using clone_killer pattern)
- Duplicate database migrations
- Search result ordering and relevance scoring

### Changed
- Upgraded to Tauri v2 stable
- Migrated to React 19
- Improved error messages for missing API keys
- Enhanced MCP tool approval UX with detailed prompts
- Refactored PTY session manager for better lifecycle management
- Optimized database queries for faster search
- Improved type safety across TypeScript codebase

### Security
- Input validation for all user-provided configuration
- Approval gating for all MCP tool invocations
- Secure credential storage in environment files (not checked into git)
- SQL injection prevention with parameterized queries
- Process isolation for Python sidecar

---

For detailed documentation, see [README.md](README.md) and [docs/](docs/).

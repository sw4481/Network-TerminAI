# Changelog

All notable changes to TerminAI will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

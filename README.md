# TerminAI

A Warp-inspired AI-powered terminal built for network engineers. TerminAI combines a modern terminal emulator with deeply integrated AI capabilities, intelligent command assistance, and powerful automation through skills and MCP (Model Context Protocol) tools.

## Downloads

Download the current release from [TerminAI Releases](https://github.com/sw4481/TerminAI/releases/latest).

| Platform | Supported system | Download |
| --- | --- | --- |
| macOS | macOS 15 or newer, Apple Silicon | `.dmg` |
| Windows | Windows 11, x64 | NSIS `-setup.exe` |
| Linux | Ubuntu 22.04 or 24.04, x64 | `.AppImage` or `.deb` |

Python and the TerminAI sidecar are included in every installer; end users do
not need Rust, Bun, or Python.

> **Zero-cost distribution notice:** Tauri signs every in-app update, and each
> release includes `SHA256SUMS.txt`, but the first-download macOS and Windows
> installers do not carry paid Apple Developer ID or Windows Authenticode
> publisher signatures. macOS will show a Gatekeeper warning, and Windows can
> show or enforce a SmartScreen/Smart App Control block. Verify the checksum
> before using either operating-system override.

### Install on macOS

1. Download the Apple Silicon `.dmg`.
2. Download `SHA256SUMS.txt`, run `shasum -a 256 TerminAI*.dmg`, and confirm the
   result matches the `.dmg` line in the checksum file.
3. Open the DMG and drag **TerminAI** to **Applications**.
4. Try to open TerminAI once. macOS will block the unnotarized app.
5. Open **System Settings → Privacy & Security**, scroll to **Security**, select
   **Open Anyway**, authenticate, and then select **Open**. Apple makes this
   override available for about an hour after the blocked launch attempt.

### Install on Windows

1. Download the x64 `-setup.exe` installer.
2. Download `SHA256SUMS.txt`, run
   `Get-FileHash .\TerminAI*-setup.exe -Algorithm SHA256` in PowerShell, and
   confirm the result matches the installer line in the checksum file.
3. Run the installer. If Microsoft Defender SmartScreen offers **More info →
   Run anyway**, use it only after verifying the checksum and GitHub download
   source. Smart App Control or an organization policy can block an unsigned
   installer completely; there is no supported zero-cost bypass for that case.
4. Follow the NSIS installer prompts.

### Install on Linux

For the AppImage:

```bash
sha256sum TerminAI_*.AppImage
chmod +x TerminAI_*.AppImage
./TerminAI_*.AppImage
```

For the Debian package:

```bash
sha256sum TerminAI_*.deb
sudo apt install ./TerminAI_*.deb
```

Compare each printed hash with its entry in `SHA256SUMS.txt` before launching
or installing the file.

TerminAI checks the signed GitHub updater feed at launch and from **Settings →
Updates**. It downloads an update only after its Tauri signature verifies. The
historical identifier (`com.ccie.terminal`) and `ccie-terminal` data roots are
intentionally retained, so upgrading or reinstalling preserves sessions,
credentials, vaults, and RAG data.

## Key Features

- **Split Panes**: View multiple terminals side-by-side within a single tab
  - Horizontal and vertical splits with drag-to-resize handles
  - Independent PTY session per pane for simultaneous work
  - Keyboard navigation (Cmd+Alt+Arrows) and focus management
  - Layout persistence across restarts
  - Works seamlessly with both Terminal and Blocks modes
- **Dual-Mode Terminal**: Choose the interface that fits your workflow
  - **Terminal Mode** (default): Traditional xterm.js for interactive programs (SSH, vim, top)
  - **Blocks Mode**: Warp-style interface with command history blocks and input editor
  - Seamless mode switching with instant toggle
- **Command Blocks**: Organize terminal into discrete, manageable command units
  - Automatic block creation via OSC 133 shell integration
  - Collapsible command outputs with clean rendering
  - Bookmark important commands for quick access
  - Rerun commands with one click
  - Copy outputs without ANSI escape sequences
  - Exit code tracking and visual indicators
  - Command metadata (duration, timestamp, working directory)
- **Command Palette**: Universal Cmd+K launcher for commands, skills, and actions
  - Fuzzy search across all items with intelligent matching
  - Recent commands quick access (last 20)
  - Bookmarked commands for workflows
  - Keyboard-driven navigation (↑/↓/Enter/Esc)
  - Built-in actions (new tab, search, toggle panels)
- **ReACT Agents with Tool Integration**: Build custom AI agents with natural language interfaces
  - **Meraki Dashboard Integration**: Full-coverage CLI for all 933 Meraki API endpoints
  - Natural language queries to Cisco Meraki infrastructure
  - Automatic blast-radius classification and approval gating
  - Context tracking and disambiguation
  - MCP-compatible tool catalogs for agent definitions
- **AI-Powered Command Translation**: Type natural language queries and get shell commands instantly
- **Intelligent Error Explanation**: Automatic AI analysis and suggestions when commands fail
- **Multi-Tab Terminal**: Full xterm.js-based terminal with tab management and session persistence
- **Skills System**: Reusable AI workflows with custom prompts and helper scripts
- **MCP Integration**: Connect external tools and services through the Model Context Protocol
- **Full-Text Search**: Instant search across command history, AI conversations, and skills
- **Session Management**: Save and restore entire terminal sessions with tabs, scrollback, and AI context
- **Multiple AI Providers**: Support for Anthropic Claude, OpenAI, Google Gemini, Ollama, and vLLM
- **Shell Integration**: Enhanced shell prompts with command tracking (OSC 133 sequences)

## Quick Start

### Development requirements

- Rust stable (`rustup`)
- Node 22+ and [Bun](https://bun.sh)
- Python 3.12
- At least one AI provider API key (see Configuration)

### Run from source

```bash
git clone https://github.com/sw4481/TerminAI.git
cd TerminAI

# Install frontend dependencies
bun install

# Set up the frozen Python sidecar environment
cd sidecar
uv sync --frozen --extra dev
cd ..

# Run the application
./run.sh
```

### Configuration

1. On first launch, TerminAI creates configuration and application-data files
   under the historical `ccie-terminal` roots. These names are retained for
   upgrade compatibility:
   - macOS: `~/Library/Application Support/ccie-terminal`
   - Windows: `%APPDATA%\ccie-terminal`
   - Linux config: `~/.config/ccie-terminal`
   - Linux application data: `~/.local/share/ccie-terminal`

2. Add your API key to `~/.config/ccie-terminal/.env`:
```bash
ANTHROPIC_API_KEY=sk-ant-...
# or
OPENAI_API_KEY=sk-...
# or
GOOGLE_API_KEY=...
```

3. Configure profiles in `~/.config/ccie-terminal/config.toml`:
```toml
[profiles.fast]
provider = "anthropic"
model = "claude-sonnet-4-6"

[profiles.smart]
provider = "anthropic"
model = "claude-opus-4-7"
```

Both files support live reloading - changes take effect immediately.

## Building for Production

```bash
# Build the portable sidecar, then the application
cd sidecar && ./scripts/build_sidecar.sh && cd ..
bun tauri build -- --locked

# Output will be in src-tauri/target/release/bundle/
```

## Documentation

- [User Guide](docs/USER_GUIDE.md) - Complete tutorial and feature reference
- [Meraki CLI Integration](docs/MERAKI_CLI.md) - Natural language interface to Cisco Meraki Dashboard API
- [Split Panes](docs/SPLIT_PANES.md) - Split panes usage, keyboard shortcuts, and architecture
- [Command Blocks](docs/COMMAND_BLOCKS.md) - Command blocks architecture and usage guide
- [API Documentation](docs/API.md) - Tauri commands, Python sidecar protocol, and integrations
- [Architecture](docs/ARCHITECTURE.md) - System design and data flow
- [Configuration](docs/CONFIG.md) - LLM profiles, environment variables, and settings
- [MCP Setup](docs/MCP_SETUP.md) - Model Context Protocol server integration
- [Contributing](docs/CONTRIBUTING.md) - Development setup and contribution guidelines

## Screenshots

> Note: Screenshots coming soon in `docs/screenshots/`

## Development

```bash
# Run tests
cd src-tauri && cargo test        # Rust tests
cd sidecar && pytest              # Python tests
bun test                          # TypeScript tests

# Run in development mode
./run.sh

# Watch TypeScript changes
bun run dev
```

## Project Status

TerminAI v1.0 - All core features implemented and tested:
- Phase 0: Scaffolding and sidecar communication
- Phase 1: Multi-tab terminal with xterm.js
- Phase 2: AI chat panel with streaming
- Phase 3: Natural language command translation
- Phase 4: MCP server management UI
- Phase 5: Skills system with authoring wizard
- Phase 6: Full-text search and session persistence
- Phase 7: Hardening and release preparation

## Tech Stack

- **Frontend**: React 19 + TypeScript + Vite + xterm.js
- **Backend**: Tauri v2 (Rust) + SQLite + Tokio
- **AI Sidecar**: Python 3.12 + Anthropic SDK + OpenAI SDK
- **State Management**: Zustand
- **Terminal**: xterm.js with addons (fit, web-links)
- **Database**: SQLite with FTS5 for full-text search

## Architecture

TerminAI uses a three-layer architecture:

1. **Frontend (React)**: User interface, xterm.js terminals, state management
2. **Core (Rust/Tauri)**: PTY management, database, MCP client, skills loader
3. **Sidecar (Python)**: LLM integration, AI workflows, skill execution

Data flows through:
- Frontend ↔ Tauri: IPC commands via `@tauri-apps/api`
- Tauri ↔ Sidecar: NDJSON protocol over stdio
- Tauri ↔ PTY: portable-pty with command parsing
- Tauri ↔ MCP: JSON-RPC 2.0 over stdio/SSE

See [Architecture Documentation](docs/ARCHITECTURE.md) for details.

## License

TBD

## Contributing

We welcome contributions! Please see [CONTRIBUTING.md](docs/CONTRIBUTING.md) for:
- Development environment setup
- Code style guidelines
- Testing requirements
- Pull request process

## Support

For issues, questions, or feature requests, open an issue in the
[TerminAI repository](https://github.com/sw4481/TerminAI/issues).

# TerminAI User Guide

Complete guide to using TerminAI's features.

## Table of Contents

- [Getting Started](#getting-started)
- [Terminal Basics](#terminal-basics)
- [Command Blocks Setup](#command-blocks-setup)
- [AI Features](#ai-features)
- [RAG library (vendor-aware completion)](./rag/USER_GUIDE.md) — vendor-grounded AI answers from your own docs
- [Skills System](#skills-system)
- [MCP Integration](#mcp-integration)
- [Search](#search)
- [Session Management](#session-management)
- [Configuration](#configuration)
- [Keyboard Shortcuts](#keyboard-shortcuts)
- [Troubleshooting](#troubleshooting)

## Getting Started

### First Launch

When you first launch CCIE Terminal:

1. Configuration files are created at `~/.config/ccie-terminal/`
2. A SQLite database is initialized for storing sessions and history
3. Shell integration scripts are installed (optional but recommended)

### Adding an API Key

CCIE Terminal requires an API key for at least one AI provider:

1. Open `~/.config/ccie-terminal/.env` in a text editor
2. Add your API key:
   ```bash
   ANTHROPIC_API_KEY=sk-ant-your-key-here
   ```
3. Save the file (changes are applied immediately)

Supported providers:
- **Anthropic Claude**: Get a key at https://console.anthropic.com/
- **OpenAI**: Get a key at https://platform.openai.com/
- **Google Gemini**: Get a key at https://makersuite.google.com/app/apikey
- **Ollama**: No API key needed (local installation)
- **vLLM**: No API key needed (self-hosted)

### Creating Your First Tab

Click the "+" button in the tab bar or press `Cmd+T` (macOS) / `Ctrl+T` (Linux/Windows) to create a new terminal tab.

## Terminal Basics

### Multi-Tab Interface

- **Create tab**: Click "+" button or `Cmd/Ctrl+T`
- **Switch tabs**: Click on tab titles or use `Cmd/Ctrl+1-9`
- **Close tab**: Click "×" on tab or `Cmd/Ctrl+W`
- **Reorder tabs**: Drag and drop tab titles

### Terminal Modes

CCIE Terminal offers two complementary modes that you can switch between:

**Terminal Mode (Default)**
- Traditional xterm.js terminal with full PTY access
- Best for: SSH, vim, top, interactive programs
- Features: Full terminal emulation, scrollback, ANSI colors

**Blocks Mode**
- Warp-inspired interface with command history blocks
- Best for: Simple commands, organized history, command reuse
- Features: Discrete command blocks, collapsible outputs, input editor
- Limitation: Interactive commands (SSH, vim) don't work in blocks mode

**How to Switch**
- Look for toggle buttons at the top of each terminal tab
- Click "Terminal" for traditional mode
- Click "Blocks" for blocks mode
- Mode preference is per-tab

### Command Blocks

When shell integration is enabled, each command gets a "block" with:
- Command text and timestamp
- Output (collapsible)
- Exit code indicator (green = success, red = failure)
- Duration and working directory
- Block actions (bookmark, rerun, copy)

Blocks are available in both modes:
- **Terminal Mode**: Blocks stored in database, visible via Command Palette
- **Blocks Mode**: Blocks displayed as visual components above input editor

### Shell Integration

Shell integration uses OSC 133 escape sequences to:
- Mark command boundaries
- Capture exit codes
- Enable automatic block creation
- Support intelligent search

**Installation**

Add these lines to your shell configuration file:

**For Zsh (~/.zshrc):**
```bash
# CCIE Terminal integration
source <path-to-ccie>/docs/shell-integration/zshrc-additions.sh
```

**For Bash (~/.bashrc):**
```bash
# CCIE Terminal integration
source <path-to-ccie>/docs/shell-integration/bashrc-additions.sh
```

**After adding, reload your shell:**
```bash
source ~/.zshrc  # or source ~/.bashrc
```

**Verify installation:**
```bash
# Shell integration should be active (no output needed)
# Just start using commands and blocks will be created automatically
```

## Choosing Between Terminal and Blocks Mode

### When to Use Terminal Mode

Terminal Mode is the default and provides traditional terminal emulation:

**Best for:**
- SSH sessions to remote servers
- Text editors (vim, nano, emacs)
- Interactive tools (top, htop, less, more, man)
- Full-screen TUI applications
- Commands that need cursor control
- Programs that require raw terminal input

**Example Commands:**
```bash
ssh user@server
vim config.yaml
top
less /var/log/syslog
python  # interactive REPL
```

### When to Use Blocks Mode

Blocks Mode provides a Warp-inspired interface with organized command history:

**Best for:**
- Simple shell commands (ls, grep, find, cat)
- Building repeatable workflows
- Viewing and organizing command history
- Bookmarking frequently-used commands
- Clean presentation of command outputs
- Copy/paste workflows

**Example Commands:**
```bash
ls -la
git status
docker ps
kubectl get pods
curl https://api.example.com/status
grep -r "TODO" src/
```

**Important Limitation:**
Interactive commands (SSH, vim, top, etc.) do not work in Blocks Mode. The input editor is designed for simple command entry, not full terminal emulation. Always use Terminal Mode for interactive programs.

### Switching Between Modes

You can switch modes at any time:

1. Look for the toggle buttons at the top of each terminal tab
2. Click **Terminal** to switch to traditional mode
3. Click **Blocks** to switch to blocks mode
4. All command history is preserved when switching
5. Mode preference is per-tab (different tabs can use different modes)

**Example Workflow:**
- Start in Terminal Mode to SSH into a server
- Configure server interactively using vim
- Switch to Blocks Mode to view command history
- Bookmark useful commands for next time
- Switch back to Terminal Mode for another SSH session

## Using Command Blocks

### Blocks Mode Interface

When you switch to Blocks Mode, you'll see:

1. **Command History Area**: Completed command blocks displayed at the top
2. **Input Editor**: Text area at the bottom for entering new commands
3. **Mode Toggle**: Buttons to switch between Terminal and Blocks modes

### Block Operations

**Collapse/Expand**
- Click the block header to toggle visibility
- Collapsed blocks show a line count hint (e.g., "15 lines")
- Useful for managing screen space with long outputs

**Bookmark Commands**
- Click the ★ button in the block actions
- Bookmarked blocks persist across sessions
- Access bookmarked commands via Command Palette (Cmd+K)
- Great for frequently-used commands

**Rerun Commands**
- Click the ↻ button to execute the command again
- Creates a new block with the same command
- Original block is preserved in history

**Copy Output**
- Click the 📋 button to copy output to clipboard
- Copies raw text without ANSI escape sequences
- Perfect for pasting into documentation or tickets

**Block Metadata**
Each block shows:
- Command text
- Working directory (cwd)
- Exit code (0 = success, non-zero = failure)
- Duration (execution time in milliseconds)
- Timestamp (when command started)

### Input Editor (Blocks Mode)

The input editor at the bottom provides command entry:

**Basic Usage**
- Type your command in the text area
- Press Enter to execute
- Press Shift+Enter for multi-line commands

**Command History Navigation**
- Press Up Arrow to cycle through previous commands
- Press Down Arrow to move forward in history
- History is session-specific

**Keyboard Shortcuts**
- `Ctrl+C` (empty input): Clear current input
- `Ctrl+D` (empty input): Send EOF signal
- `Enter`: Execute command
- `Shift+Enter`: Insert newline

### Split Panes

Create multiple terminal views within a single tab for side-by-side work.

### Quick Start

- **Cmd+D**: Split vertically (new pane on right)
- **Cmd+Shift+D**: Split horizontally (new pane below)
- **Cmd+W**: Close focused pane
- **Click pane**: Focus it (blue border indicator)
- **Drag divider**: Resize panes proportionally

### Navigation

- **Cmd+Alt+Arrow keys**: Move focus between panes
- **Click**: Direct focus to specific pane

### Use Cases

**Side-by-Side Comparison**: Compare local and remote environments by splitting vertically.

**Multi-Server Monitoring**: Create a grid layout to monitor logs from multiple servers.

**Development + Output**: Horizontal split with code editor on top, test runner below.

See [SPLIT_PANES.md](SPLIT_PANES.md) for detailed usage, examples, and architecture.

## Command Palette

Press `Cmd+K` (or `Ctrl+K` on Windows/Linux) to open the universal command launcher:

**Features**
- **Recent Commands**: Last 20 commands from current tab (📋 icon)
- **Bookmarked Commands**: All bookmarked blocks (⭐ icon)
- **Actions**: Built-in actions like "New Tab", "Search History" (⚙️ icon)
- **Fuzzy Search**: Type to filter, matches partial text intelligently

**Navigation**
- `↑/↓`: Navigate items
- `Enter`: Execute selected command or action
- `Esc`: Close palette

**Search Examples**
```
git st       → matches "git status"
ssh prod     → matches "ssh user@prod-server"
ans play     → matches "ansible-playbook site.yml"
```

**Tips**
- Works in both Terminal and Blocks modes
- Searches both command text and working directory
- Commands execute in the current tab's context
- Bookmarks persist across application restarts

## AI Features

### AI Chat Panel

The AI chat panel provides conversational assistance for network engineering tasks.

**Opening the panel:**
- Click the chat icon in the tab bar
- Press `Cmd/Ctrl+Shift+A`

**Using the chat:**
1. Type your question or request
2. Press Enter or click "Send"
3. AI response streams in real-time
4. Chat history is preserved per tab

#### Voice dictation

The Agent panel microphone can turn speech into an editable message using local
Whisper transcription:

1. Open the Agent panel on an active tab.
2. Click the microphone button to start recording.
3. Speak normally.
4. Click the microphone again to stop and insert the transcript.
5. Review or edit the transcript, then press Enter or click **Send**.

Voice dictation does not send automatically. Existing text is preserved when
dictation starts. The first use may trigger a microphone permission prompt. If
access is denied or speech input is unavailable, the normal typed composer
remains available. TerminAI includes a local Whisper model; advanced users can
set `TERMINAI_WHISPER_MODEL` to test another ggml model file.

**Example prompts:**
- "Explain BGP route reflection"
- "How do I configure OSPF on Cisco IOS?"
- "What's the difference between MPLS L2VPN and L3VPN?"

### Natural Language Commands

Convert natural language to shell commands instantly.

**How to use:**
1. Type `>` at the start of your input
2. Enter your request in natural language
3. AI generates the appropriate command
4. Review and press Enter to execute

**Examples:**
```
> list all files modified in the last 24 hours
→ find . -type f -mtime -1

> show network interfaces with their IP addresses
→ ip addr show

> find large files over 100MB
→ find . -type f -size +100M

> backup the config directory to a tar.gz
→ tar -czf config-backup-$(date +%Y%m%d).tar.gz config/
```

### Error Explanation

When a command fails (non-zero exit code), click the "Ask AI" button on the command block to get:
- Explanation of why the command failed
- Suggested fix or alternative command
- Click the suggestion to insert it into the terminal

## Skills System

Skills are reusable AI workflows with custom prompts and optional helper scripts.

### What are Skills?

A skill consists of:
- **Name**: Unique identifier
- **Description**: What the skill does
- **When to Use**: Matching patterns and triggers
- **Playbook**: Detailed instructions for the AI
- **Scripts**: Optional helper scripts (bash, python, etc.)

### Viewing Skills

1. Click the "Skills" icon in the tab bar
2. Browse available skills
3. Click a skill to see details
4. Use the search bar to find skills

### Using Skills

**Automatic invocation:**
When you chat with the AI, it automatically matches your query against skills and invokes relevant ones.

**Manual invocation:**
1. Open the Skills panel
2. Click "Invoke" on a skill
3. Provide any required arguments
4. Review the AI's response

### Creating Skills

Use the skill creation wizard to build custom skills:

1. Click "Create Skill" in the Skills panel
2. Choose creation mode:
   - **Guided Wizard**: Step-by-step prompts
   - **Natural Language**: Describe what you want
3. Fill in the skill details
4. Add helper scripts if needed
5. Review and save

**Example skill:**
```markdown
# Name
cisco_config_backup

# Description
Backup Cisco device configuration via SSH

# When to Use
- User asks to backup a Cisco device
- User mentions "save config" or "backup config"

# Playbook
1. Ask user for device IP/hostname
2. Ask for credentials (or use stored credentials)
3. Execute the backup script with provided details
4. Confirm success and show backup location

# Scripts
- backup.sh: SSH to device and run "show running-config"
```

### Skill Scripts

Skills can include executable scripts that the AI can invoke:

- **Python scripts**: `.py` files
- **Bash scripts**: `.sh` files
- **Any executable**: With proper shebang

Scripts are stored in `~/.config/ccie-terminal/skills/<skill-name>/` and are automatically made executable on Unix systems.

## MCP Integration

Model Context Protocol (MCP) enables CCIE Terminal to use external tools and services.

### Adding MCP Servers

1. Open Settings (⚙ icon)
2. Navigate to "MCP Servers" tab
3. Click "Import from JSON"
4. Paste server configuration

**Format for stdio servers:**
```json
{
  "name": "filesystem",
  "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/dir"],
  "env": {
    "OPTIONAL_VAR": "value"
  }
}
```

**Format for SSE servers:**
```json
{
  "name": "remote-api",
  "transport": "sse",
  "url": "https://mcp-server.example.com/sse"
}
```

### Claude Desktop Compatibility

You can directly import from your Claude Desktop config:

1. Open `~/.config/claude/config.json`
2. Copy the `mcpServers` section
3. Paste into CCIE Terminal's import dialog

### Managing Servers

- **Enable/Disable**: Toggle servers without deleting them
- **Remove**: Delete server configuration
- **View Tools**: See available tools from each server
- **Test Connection**: Verify server is accessible

### Tool Approval Policies

Control how MCP tools are invoked:

- **Auto Allow**: Always execute without prompting
- **Confirm**: Ask every time
- **Confirm Once**: Remember decision for session
- **Deny**: Never execute

Set policies in Settings > MCP Servers > Server > Policies.

## Search

Full-text search across all your terminal data.

### Opening Search

- Click the search icon in the tab bar
- Press `Cmd/Ctrl+F`

### Search Categories

1. **Commands**: Search command history
   - Finds commands and their output
   - Shows exit codes and timestamps
   - Click to view full command block

2. **AI Messages**: Search AI conversations
   - Searches both user messages and AI responses
   - Highlights matching context
   - Jump to original conversation

3. **Skills**: Search skill definitions
   - Searches names, descriptions, and playbooks
   - Quick access to skill details
   - Invoke directly from search results

### Search Syntax

Basic search uses FTS5 full-text search:
```
# Simple term
ping

# Multiple terms (AND)
ping google

# Phrase search
"show ip route"

# Prefix search
config*

# Boolean operators
ssh OR telnet
cisco NOT juniper
```

### Search Results

Results show:
- Matching snippet with highlights
- Timestamp and context
- Click to view full content
- Keyboard navigation (↑/↓)

## Session Management

Save and restore complete terminal sessions including tabs, scrollback, and AI history.

### Auto-Save on Exit

CCIE Terminal automatically saves your session when you close the app. On next launch, all tabs and state are restored.

To disable auto-restore:
```toml
# ~/.config/ccie-terminal/config.toml
[general]
restore_on_launch = false
```

### Named Sessions

Save specific workspace states:

1. Click "Sessions" in the tab bar
2. Click "Save Current Session"
3. Enter name and description
4. Session is saved with all open tabs

### Loading Sessions

1. Open Sessions panel
2. Browse saved sessions
3. Click "Load" to restore
4. Option to replace current tabs or merge

### Exporting Sessions

Export sessions as JSON for backup or sharing:

1. Open Sessions panel
2. Click "Export" on a session
3. Save JSON file
4. Import on another machine or CCIE Terminal installation

### Session Contents

Each saved session includes:
- All open tabs with titles and working directories
- Complete scrollback buffer for each tab
- AI chat history for each tab
- Command blocks with timestamps and exit codes
- Active tab selection

## Configuration

### Configuration Files

- **config.toml**: LLM profiles and application settings
- **.env**: API keys and secrets
- **sessions.db**: SQLite database with all data

Located at `~/.config/ccie-terminal/` (Linux/macOS) or `%APPDATA%\ccie-terminal\` (Windows).

### LLM Profiles

Define multiple AI model configurations:

```toml
[profiles.fast]
provider = "anthropic"
model = "claude-sonnet-4-6"

[profiles.smart]
provider = "anthropic"
model = "claude-opus-4-7"

[profiles.local]
provider = "ollama"
model = "llama3.3"
host = "http://localhost:11434"
```

Switch profiles in Settings or per-conversation.

### General Settings

```toml
[general]
# Restore tabs on launch (default: true)
restore_on_launch = true

# Max scrollback per tab (bytes)
max_scrollback_bytes = 10485760  # 10 MB
```

### Update a Cisco agent’s APIs

Open **Settings → Cisco → the product → Update APIs**. Each product’s button checks only its own published API references and adds compatible, newly documented operations to that installed agent’s catalog. It does not execute those operations or change connection settings, prompts, existing entries, or other products. Save and Test Connection remain separate actions.

The page shows progress, added/already-known/skipped counts, warnings, checked sources and the latest check time. One update runs at a time; switching pages does not cancel it, and returning to the product resumes status polling. Job status is reset if the sidecar restarts. Start a **new agent run** after an update to use additions.

Public-reference coverage is partial: login-only/client-rendered pages, unsupported schema references or formats, and scan limits can leave APIs undiscovered. Prose extraction uses your configured AI provider, may incur provider usage charges, and requires supporting input/authentication evidence; it is not deterministic specification verification. A completed check does not establish full product coverage, installed-version compatibility, or the permissions of your saved account. New authentication, uploads or transports still require an integration change. In particular, ThousandEyes retains its existing GET-only scope and Secure Endpoint v3 is not imported.

Publication preserves a managed last-known-good backup beside the selected catalog (`<catalog filename>.api-update-backup.json`). A fetch, validation or concurrent-edit failure leaves that catalog unchanged; unrelated files are never treated as updater backups.

### Live Reloading

Both `config.toml` and `.env` are watched for changes. Edits take effect immediately without restarting CCIE Terminal.

## Keyboard Shortcuts

### Terminal

| Shortcut | Action |
|----------|--------|
| `Cmd/Ctrl+T` | New tab |
| `Cmd/Ctrl+W` | Close tab or focused pane |
| `Cmd/Ctrl+1-9` | Switch to tab N |
| `Cmd/Ctrl+Tab` | Next tab |
| `Cmd/Ctrl+Shift+Tab` | Previous tab |

### Split Panes

| Shortcut | Action |
|----------|--------|
| `Cmd/Ctrl+D` | Split current pane vertically |
| `Cmd/Ctrl+Shift+D` | Split current pane horizontally |
| `Cmd/Ctrl+W` | Close focused pane |
| `Cmd/Ctrl+Alt+↑` | Focus pane above |
| `Cmd/Ctrl+Alt+↓` | Focus pane below |
| `Cmd/Ctrl+Alt+←` | Focus pane to the left |
| `Cmd/Ctrl+Alt+→` | Focus pane to the right |

### Features

| Shortcut | Action |
|----------|--------|
| `Cmd/Ctrl+K` | Open command palette |
| `Cmd/Ctrl+F` | Open search |
| `Cmd/Ctrl+Shift+A` | Toggle AI chat panel |
| `Cmd/Ctrl+,` | Open settings |
| `Escape` | Close panels/modals |

### Terminal Input (Terminal Mode)

| Shortcut | Action |
|----------|--------|
| `>` (at start) | Natural language command mode |
| `Cmd/Ctrl+C` | Interrupt current command |
| `Cmd/Ctrl+D` | Send EOF |
| `Cmd/Ctrl+L` | Clear terminal |

### Input Editor (Blocks Mode)

| Shortcut | Action |
|----------|--------|
| `Enter` | Execute command |
| `Shift+Enter` | Insert newline (multi-line) |
| `Ctrl+C` | Clear input (if empty) |
| `Ctrl+D` | Send EOF (if empty) |
| `↑` | Previous command in history |
| `↓` | Next command in history |

### Block Navigation (Blocks Mode)

Walk between blocks and act on the focused one without leaving the keyboard. The `⌘K` chord has a 1.5 s timeout — press the second key within the window or `Esc` to cancel.

| Shortcut | Action |
|----------|--------|
| `⌘/Ctrl+↑` | Focus previous block |
| `⌘/Ctrl+↓` | Focus next block |
| `⌘/Ctrl+K` then `B` | Toggle collapse on focused block |
| `⌘/Ctrl+K` then `P` | Toggle pin on focused block |
| `⌘/Ctrl+K` then `T` | Add a tag to focused block |
| `⌘/Ctrl+K` then `S` | Create / copy `ccie-terminal://block/<id>` deep-link share |
| `Esc` | Cancel a pending `⌘K` chord |

Shortcuts only fire while the active tab is in **Blocks Mode**, and `⌘K` is suppressed inside text inputs so typing is never hijacked.

### Command Palette

| Shortcut | Action |
|----------|--------|
| `Cmd/Ctrl+K` | Open palette |
| `↑/↓` | Navigate items |
| `Enter` | Execute selected item |
| `Escape` | Close palette |
| Type to search | Fuzzy filter items |

### Search

| Shortcut | Action |
|----------|--------|
| `↑/↓` | Navigate results |
| `Enter` | Open selected result |
| `Escape` | Close search |

## Troubleshooting

### AI is not responding

**Check API key:**
```bash
cat ~/.config/ccie-terminal/.env
```

Ensure your API key is set and valid.

**Check profile configuration:**
```bash
cat ~/.config/ccie-terminal/config.toml
```

Verify the profile exists and provider is correct.

**Check Python sidecar:**
```bash
# In development mode, check terminal output for errors
# Look for Python exceptions or API errors
```

### Shell integration not working

**Verify installation:**
```bash
cat ~/.zshrc | grep ccie
# or
cat ~/.bashrc | grep ccie
```

**Reinstall integration:**
1. Locate the shell integration scripts in `docs/shell-integration/`
2. Add the source line to your shell RC file
3. Restart your shell: `exec $SHELL`

**For Zsh:**
```bash
# Add to ~/.zshrc
source /path/to/ccie-terminal/docs/shell-integration/zshrc-additions.sh
```

**For Bash:**
```bash
# Add to ~/.bashrc
source /path/to/ccie-terminal/docs/shell-integration/bashrc-additions.sh
```

### Blocks not appearing in Blocks Mode

1. **Verify shell integration is active** (see above)
2. **Switch to Blocks Mode** using the toggle button
3. **Run a simple command** like `ls` or `echo hello`
4. **Check that OSC 133 sequences are being emitted** by the shell

### Interactive commands not working

If commands like SSH, vim, or top aren't working:

**Solution**: Switch to Terminal Mode
1. Click the "Terminal" toggle button at the top of the tab
2. Terminal Mode provides full PTY access for interactive programs
3. Blocks Mode only supports simple, non-interactive commands

**Why**: The input editor in Blocks Mode is designed for simple command entry, not full terminal emulation. Interactive programs require cursor control and raw terminal access that only Terminal Mode provides.

### Command Palette not opening

**Check keyboard shortcut:**
- macOS: `Cmd+K`
- Windows/Linux: `Ctrl+K`

**Troubleshooting:**
1. Ensure no other application is capturing the shortcut
2. Check that CCIE Terminal window is focused
3. Try clicking directly in the terminal area first
4. Check browser console for errors (dev mode)

### Tabs not restoring on launch

**Check setting:**
```toml
# ~/.config/ccie-terminal/config.toml
[general]
restore_on_launch = true
```

**Check database:**
```bash
# Verify database exists
ls -lh ~/.config/ccie-terminal/sessions.db
```

If corrupted, backup and delete to reset.

### MCP servers not connecting

**For stdio servers:**
- Verify command is in PATH
- Check environment variables are set
- Enable server in Settings

**For SSE servers:**
- Verify URL is accessible
- Check for CORS issues
- Ensure server is running

**View logs:**
Check the terminal output in development mode for connection errors.

### Search returns no results

**Rebuild FTS5 index:**
```sql
-- Connect to database
sqlite3 ~/.config/ccie-terminal/sessions.db

-- Rebuild command_blocks index
DELETE FROM command_blocks_fts;
INSERT INTO command_blocks_fts(rowid, cmd, output)
  SELECT rowid, cmd, output FROM command_blocks;

-- Rebuild ai_messages index
DELETE FROM ai_messages_fts;
INSERT INTO ai_messages_fts(rowid, content)
  SELECT rowid, content FROM ai_messages;
```

### Performance issues

**Reduce scrollback limit:**
```toml
[general]
max_scrollback_bytes = 5242880  # 5 MB
```

**Clear old sessions:**
Delete unused saved sessions in the Sessions panel.

**Vacuum database:**
```bash
sqlite3 ~/.config/ccie-terminal/sessions.db 'VACUUM;'
```

## Building a Meraki Agent

TerminAI ships with full-coverage CLI integration for the Cisco Meraki Dashboard API. Build custom agents that can query and manage your Meraki infrastructure using natural language.

### Setup

**1. Configure AI Provider**

Meraki agents use the ReACT (Reasoning and Acting) pattern, which requires tool-calling support.

Open Settings → General and configure any provider that supports tool calling:
- **Anthropic**: claude-sonnet-4-6 or claude-opus-4-7
- **OpenAI**: gpt-4o, gpt-4-turbo, or gpt-3.5-turbo
- **vLLM**: Any model with tool calling (e.g., Gemma 4)
- **Google Gemini**: Coming soon
- **Ollama**: Coming soon (requires tool-calling models)

> **Note**: Tool-calling support is required. Most modern LLMs support this feature.

**2. Add Your Meraki API Key**

The Meraki agent is pre-configured and bundled with TerminAI. You only need to add your API key:

Open Settings → Vault and add:

- **Name**: `meraki_api_key`
- **Type**: `api_key`
- **Value**: Your Dashboard API key from Organization → Settings → Dashboard API access

That's it! The agent will appear in the Agents menu automatically.

## Customizing the Agent (Optional)

If you want to customize the bundled agent or create your own, here's how:

**Create Custom Agent Definition**

Create a file at `~/.ccie-terminal/agents/my-custom-meraki/AGENT.md`:

```yaml
---
name: my-meraki-agent
description: Cisco Meraki dashboard expert - query and manage networks, devices, and configurations
system-prompt: |
  You are a Cisco Meraki dashboard expert. Use the meraki tools to answer
  questions about organizations, networks, devices, and configurations.
  
  Always confirm before making changes. When listing items, provide useful
  context like network names, device models, and status information.
  
  For ambiguous requests, ask clarifying questions about specific network IDs
  or device serials before proceeding.

attached-tools:
  - id: meraki
    catalog: <path-to-terminai>/bundled-agents/meraki/tools.json
    default-blast-radius-allowed: low  # Auto-approve reads, gate writes
    vault-entry: meraki_api_key

allowed-commands: []
---

# Meraki Dashboard Agent

Natural language interface to your Meraki infrastructure.

## Capabilities

- List organizations, networks, and devices
- Query network configuration and settings
- View client information and traffic data
- Check device status and health
- Update configurations (with approval)
- Manage SSIDs, VLANs, and firewall rules (with approval)

## Example Queries

- "Show me all my organizations"
- "How many devices are in the main office network?"
- "List all clients connected in the last hour"
- "What's the configuration of the guest WiFi SSID?"
- "Update the office network timezone to America/New_York"
```

**Restart TerminAI**

Your custom agent will appear in the Agents menu after restarting.

### Blast Radius Tiers

The Meraki agent automatically classifies all operations by risk level:

| Tier | Description | Auto-Approve? | Examples |
|------|-------------|---------------|----------|
| **low** | Read-only operations (GET) | Yes | List organizations, get network details, view devices |
| **medium** | Minor configuration changes | Requires approval | Update network name, create VLAN |
| **high** | Sensitive configuration | Requires approval | Update firewall rules, modify group policies |
| **critical** | Destructive operations (DELETE) | Requires approval | Delete network, remove admin |

**Configuring Auto-Approval:**

The `default-blast-radius-allowed` setting controls which operations execute automatically:

```yaml
default-blast-radius-allowed: low    # Only auto-approve reads (recommended)
default-blast-radius-allowed: medium # Auto-approve reads + minor writes
default-blast-radius-allowed: high   # Auto-approve everything except deletes (dangerous)
```

### Example Queries

**Read Operations (auto-approved):**
- "List my organizations"
- "Show me all networks in the main org"
- "How many devices do I have?"
- "What clients are connected to the office network?"
- "Show me the configuration for SSID 0"

**Write Operations (require approval):**
- "Update the office network name to 'Main Office'"
- "Enable the guest SSID"
- "Change the timezone for the branch network"
- "Create a new VLAN on the office network"

**Destructive Operations (always require approval):**
- "Delete the old test network"
- "Remove admin user john@example.com"

### Agent Behavior

**Disambiguation:**

If your request is ambiguous, the agent will ask for clarification:

```
You: "Show me network status"
Agent: "I found 5 networks in your organization. Which one would you like 
       to see? Main Office, Branch 1, Branch 2, Guest, or Test?"
```

**Context Tracking:**

The agent remembers recent operations within a conversation:

```
You: "List networks in my main org"
Agent: "Found 3 networks: Office (N_123), Branch (N_456), Guest (N_789)"

You: "Show me devices in the Office network"
Agent: [Uses N_123 from previous response without asking]
```

**Approval Flow:**

For operations requiring approval, the agent will show a modal with:
- Command being executed
- Arguments and values
- Blast radius tier
- Expected impact
- Options: Approve, Approve for Session, Deny

### Troubleshooting

**Agent not appearing in menu:**
- Verify AGENT.md is in `~/.ccie-terminal/agents/<name>/`
- Check YAML frontmatter is valid
- Restart TerminAI

**Authentication errors:**
- Verify API key is set in Vault with matching name
- Test key works: `curl -H "X-Cisco-Meraki-API-Key: YOUR_KEY" https://api.meraki.com/api/v1/organizations`
- Regenerate key from Dashboard if expired

**Agent says "I don't have access to Meraki tools":**
- Verify tool catalog exists at path specified in AGENT.md
- Regenerate catalog: `python -m ccie_sidecar.meraki_cli list-commands > ~/.terminai/meraki-tools.json`
- Check JSON is valid: `jq . ~/.terminai/meraki-tools.json`

**Approval requests not showing:**
- Frontend approval modal is available in current version
- Check Settings → Security for approval policy configuration

### Further Reading

- [MERAKI_CLI.md](MERAKI_CLI.md) - Complete CLI reference and examples
- [APPROVAL_INTEGRATION.md](/sidecar/APPROVAL_INTEGRATION.md) - Approval system details
- [Meraki Dashboard API Docs](https://developer.cisco.com/meraki/api-v1/) - Official API reference

## Configuration intent + drift detection

Declare the intended config for each device — golden running-config or Jinja
template — then detect when the live config drifts. Open via **Drift → Open
Drift Sidebar** or `⌘⇧D`.

| Hotkey | Action |
|---|---|
| `⌘⇧D` | Open drift sidebar |

Set up intents under **Drift → Manage Intent Templates...**. Each intent
has a vendor/platform pair (drives normalizer rules), a body (golden
config or Jinja template), optional YAML vars, and a selector (tags or
explicit device IDs). Run drift on-demand or on a cron schedule. Drift
reports auto-generate a remediation patch reviewable in Monaco; the push
itself is gated by Plan 09. See `docs/DRIFT.md` for the full reference.

## Multi-device fan-out

Fan-out lets you execute one read-only command across up to 50 SSH/NETCONF
devices simultaneously. Open via **Fan-Out → Open Fan-Out Panel** or `⌘⇧F`.

| Hotkey | Action |
|---|---|
| `⌘⇧F` | Open fan-out panel |
| `⌘.`  | Cancel all in-flight devices |
| `⌘R`  | Retry every failed/timed-out device |
| `⌘E`  | Export active run as zip |

Build groups under **Fan-Out → Manage Device Groups...** — pick from saved
SSH/NETCONF connections or paste a CSV. The merged view auto-detects
single-device outliers (1 of 50 with `state=Idle`) and surfaces them in a
banner above the diff. See `docs/FANOUT.md` for the full reference.

### RAG library

Upload vendor PDFs / HTML / Markdown / TXT into Settings → RAG and the
AI assistant will cite them inline on every chat turn. Vendor-aware
filtering kicks in automatically when a tab has an active SSH session.
Full guide: [`docs/rag/USER_GUIDE.md`](./rag/USER_GUIDE.md).

### Getting help

1. Check this guide and other documentation
2. Search existing GitHub issues
3. Open a new issue with:
   - CCIE Terminal version
   - Operating system
   - Steps to reproduce
   - Error messages or logs
   - Configuration (sanitized, no API keys)

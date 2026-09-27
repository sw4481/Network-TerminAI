# Phase 3: Natural Language to Command Translation

## Overview

Phase 3 implements natural language to command translation, allowing users to type `# <description>` in the terminal, which is then automatically translated into a shell command using AI.

## Usage

1. Type `#` followed by a space and your natural language description
2. Press Enter
3. The system will translate your description to a shell command
4. The command appears in the terminal input buffer (NOT executed)
5. Review the command and press Enter again to execute it

### Examples

```bash
# list files
# Translates to: ls -la

# find python files
# Translates to: find . -name "*.py"

# show disk usage
# Translates to: df -h

# check running processes
# Translates to: ps aux
```

## Architecture

### Frontend (`src/hooks/usePty.ts`)

- Intercepts terminal input via xterm.js `onData` handler
- Tracks the current line being typed
- Detects `# ` prefix on Enter keypress
- Calls backend `agent_nl_to_command` API
- Shows "Translating..." indicator
- Replaces the input with the generated command

### Backend (`src-tauri/src/commands.rs`)

- `agent_nl_to_command` Tauri command
- Takes: nl_query, shell, cwd
- Calls sidecar via AgentBridge
- Returns generated command string

### Sidecar (`sidecar/src/ccie_sidecar/`)

**Agent (`agent.py`):**
- `nl_to_command()` function
- Builds context-aware system prompt with shell type, cwd, OS
- Calls Anthropic API (non-streaming)
- Cleans up response (removes markdown, backticks)

**Server (`server.py`):**
- Handles `nl_to_command` JSON-RPC method
- Validates parameters
- Returns `{"command": "..."}`

**Provider (`providers/anthropic.py`):**
- `complete()` function for non-streaming calls
- Maps friendly model names to API model names
- Error handling for auth, rate limits, API errors

## Configuration

Requires `ANTHROPIC_API_KEY` environment variable set.

Supports profile-based model selection:
- `default`: claude-sonnet-4-6
- `quality`: claude-opus-4-7
- `budget`: claude-haiku-4-5

## Safety

- Commands are NEVER auto-executed
- User must review and press Enter to run
- AI is instructed to avoid destructive commands without confirmation
- Input is only intercepted on Enter, not during typing

## Testing

Run tests:
```bash
cd sidecar
.venv/bin/pytest tests/test_nl_to_command.py -v
```

Integration test requires `ANTHROPIC_API_KEY` set.

## Future Enhancements

- Command history/suggestions based on previous translations
- Multi-line command support
- Context from previous commands
- Custom system prompts per shell
- Local model support (vLLM, Ollama)

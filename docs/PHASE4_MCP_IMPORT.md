# Phase 4: MCP Server JSON Import

This document describes the MCP server configuration import feature added in Phase 4.

## Overview

Users can now import MCP server configurations by pasting JSON directly into the Settings UI. This supports multiple configuration formats including:

1. Simple single-server configs
2. Claude Desktop's `config.json` format
3. SSE (Server-Sent Events) transport configs
4. Arrays of server configs

## File Structure

### New Files

- `src/lib/mcpConfigParser.ts` - Parser library for MCP server configs
- `src/lib/mcpConfigParser.test.ts` - Comprehensive test suite (24 tests)
- `src/components/ImportMcpServer.tsx` - Import modal component
- `src/windows/Settings.tsx` - Settings window with MCP management
- `docs/PHASE4_MCP_IMPORT.md` - This documentation

### Modified Files

- `src/App.css` - Added styles for Settings window and Import modal
- `vite.config.ts` - Added vitest test configuration
- `package.json` - Added test scripts and vitest dependencies

## Supported JSON Formats

### Format 1: Simple stdio Server

```json
{
  "name": "filesystem",
  "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/dir"],
  "env": {
    "NODE_ENV": "production"
  }
}
```

### Format 2: SSE Server

```json
{
  "name": "remote-tools",
  "transport": "sse",
  "url": "https://mcp-server.example.com/sse"
}
```

### Format 3: Claude Desktop Format

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "$HOME/Documents"]
    },
    "git": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-git", "$HOME/projects"],
      "env": {
        "GIT_AUTHOR_NAME": "Claude"
      }
    }
  }
}
```

### Format 4: Array of Servers

```json
[
  {
    "name": "server1",
    "command": "node",
    "args": ["server1.js"]
  },
  {
    "name": "server2",
    "transport": "sse",
    "url": "https://example.com/sse"
  }
]
```

## User Workflow

1. Open Settings window
2. Navigate to "MCP Servers" tab
3. Click "Import from JSON"
4. Paste JSON configuration
5. Click "Parse" to validate and preview
6. Edit server details if needed (name, command, args, env)
7. Click "Import" to save servers

## Parser Features

The `mcpConfigParser.ts` module provides:

- **Auto-detection**: Automatically detects which JSON format is being used
- **Validation**: Validates required fields for each transport type
- **Error handling**: Clear error messages for malformed configs
- **Flexible input**: Handles both stdio and SSE transports
- **Batch import**: Supports importing multiple servers at once

## Import Modal Features

The `ImportMcpServer.tsx` component provides:

- **Two-step process**: Parse first, then edit/review before import
- **Live editing**: Modify server configs before importing
- **Environment variables**: Add/edit/remove env vars with UI
- **Validation feedback**: Clear error messages for invalid configs
- **Warning display**: Shows partial success warnings

## Testing

Run the test suite:

```bash
bun test
# or
npm test
```

Run tests in watch mode:

```bash
bun run test:watch
# or
npm run test:watch
```

The test suite includes 24 tests covering:
- Simple stdio configs
- SSE configs
- Claude Desktop format
- Array format
- Error handling
- Validation logic

## Backend Integration

The Settings component uses the following Tauri commands (already implemented):

- `mcp_list_servers()` - List all configured servers
- `mcp_add_server()` - Add a new server
- `mcp_remove_server()` - Remove a server
- `mcp_update_server_enabled()` - Toggle server on/off

## Styling

The UI follows Warp's dark theme aesthetic:

- Dark backgrounds (#0f1114, #0a0c0f)
- Subtle borders (#262a33)
- Blue accents (#2d5a8c)
- Code editor styling for JSON input
- Clear visual hierarchy with typography

## Future Enhancements

Potential improvements for future phases:

- Export server configs to JSON
- Validate MCP server connection on import
- Import from file upload
- JSON schema validation with autocomplete
- Duplicate server detection
- Bulk enable/disable operations

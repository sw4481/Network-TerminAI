# MCP Server Setup Guide

## Overview

CCIE Terminal Phase 4 implements Model Context Protocol (MCP) server management through a Settings UI.

## Features

### Server Management
- Add MCP servers via JSON import (Claude Desktop format or simple config)
- Support for stdio and SSE transports
- Enable/disable servers
- Remove servers
- View server configuration details

### Transport Types

#### stdio
For local MCP servers that communicate via standard input/output:
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

#### SSE (Server-Sent Events)
For remote MCP servers over HTTP:
```json
{
  "name": "remote-tools",
  "transport": "sse",
  "url": "https://mcp-server.example.com/sse"
}
```

## Using the Settings UI

1. Open Settings by clicking the ⚙ icon in the tab bar
2. Navigate to the "MCP Servers" tab
3. Click "Import from JSON" to add servers
4. Paste your configuration (supports Claude Desktop config.json format)
5. Review and edit the parsed configuration
6. Click "Import" to save

## Claude Desktop Format

You can directly copy your `~/.config/claude/config.json` mcpServers section:

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "$HOME/Documents"]
    },
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": {
        "GITHUB_TOKEN": "your-token"
      }
    }
  }
}
```

## Database Schema

### mcp_servers
- `id`: Unique server ID (UUID)
- `name`: Human-readable server name
- `transport`: "stdio" or "sse"
- `command_json`: JSON object with `cmd` and `args` for stdio
- `url`: Endpoint URL for SSE servers
- `env_json`: Environment variables as JSON object
- `enabled`: Boolean flag for enable/disable
- `created_at`: Unix timestamp

### approval_policies
- `server_name`: Server name (FK)
- `tool_name`: Tool name
- `policy`: "auto_allow", "confirm", "confirm_once", "deny"
- `scope`: "global" or "session"
- `created_at`, `updated_at`: Timestamps

### approval_memory
- Records user decisions for "confirm_once" policies
- `server_name`, `tool_name`: Composite primary key
- `decision`: "allow" or "deny"
- `remembered_at`: Unix timestamp

## Backend Commands

All commands are prefixed with `mcp_`:

- `mcp_list_servers()` - Get all configured servers
- `mcp_add_server(name, transport, command_json, url, env_json)` - Add new server
- `mcp_remove_server(id)` - Delete a server
- `mcp_update_server_enabled(id, enabled)` - Enable/disable server
- `mcp_test_connection(id)` - Test server connection (stub for now)
- `mcp_list_policies(server_name)` - Get tool policies for a server
- `mcp_set_policy(server_name, tool_name, policy)` - Set tool approval policy

## Next Steps (Phase 5+)

- Implement actual MCP server spawning and lifecycle management
- Tool invocation with approval gating
- Policy management UI
- Server connection testing
- Tool introspection and display
- Session persistence for ConfirmOnce policies

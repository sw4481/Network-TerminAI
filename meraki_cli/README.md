# terminai-meraki

Full-coverage Meraki Dashboard API CLI that integrates with TerminAI's ReACT agent system.

## Overview

`terminai-meraki` wraps all 933 endpoints of the Cisco Meraki Dashboard API v1, providing:

- **Standalone CLI** for command-line automation and scripting
- **Python API** for programmatic access
- **ReACT Agent Integration** with natural language interface via Claude AI
- **Blast-Radius Gating** for safe approval workflows
- **Tool Catalog Export** for MCP-compatible agent definitions

## Status

**All Phases Complete ✅** (2026-05-24)

- ✅ **Phase 1**: Credentials resolver with vault integration
- ✅ **Phase 2**: Tool catalog generation + blast-radius classifier (933 endpoints)
- ✅ **Phase 3**: ReACT loop with streaming events
- ✅ **Phase 4**: Disambiguation + context tracking
- ✅ **Phase 5**: Approval gating + audit logging
- ✅ **Phase 6**: Documentation + integration guide

## Quickstart

### Installation

The Meraki CLI is included with TerminAI:

```bash
cd /path/to/terminai/meraki_cli
pip install -e .
```

### Set API Key

```bash
# Option 1: Environment variable
export MERAKI_API_KEY=<paste-token-here>

# Option 2: Vault (for agent integration)
# Add via Settings → Vault in TerminAI:
#   Name: meraki_default
#   Type: api_key
#   Value: paste-token-here
```

### CLI Usage

```bash
# List organizations
python -m terminai_meraki.cli.main organizations-list-organizations

# Get network details
python -m terminai_meraki.cli.main networks-get-network \
  --network-id "N_1234567890"

# Output formats: json (default), yaml, table
python -m terminai_meraki.cli.main --format yaml \
  organizations-list-devices --organization-id "O_123"

# Generate tool catalog for agents
python -m terminai_meraki.cli.main list-commands > meraki-tools.json
```

### Agent Integration

Create a Meraki agent by adding this to `~/.ccie-terminal/agents/meraki-agent/AGENT.md`:

```yaml
---
name: meraki-agent
description: Cisco Meraki dashboard expert
system-prompt: |
  You are a Meraki dashboard expert. Use the meraki tools to query
  and manage networks, devices, and configurations.

attached-tools:
  - id: meraki
    catalog: ~/.terminai/meraki-tools.json
    default-blast-radius-allowed: low  # Auto-approve reads only
    vault-entry: meraki_default

allowed-commands: []
---
```

Then generate the catalog:

```bash
python -m terminai_meraki.cli.main list-commands > ~/.terminai/meraki-tools.json
```

Restart TerminAI and your agent will appear in the Agents menu.

### Example Queries

Natural language queries work with the agent:

- "List my organizations"
- "How many devices are in the office network?"
- "Show me clients connected in the last hour"
- "Update the guest network name to 'Visitor WiFi'" *(requires approval)*

## Features

### 933 API Endpoints

Complete coverage of Meraki Dashboard API v1:
- Organizations, networks, devices
- Wireless (SSIDs, RF profiles, air marshal)
- Switch (ports, VLANs, routing)
- Appliance (firewalls, VPN, content filtering)
- Camera, sensor, cellular gateway
- Systems Manager, Insight, licensing

### Blast Radius Tiers

All operations auto-classified by risk:

| Tier | Description | Examples |
|------|-------------|----------|
| **low** | Read-only (GET) | list-organizations, get-network |
| **medium** | Minor config (POST/PUT) | update-network-name, create-vlan |
| **high** | Sensitive config | update-firewall-rules, modify-policies |
| **critical** | Destructive (DELETE) | delete-network, remove-admin |

Agents require approval for operations above the configured threshold.

### ReACT Agent Features

- **Context Tracking**: Remembers org/network/device IDs within conversations
- **Disambiguation**: Asks clarifying questions for ambiguous requests
- **Approval Flow**: Shows approval modal for write/delete operations
- **Audit Logging**: Records all tool calls with timestamps, args, and results
- **Error Handling**: Graceful degradation with helpful error messages

## Development

This package lives at `meraki_cli/` in the TerminAI repository and is consumed in-process by the Python sidecar for zero-overhead agent tool calls.

```bash
# Run tests
cd meraki_cli
pytest

# With coverage
pytest --cov=terminai_meraki --cov-report=html

# Type checking
mypy src/terminai_meraki
```

## Documentation

- [Complete CLI Reference](../docs/MERAKI_CLI.md) - All commands, examples, troubleshooting
- [User Guide](../docs/USER_GUIDE.md#building-a-meraki-agent) - Agent setup tutorial
- [Approval Integration](../sidecar/APPROVAL_INTEGRATION.md) - Approval system details
- [Meraki Dashboard API Docs](https://developer.cisco.com/meraki/api-v1/) - Official API reference

## Architecture

```
┌─────────────────────┐
│   TerminAI Agent    │  Natural language interface
│   (Claude AI)       │
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│   ReACT Loop        │  Reasoning + tool execution
│   (react.py)        │
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│  Meraki CLI Tools   │  933 API endpoints
│  (terminai_meraki)  │
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│  Dashboard API      │  api.meraki.com
│  (REST/JSON)        │
└─────────────────────┘
```

## License

MIT

# Meraki CLI Integration

Complete guide to using TerminAI's Meraki Dashboard API integration with ReACT agents.

## Table of Contents

- [Overview](#overview)
- [Quickstart](#quickstart)
- [CLI Reference](#cli-reference)
- [Common Examples](#common-examples)
- [ReACT Agent Integration](#react-agent-integration)
- [Blast Radius Tiers](#blast-radius-tiers)
- [Troubleshooting](#troubleshooting)

## Overview

TerminAI's Meraki integration provides comprehensive access to the Cisco Meraki Dashboard API through two complementary interfaces:

### What is the Meraki CLI?

The Meraki CLI is a full-coverage command-line interface that wraps all 933 endpoints of the Meraki Dashboard API v1. Each API endpoint becomes a simple CLI command with consistent naming, argument handling, and output formatting.

### Two Ways to Use It

1. **Standalone CLI**: Direct command-line access for scripting and automation
2. **ReACT Agent Integration**: Natural language interface powered by Claude AI

### Key Features

- **Complete API Coverage**: All 933 Dashboard API v1 endpoints
- **Consistent Naming**: `resource-action` convention (e.g., `organizations-list-organizations`)
- **Multiple Output Formats**: JSON (default), YAML, or table format
- **Automatic Pagination**: Built-in handling for large result sets
- **Type Validation**: Parameter validation before API calls
- **Blast Radius Classification**: Auto-categorizes operations by risk level
- **Tool Catalog Export**: Generate MCP-compatible tool definitions for agents

## Quickstart

### Installation

The Meraki CLI module is included with TerminAI. No separate installation needed.

```bash
cd /path/to/terminai/sidecar
source .venv/bin/activate
```

### Set API Key

```bash
# Option 1: Environment variable (for testing)
export MERAKI_API_KEY=<paste-token-here>

# Option 2: Vault storage (recommended for agents)
# Add via Settings → Vault in TerminAI GUI:
#   Name: meraki_default
#   Type: api_key
#   Value: paste-token-here
```

Get your API key from the Meraki Dashboard:
1. Navigate to Organization → Settings → Dashboard API access
2. Click "Generate new API key"
3. Save the key securely

### First Commands

```bash
# List all organizations you have access to
python -m ccie_sidecar.meraki_cli organizations-list-organizations

# List networks in an organization
python -m ccie_sidecar.meraki_cli organizations-list-networks \
  --organization-id "O_1234567890"

# Get network details in YAML format
python -m ccie_sidecar.meraki_cli --format yaml networks-get-network \
  --network-id "N_1234567890"
```

## CLI Reference

### Command Structure

All commands follow the pattern:

```bash
python -m ccie_sidecar.meraki_cli [global-flags] <command> [command-flags]
```

### Naming Convention

Commands use `resource-action` format:

- **Resource**: API resource category (organizations, networks, devices, etc.)
- **Action**: Operation to perform (list, get, update, create, delete, etc.)

**Examples:**
- `organizations-list-organizations` → GET /organizations
- `networks-get-network` → GET /networks/{networkId}
- `devices-get-device` → GET /devices/{serial}
- `networks-update-network` → PUT /networks/{networkId}
- `networks-delete-network` → DELETE /networks/{networkId}

### Global Flags

| Flag | Description | Default |
|------|-------------|---------|
| `--format` | Output format: `json`, `yaml`, or `table` | `json` |
| `--api-key` | API key (overrides env var) | From `MERAKI_API_KEY` |
| `--base-url` | API base URL (for testing) | `https://api.meraki.com/api/v1` |
| `--timeout` | Request timeout in seconds | `30` |
| `--help` | Show help message | - |

### Common Resources

The CLI covers these major resource categories:

- **organizations**: Organization management and listing
- **networks**: Network configuration and settings
- **devices**: Device inventory and configuration
- **appliance**: MX security appliance settings
- **switch**: MS switch configuration
- **wireless**: MR access point settings
- **camera**: MV camera management
- **sensor**: MT sensor configuration
- **cellularGateway**: MG cellular gateway settings
- **insight**: Network analytics and monitoring
- **sm**: Systems Manager (MDM)

### Parameter Handling

**Path Parameters** (required):
```bash
# networkId is a path parameter
meraki-cli networks-get-network --network-id "N_1234567890"
```

**Query Parameters** (optional):
```bash
# Pagination with query params
meraki-cli organizations-list-devices \
  --organization-id "O_123" \
  --per-page 50 \
  --starting-after "Q2XX-XXXX-XXXX"
```

**Body Parameters** (for PUT/POST):
```bash
# Update network name
meraki-cli networks-update-network \
  --network-id "N_123" \
  --name "New Network Name" \
  --timezone "America/Los_Angeles"
```

### Tool Catalog Export

Generate a JSON catalog of all tools for agent integration:

```bash
python -m ccie_sidecar.meraki_cli list-commands > meraki-tools.json
```

This creates an MCP-compatible tool catalog with:
- Tool names and descriptions
- Parameter schemas
- Blast radius classifications
- Endpoint metadata (method, path)

## Common Examples

### Organizations

```bash
# List all organizations
meraki-cli organizations-list-organizations

# Get organization details
meraki-cli organizations-get-organization --organization-id "O_123"

# List all networks in an org
meraki-cli organizations-list-networks --organization-id "O_123"

# List all devices in an org
meraki-cli organizations-list-devices --organization-id "O_123"

# Search devices by model
meraki-cli organizations-list-devices \
  --organization-id "O_123" \
  --model "MR46"
```

### Networks

```bash
# Get network details
meraki-cli networks-get-network --network-id "N_123"

# Update network name
meraki-cli networks-update-network \
  --network-id "N_123" \
  --name "Office Network"

# List clients on a network
meraki-cli networks-list-clients \
  --network-id "N_123" \
  --timespan 86400  # Last 24 hours

# Get network traffic data
meraki-cli networks-get-traffic --network-id "N_123"
```

### Devices

```bash
# Get device details by serial
meraki-cli devices-get-device --serial "Q2XX-XXXX-XXXX"

# List all devices with table output
meraki-cli --format table organizations-list-devices \
  --organization-id "O_123"

# Update device name
meraki-cli devices-update-device \
  --serial "Q2XX-XXXX-XXXX" \
  --name "Office-AP-Floor2"

# Get device clients
meraki-cli devices-list-clients \
  --serial "Q2XX-XXXX-XXXX" \
  --timespan 3600  # Last hour
```

### Wireless

```bash
# List SSIDs for a network
meraki-cli wireless-list-ssids --network-id "N_123"

# Get specific SSID details
meraki-cli wireless-get-ssid \
  --network-id "N_123" \
  --number 0

# Update SSID settings
meraki-cli wireless-update-ssid \
  --network-id "N_123" \
  --number 0 \
  --name "Corporate-WiFi" \
  --enabled true
```

### Switch

```bash
# Get switch port info
meraki-cli switch-get-port \
  --serial "Q2XX-XXXX-XXXX" \
  --port-id "1"

# List switch ports
meraki-cli switch-list-ports --serial "Q2XX-XXXX-XXXX"

# Update VLAN on a port
meraki-cli switch-update-port \
  --serial "Q2XX-XXXX-XXXX" \
  --port-id "1" \
  --vlan 100 \
  --type "access"
```

## ReACT Agent Integration

### How Agents Use the CLI

TerminAI's ReACT agents use the Meraki CLI as a tool library. When you ask a natural language question, the agent:

1. **Understands Intent**: Parses your question to determine what information is needed
2. **Plans Actions**: Selects appropriate Meraki CLI commands to gather data
3. **Executes Tools**: Runs commands with proper parameters
4. **Reasons About Results**: Analyzes API responses
5. **Answers Questions**: Provides natural language responses with context

### Example Conversation Flow

**User:** "How many networks are in my main organization?"

**Agent Reasoning:**
```
Thought: I need to first list organizations to find the main one,
then count its networks.

Action: meraki.organizations.list-organizations
Result: [{"id": "O_123", "name": "Acme Corp"}, ...]

Thought: Found main org. Now I'll list networks for that org.

Action: meraki.organizations.list-networks (organizationId="O_123")
Result: [{"id": "N_1", "name": "HQ"}, {"id": "N_2", "name": "Branch"}, ...]

Final Answer: Your main organization "Acme Corp" has 2 networks: 
HQ and Branch.
```

### Disambiguation Example

**User:** "Show me device Q2XX-1234-ABCD"

**Agent (ambiguous parameter):**
```
Thought: User mentioned a device serial, but it's incomplete. 
I should ask for clarification before searching.

Question: I see you're looking for device Q2XX-1234-ABCD. 
Could you provide the complete serial number? 
Meraki serials are typically in the format Q2XX-XXXX-XXXX.
```

**User:** "It's Q2XX-1234-ABCD5"

**Agent:**
```
Action: meraki.devices.get-device (serial="Q2XX-1234-ABCD5")
Result: {"serial": "Q2XX-1234-ABCD5", "model": "MR46", ...}

Final Answer: Found your device! It's an MR46 access point 
named "Office-Floor1" at 123 Main St...
```

### Approval Flow Example

**User:** "Update the office network name to 'New Office Network'"

**Agent:**
```
Thought: I need to update a network, which requires the networkId.
Let me search for networks named "office".

Action: meraki.organizations.list-networks (organizationId="O_123")
Result: Found "Office Network" with id="N_456"

Thought: Now I'll update the name. This is a PUT request with 
blast_radius=medium, so it requires user approval.

Tool Approval Request:
  Command: networks-update-network
  Arguments: networkId="N_456", name="New Office Network"
  Blast Radius: medium
  Impact: This will update network configuration
  
  [Approve] [Approve for Session] [Deny]
```

**User clicks "Approve":**

```
Action: meraki.networks.update-network (networkId="N_456", name="New Office Network")
Result: {"id": "N_456", "name": "New Office Network", ...}

Final Answer: Successfully updated the network name to "New Office Network".
```

### Setting Up an Agent

See [USER_GUIDE.md](USER_GUIDE.md#building-a-meraki-agent) for complete agent setup instructions.

## Blast Radius Tiers

Every Meraki CLI command is automatically classified by potential impact:

### Tier Definitions

| Tier | Description | HTTP Methods | Auto-Approve? | Examples |
|------|-------------|--------------|---------------|----------|
| **low** | Read-only operations | GET | Yes | list-organizations, get-network, list-devices |
| **medium** | Minor configuration changes | POST, PUT (non-critical) | Requires approval | update-network-name, create-vlan |
| **high** | Sensitive configuration | PUT (policies, firewalls) | Requires approval | update-firewall-rules, update-group-policy |
| **critical** | Destructive operations | DELETE | Requires approval | delete-network, remove-organization-admin |

### Agent Approval Behavior

Agents respect the `default_blast_radius_allowed` setting:

```yaml
# In AGENT.md
attached-tools:
  - id: meraki
    catalog: ~/.terminai/meraki-tools.json
    default-blast-radius-allowed: low  # Only auto-approve reads
    vault-entry: meraki_default
```

**Settings:**
- `low`: Auto-approve read operations only
- `medium`: Auto-approve reads and minor writes
- `high`: Auto-approve everything except deletes
- `critical`: Auto-approve everything (dangerous!)

**Approval Modes:**
- **Auto**: Executed without user interaction
- **Once**: User approves this execution
- **Session**: User approves for entire conversation
- **Denied**: User rejects execution

### Audit Trail

All tool executions are logged with:
- Timestamp
- Command and arguments
- Blast radius tier
- Approval status (auto/once/session/denied)
- Success/failure
- Error details (if failed)
- Execution duration

View audit logs in Settings → Security → Audit Log (coming in Phase 6).

## Troubleshooting

### Authentication Errors

**Error:** "401 Unauthorized"

**Causes:**
- Invalid or expired API key
- API key lacks necessary permissions
- Rate limiting (429 errors)

**Solutions:**
```bash
# Verify API key is set
echo $MERAKI_API_KEY

# Test authentication
meraki-cli organizations-list-organizations

# Regenerate API key from Dashboard if needed
```

### Missing Parameters

**Error:** "Missing required parameter: networkId"

**Cause:** Required path or query parameter not provided

**Solution:**
```bash
# Check command help
meraki-cli networks-get-network --help

# Provide required parameters
meraki-cli networks-get-network --network-id "N_123"
```

### Parameter Naming

**Error:** "Unknown parameter: network_id"

**Cause:** Using Python snake_case instead of CLI kebab-case

**Solution:**
```bash
# Wrong (Python style)
meraki-cli networks-get-network --network_id "N_123"

# Correct (CLI style)
meraki-cli networks-get-network --network-id "N_123"
```

### Rate Limiting

**Error:** "429 Too Many Requests"

**Cause:** Exceeded API rate limits (5 calls/second per org)

**Solution:**
- Wait 1-2 minutes before retrying
- Add delays between batch operations
- Use pagination for large result sets
- Consider Action Batches API for bulk operations

### Network Errors

**Error:** "Connection timeout" or "Connection refused"

**Causes:**
- Network connectivity issues
- Firewall blocking outbound HTTPS
- DNS resolution failure

**Solutions:**
```bash
# Test connectivity
curl https://api.meraki.com/api/v1/organizations

# Check DNS
nslookup api.meraki.com

# Verify firewall allows HTTPS to api.meraki.com
```

### Agent Not Finding Tools

**Error:** Agent says "I don't have access to Meraki tools"

**Causes:**
- Tool catalog not generated
- Wrong catalog path in AGENT.md
- Catalog JSON malformed

**Solutions:**
```bash
# Regenerate tool catalog
cd /path/to/terminai/sidecar
python -m ccie_sidecar.meraki_cli list-commands > ~/.terminai/meraki-tools.json

# Verify JSON is valid
jq . ~/.terminai/meraki-tools.json

# Check AGENT.md points to correct path
cat ~/.ccie-terminal/agents/my-agent/AGENT.md
```

### Approval Requests Not Showing

**Cause:** Frontend approval modal not wired (Phase 5 limitation)

**Workaround:** Temporarily set higher blast radius in agent definition:
```yaml
default-blast-radius-allowed: medium  # Auto-approve more operations
```

**Permanent Fix:** Coming in Phase 6 with full frontend integration.

## Further Reading

- [USER_GUIDE.md](USER_GUIDE.md#building-a-meraki-agent) - Complete agent setup guide
- [APPROVAL_INTEGRATION.md](../sidecar/APPROVAL_INTEGRATION.md) - Approval system details
- [Meraki Dashboard API Documentation](https://developer.cisco.com/meraki/api-v1/) - Official API reference
- [Architecture](ARCHITECTURE.md) - TerminAI system architecture

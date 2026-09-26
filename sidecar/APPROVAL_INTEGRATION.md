# Blast-Radius Approval Gating Integration

## Overview

Phase 5 implementation of blast-radius gating for Meraki CLI ReACT agent. Adds approval logic that intercepts tool calls based on their risk tier and either auto-approves, requests user approval, or denies execution.

## Implementation Date

2026-05-24

## Components

### 1. Approval Logic Module (`src/ccie_sidecar/approvals/`)

New module containing:

#### `approval_logic.py`
- **`is_tier_allowed(tool_tier, default_allowed)`**: Checks if a tool's tier is within the agent's auto-approval threshold
- **`request_approval(tool_spec, args, tier, conversation_id, on_event)`**: Emits approval request event to frontend and waits for response
- **`get_session_approvals(conversation_id, db_conn)`**: Retrieves session-level approvals from database
- **`ApprovalResult`**: Data class for approval outcomes

Tier hierarchy: `low` < `medium` < `high` < `critical`

#### `audit.py`
- **`log_tool_call(...)`**: Logs all tool executions with approval status, blast radius, duration, and results

### 2. ReACT Loop Integration (`src/ccie_sidecar/agents/react.py`)

Updated `react_loop()` function to:

1. **Check tier before execution**: Uses `is_tier_allowed()` to determine if tool requires approval
2. **Request approval if needed**: Emits `tool_approval_request` event and waits for user response
3. **Handle denial**: Creates error result with `approval_denied` code, logs to audit, adds error to LLM history
4. **Track approval mode**: Records whether execution was auto, once, session, or denied
5. **Audit all calls**: Logs every tool call regardless of outcome

#### Integration Flow

```python
# Before tool execution:
if not is_tier_allowed(blast_radius, default_allowed):
    # Check session approvals
    if tool_name not in session_approvals:
        # Request approval from user
        approval = await request_approval(...)
        
        if not approval.granted:
            # Create denial result
            result = {
                "ok": False,
                "error": {"code": "approval_denied", ...}
            }
            # Log denial
            log_tool_call(..., approval_status='denied', ...)
            # Skip execution
```

#### New Parameters

- `conversation_id`: Optional conversation ID for tracking approvals
- `db_conn`: Optional database connection for session approvals

### 3. Event Schema Updates

#### New Event: `tool_approval_request`

```json
{
    "type": "tool_approval_request",
    "conversation_id": "conv_123",
    "tool_name": "meraki.networks.update-network",
    "description": "Update network configuration",
    "args": {"networkId": "N_123", "name": "New Name"},
    "blast_radius": "high",
    "endpoint": {"method": "PUT", "path": "/networks/{networkId}"}
}
```

#### Updated Event: `tool_result`

Now includes `approval_status` field:

```json
{
    "type": "tool_result",
    "name": "meraki_networks_update_network",
    "ok": false,
    "error": {"code": "approval_denied", ...},
    "meta": {},
    "approval_status": "denied"
}
```

Possible values: `auto`, `once`, `session`, `denied`

### 4. Audit Log Format

Console output (Phase 5 - database persistence pending):

```json
{
    "timestamp": "2026-05-24T20:30:45.123Z",
    "conversation_id": "conv_123",
    "agent_id": "agent_456",
    "tool_name": "meraki.networks.update-network",
    "method": "PUT",
    "path": "/networks/{networkId}",
    "args": {"networkId": "N_123", "name": "New Name"},
    "blast_radius": "high",
    "approval_status": "denied",
    "success": false,
    "error_code": "approval_denied",
    "duration_ms": 15
}
```

## Testing

### Unit Tests (`test_approval_logic.py`)

Tests approval logic in isolation:

- ✅ **Tier hierarchy**: 16 test cases covering all tier combinations
- ✅ **Audit logging**: Verifies log output format

Run with: `python test_approval_logic.py`

Results: **All 16 tests passed**

### Integration Tests (`test_approval_flow.py`)

Tests full ReACT loop with live Meraki API (requires ANTHROPIC_API_KEY):

1. **Test 1: Low tier auto-approval**
   - Tool: `list-organizations` (low tier)
   - Expected: `approval_status='auto'`, no approval request
   
2. **Test 2: High tier approval required**
   - Tool: `update-network` (high tier)
   - Expected: `approval_status='denied'`, approval request emitted
   
3. **Test 3: Critical tier denial**
   - Tool: `delete-network` (critical tier)
   - Expected: `approval_status='denied'`, error code `approval_denied`

Run with: `python test_approval_flow.py` (requires API keys)

## Current State

### ✅ Completed

1. Approval logic module with tier checking
2. Audit logging with console output
3. ReACT loop integration with approval gating
4. Error handling for denied approvals
5. Unit tests (all passing)

### ⚠️ Pending

1. **Frontend wiring**: `request_approval()` currently returns immediate denial
   - Need to wire up WebSocket/event response mechanism
   - Need to connect to `ToolApprovalModal` component

2. **Database persistence**: Audit logs currently print to console
   - Need to create `tool_call_audit` table
   - Need to implement session approvals storage

3. **Session approval tracking**: `get_session_approvals()` returns empty set
   - Need to persist "Approve for Session" choices
   - Need to clear on conversation end

## Usage Example

```python
from ccie_sidecar.agents.react import react_loop

agent_def = {
    'id': 'my_agent',
    'system_prompt': 'You are a network automation assistant',
    'attached_tools': [{
        'catalog': meraki_catalog_json,
        'vault_entry': 'meraki_default',
        'default_blast_radius_allowed': 'low'  # Only auto-approve read operations
    }]
}

await react_loop(
    agent_def=agent_def,
    user_msg="List all organizations",
    ctx={},
    on_event=handle_event,
    conversation_id="conv_123",
    db_conn=None
)
```

## Next Steps (Tasks 36-37)

1. **Wire to ToolApprovalModal**: Update frontend to listen for `tool_approval_request` events and send responses back
2. **Test with live API**: Once approval modal is wired, run `test_approval_flow.py` with real user interactions
3. **Add database persistence**: Create audit table and session approvals storage

## Files Modified

- `src/ccie_sidecar/approvals/__init__.py` (new)
- `src/ccie_sidecar/approvals/approval_logic.py` (new)
- `src/ccie_sidecar/approvals/audit.py` (new)
- `src/ccie_sidecar/agents/react.py` (modified)
- `test_approval_logic.py` (new)
- `test_approval_flow.py` (new)

## Verification

```bash
# Verify syntax
python -m py_compile src/ccie_sidecar/agents/react.py

# Run unit tests
python test_approval_logic.py

# Run integration tests (requires API keys)
export ANTHROPIC_API_KEY=your_key
python test_approval_flow.py
```

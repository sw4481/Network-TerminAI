"""
Audit logging for tool calls with approval tracking.

Logs all tool executions including approval status, blast radius, and results.
"""

from datetime import datetime
from typing import Any, Dict, Optional
import json
import sqlite3


def log_tool_call(
    conversation_id: str,
    agent_id: str,
    tool_name: str,
    method: str,
    path: str,
    args: dict,
    blast_radius: str,
    approval_status: str,
    result: Dict[str, Any],
    duration_ms: int,
    db_conn: Optional[Any] = None,
) -> None:
    """
    Log a tool call to the audit database.

    Args:
        conversation_id: Conversation ID
        agent_id: Agent ID
        tool_name: Full tool name (e.g., "meraki.organizations.list-organizations")
        method: HTTP method (GET, POST, PUT, DELETE)
        path: API endpoint path
        args: Tool arguments
        blast_radius: Blast radius tier (low, medium, high, critical)
        approval_status: 'auto', 'once', 'session', 'denied'
        result: Tool execution result envelope
        duration_ms: Execution duration in milliseconds
        db_conn: Database connection (optional, will use default if None)
    """
    timestamp = datetime.utcnow().isoformat() + 'Z'

    # Prepare log entry
    log_entry = {
        'timestamp': timestamp,
        'conversation_id': conversation_id,
        'agent_id': agent_id,
        'tool_name': tool_name,
        'method': method,
        'path': path,
        'args': args,
        'blast_radius': blast_radius,
        'approval_status': approval_status,
        'success': result.get('ok', False),
        'error_code': result.get('error', {}).get('code') if not result.get('ok') else None,
        'duration_ms': duration_ms,
    }

    # TODO: Write to database
    # For Phase 5, we'll just log to console for verification
    print(f"[AUDIT] {json.dumps(log_entry, indent=2)}")

    # TODO: Implement database write
    # if db_conn:
    #     cursor = db_conn.cursor()
    #     cursor.execute("""
    #         INSERT INTO tool_call_audit (
    #             timestamp, conversation_id, agent_id, tool_name,
    #             method, path, args, blast_radius, approval_status,
    #             success, error_code, duration_ms
    #         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    #     """, (
    #         timestamp, conversation_id, agent_id, tool_name,
    #         method, path, json.dumps(args), blast_radius, approval_status,
    #         log_entry['success'], log_entry['error_code'], duration_ms
    #     ))
    #     db_conn.commit()

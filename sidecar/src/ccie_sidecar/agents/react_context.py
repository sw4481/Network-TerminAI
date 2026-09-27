"""
ReACT context builder for Meraki CLI agent.

This module provides context management for ReACT loops, including:
- Session state tracking (last-used parameter values)
- Recent tool results from conversation history
- Active block context (Phase 6)
"""

import json
import sqlite3
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional


@dataclass
class ReACTContext:
    """Context for ReACT loop execution."""

    org_id: Optional[str] = None
    network_id: Optional[str] = None
    serial: Optional[str] = None
    last_tool_results: List[Dict[str, Any]] = field(default_factory=list)
    active_block_context: Dict[str, Any] = field(default_factory=dict)
    user_answers: Dict[str, str] = field(default_factory=dict)


def _get_db_path() -> Path:
    """Get the path to the sessions database."""
    import os
    if os.name == 'nt':
        config_dir = Path(os.environ.get('APPDATA', '')) / 'ccie-terminal'
    elif os.uname().sysname == 'Darwin':
        config_dir = Path.home() / 'Library' / 'Application Support' / 'ccie-terminal'
    else:
        config_dir = Path.home() / '.config' / 'ccie-terminal'

    return config_dir / 'sessions.db'


def build_context(
    agent_id: str,
    conversation_id: str,
    db_conn: Optional[sqlite3.Connection] = None
) -> ReACTContext:
    """
    Build context from session state and conversation history.

    Loads:
    1. Last-used params from react_session_state
    2. Recent tool results from conversation history (Phase 5+)
    3. Active block context (empty for now - Phase 6)

    Args:
        agent_id: Agent identifier
        conversation_id: Conversation identifier
        db_conn: Optional database connection (if None, opens default database)

    Returns:
        ReACTContext with loaded state
    """
    ctx = ReACTContext()

    # Determine whether to close connection after use
    should_close = False
    if db_conn is None:
        db_path = _get_db_path()
        if not db_path.exists():
            # Database doesn't exist yet - return empty context
            return ctx
        db_conn = sqlite3.connect(str(db_path))
        should_close = True

    try:
        session_id = f"{agent_id}:{conversation_id}"

        # Load session state
        cursor = db_conn.cursor()
        cursor.execute(
            """
            SELECT last_org_id, last_network_id, last_serial
            FROM react_session_state
            WHERE session_id = ?
            """,
            (session_id,)
        )
        row = cursor.fetchone()

        if row:
            ctx.org_id = row[0]
            ctx.network_id = row[1]
            ctx.serial = row[2]

        # Phase 5+: Load recent tool results from conversation history
        # For Phase 4, this is a stub - we don't have conversation persistence yet
        # This will be implemented when we add conversation history tracking

        return ctx

    finally:
        if should_close:
            db_conn.close()


def update_session_state(
    agent_id: str,
    conversation_id: str,
    params: Dict[str, str],
    db_conn: Optional[sqlite3.Connection] = None
) -> None:
    """
    Update session state with newly used parameters.

    Updates last_org_id, last_network_id, last_serial as applicable.

    Args:
        agent_id: Agent identifier
        conversation_id: Conversation identifier
        params: Dictionary of parameters to update (keys: org_id, network_id, serial)
        db_conn: Optional database connection (if None, opens default database)
    """
    # Determine whether to close connection after use
    should_close = False
    if db_conn is None:
        db_path = _get_db_path()
        if not db_path.exists():
            # Database doesn't exist yet - silently return
            return
        db_conn = sqlite3.connect(str(db_path))
        should_close = True

    try:
        session_id = f"{agent_id}:{conversation_id}"
        cursor = db_conn.cursor()

        # UPSERT: update if exists, insert if not
        # Extract parameters
        org_id = params.get("org_id") or params.get("organizationId")
        network_id = params.get("network_id") or params.get("networkId")
        serial = params.get("serial")

        # Check if session exists
        cursor.execute(
            "SELECT session_id FROM react_session_state WHERE session_id = ?",
            (session_id,)
        )
        exists = cursor.fetchone() is not None

        if exists:
            # Update existing record
            updates = []
            values = []

            if org_id:
                updates.append("last_org_id = ?")
                values.append(org_id)
            if network_id:
                updates.append("last_network_id = ?")
                values.append(network_id)
            if serial:
                updates.append("last_serial = ?")
                values.append(serial)

            if updates:
                updates.append("updated_at = ?")
                values.append(int(time.time()))
                values.append(session_id)

                cursor.execute(
                    f"""
                    UPDATE react_session_state
                    SET {', '.join(updates)}
                    WHERE session_id = ?
                    """,
                    tuple(values)
                )
        else:
            # Insert new record
            cursor.execute(
                """
                INSERT INTO react_session_state
                (session_id, last_org_id, last_network_id, last_serial, updated_at)
                VALUES (?, ?, ?, ?, ?)
                """,
                (session_id, org_id, network_id, serial, int(time.time()))
            )

        db_conn.commit()

    finally:
        if should_close:
            db_conn.close()


def get_pending_resume(
    pending_id: str,
    db_conn: Optional[sqlite3.Connection] = None
) -> Optional[Dict[str, Any]]:
    """
    Retrieve a pending resume record.

    Args:
        pending_id: Unique identifier for the pending resume
        db_conn: Optional database connection

    Returns:
        Dict with pending resume data or None if not found/expired
    """
    should_close = False
    if db_conn is None:
        db_path = _get_db_path()
        if not db_path.exists():
            return None
        db_conn = sqlite3.connect(str(db_path))
        should_close = True

    try:
        cursor = db_conn.cursor()
        cursor.execute(
            """
            SELECT conversation_id, agent_id, question, loop_state, expires_at
            FROM react_pending_resumes
            WHERE pending_id = ? AND expires_at > ?
            """,
            (pending_id, int(time.time()))
        )
        row = cursor.fetchone()

        if not row:
            return None

        return {
            "pending_id": pending_id,
            "conversation_id": row[0],
            "agent_id": row[1],
            "question": json.loads(row[2]),
            "loop_state": row[3],  # Pickled blob
            "expires_at": row[4]
        }

    finally:
        if should_close:
            db_conn.close()


def save_pending_resume(
    pending_id: str,
    conversation_id: str,
    agent_id: str,
    question: Dict[str, Any],
    loop_state: bytes,
    expires_in_seconds: int = 1800,  # 30 minutes default
    db_conn: Optional[sqlite3.Connection] = None
) -> None:
    """
    Save a pending resume record for later continuation.

    Args:
        pending_id: Unique identifier for this resume
        conversation_id: Conversation identifier
        agent_id: Agent identifier
        question: Question dict with param, prompt, options
        loop_state: Pickled loop state (history + context)
        expires_in_seconds: Time until expiration (default 30 minutes)
        db_conn: Optional database connection
    """
    should_close = False
    if db_conn is None:
        db_path = _get_db_path()
        if not db_path.exists():
            return
        db_conn = sqlite3.connect(str(db_path))
        should_close = True

    try:
        cursor = db_conn.cursor()
        now = int(time.time())
        expires_at = now + expires_in_seconds

        cursor.execute(
            """
            INSERT INTO react_pending_resumes
            (pending_id, conversation_id, agent_id, question, loop_state, created_at, expires_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                pending_id,
                conversation_id,
                agent_id,
                json.dumps(question),
                loop_state,
                now,
                expires_at
            )
        )
        db_conn.commit()

    finally:
        if should_close:
            db_conn.close()


def delete_pending_resume(
    pending_id: str,
    db_conn: Optional[sqlite3.Connection] = None
) -> None:
    """
    Delete a pending resume record after it's been processed.

    Args:
        pending_id: Unique identifier for the resume to delete
        db_conn: Optional database connection
    """
    should_close = False
    if db_conn is None:
        db_path = _get_db_path()
        if not db_path.exists():
            return
        db_conn = sqlite3.connect(str(db_path))
        should_close = True

    try:
        cursor = db_conn.cursor()
        cursor.execute(
            "DELETE FROM react_pending_resumes WHERE pending_id = ?",
            (pending_id,)
        )
        db_conn.commit()

    finally:
        if should_close:
            db_conn.close()


def cleanup_expired_resumes(
    db_conn: Optional[sqlite3.Connection] = None
) -> int:
    """
    Clean up expired pending resumes.

    Args:
        db_conn: Optional database connection

    Returns:
        Number of expired records deleted
    """
    should_close = False
    if db_conn is None:
        db_path = _get_db_path()
        if not db_path.exists():
            return 0
        db_conn = sqlite3.connect(str(db_path))
        should_close = True

    try:
        cursor = db_conn.cursor()
        cursor.execute(
            "DELETE FROM react_pending_resumes WHERE expires_at <= ?",
            (int(time.time()),)
        )
        deleted = cursor.rowcount
        db_conn.commit()
        return deleted

    finally:
        if should_close:
            db_conn.close()

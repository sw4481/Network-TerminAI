"""Tests for ReACT context builder."""

import json
import sqlite3
import tempfile
import time
from pathlib import Path

import pytest

from ccie_sidecar.agents.react_context import (
    ReACTContext,
    build_context,
    cleanup_expired_resumes,
    delete_pending_resume,
    get_pending_resume,
    save_pending_resume,
    update_session_state,
)


@pytest.fixture
def test_db():
    """Create a temporary test database with V0044 schema."""
    with tempfile.NamedTemporaryFile(suffix=".db", delete=False) as f:
        db_path = Path(f.name)

    conn = sqlite3.connect(str(db_path))
    cursor = conn.cursor()

    # Create V0044 tables
    cursor.execute(
        """
        CREATE TABLE react_session_state (
            session_id      TEXT PRIMARY KEY,
            last_org_id     TEXT,
            last_network_id TEXT,
            last_serial     TEXT,
            updated_at      INTEGER NOT NULL
        )
        """
    )

    cursor.execute(
        """
        CREATE TABLE react_pending_resumes (
            pending_id      TEXT PRIMARY KEY,
            conversation_id TEXT NOT NULL,
            agent_id        TEXT NOT NULL,
            question        TEXT NOT NULL,
            loop_state      BLOB NOT NULL,
            created_at      INTEGER NOT NULL,
            expires_at      INTEGER NOT NULL
        )
        """
    )

    conn.commit()

    yield conn

    conn.close()
    db_path.unlink()


def test_build_context_empty(test_db):
    """Test building context with no existing state."""
    ctx = build_context("agent1", "conv1", test_db)

    assert isinstance(ctx, ReACTContext)
    assert ctx.org_id is None
    assert ctx.network_id is None
    assert ctx.serial is None
    assert ctx.last_tool_results == []
    assert ctx.active_block_context == {}
    assert ctx.user_answers == {}


def test_build_context_with_state(test_db):
    """Test building context with existing session state."""
    # Insert session state
    cursor = test_db.cursor()
    cursor.execute(
        """
        INSERT INTO react_session_state
        (session_id, last_org_id, last_network_id, last_serial, updated_at)
        VALUES (?, ?, ?, ?, ?)
        """,
        ("agent1:conv1", "org123", "net456", "serial789", int(time.time()))
    )
    test_db.commit()

    # Build context
    ctx = build_context("agent1", "conv1", test_db)

    assert ctx.org_id == "org123"
    assert ctx.network_id == "net456"
    assert ctx.serial == "serial789"


def test_update_session_state_insert(test_db):
    """Test inserting new session state."""
    params = {
        "org_id": "org123",
        "network_id": "net456",
        "serial": "serial789"
    }

    update_session_state("agent1", "conv1", params, test_db)

    # Verify insert
    cursor = test_db.cursor()
    cursor.execute(
        "SELECT last_org_id, last_network_id, last_serial FROM react_session_state WHERE session_id = ?",
        ("agent1:conv1",)
    )
    row = cursor.fetchone()

    assert row is not None
    assert row[0] == "org123"
    assert row[1] == "net456"
    assert row[2] == "serial789"


def test_update_session_state_update(test_db):
    """Test updating existing session state."""
    # Insert initial state
    cursor = test_db.cursor()
    cursor.execute(
        """
        INSERT INTO react_session_state
        (session_id, last_org_id, last_network_id, last_serial, updated_at)
        VALUES (?, ?, ?, ?, ?)
        """,
        ("agent1:conv1", "old_org", "old_net", "old_serial", int(time.time()))
    )
    test_db.commit()

    # Update with new values
    params = {
        "org_id": "new_org",
        "network_id": "new_net"
        # Note: serial not updated
    }

    update_session_state("agent1", "conv1", params, test_db)

    # Verify update
    cursor.execute(
        "SELECT last_org_id, last_network_id, last_serial FROM react_session_state WHERE session_id = ?",
        ("agent1:conv1",)
    )
    row = cursor.fetchone()

    assert row is not None
    assert row[0] == "new_org"
    assert row[1] == "new_net"
    assert row[2] == "old_serial"  # Unchanged


def test_update_session_state_with_api_param_names(test_db):
    """Test updating with API parameter names (organizationId, networkId)."""
    params = {
        "organizationId": "org123",
        "networkId": "net456"
    }

    update_session_state("agent1", "conv1", params, test_db)

    # Verify insert
    cursor = test_db.cursor()
    cursor.execute(
        "SELECT last_org_id, last_network_id FROM react_session_state WHERE session_id = ?",
        ("agent1:conv1",)
    )
    row = cursor.fetchone()

    assert row is not None
    assert row[0] == "org123"
    assert row[1] == "net456"


def test_save_and_get_pending_resume(test_db):
    """Test saving and retrieving a pending resume."""
    question = {
        "param": "org_id",
        "prompt": "Which organization?",
        "options": ["org1", "org2"]
    }
    loop_state = b"pickled_state_data"

    save_pending_resume(
        "resume1",
        "conv1",
        "agent1",
        question,
        loop_state,
        expires_in_seconds=3600,
        db_conn=test_db
    )

    # Retrieve
    resume = get_pending_resume("resume1", test_db)

    assert resume is not None
    assert resume["pending_id"] == "resume1"
    assert resume["conversation_id"] == "conv1"
    assert resume["agent_id"] == "agent1"
    assert resume["question"] == question
    assert resume["loop_state"] == loop_state
    assert resume["expires_at"] > int(time.time())


def test_get_pending_resume_not_found(test_db):
    """Test retrieving a non-existent pending resume."""
    resume = get_pending_resume("nonexistent", test_db)
    assert resume is None


def test_get_pending_resume_expired(test_db):
    """Test retrieving an expired pending resume."""
    question = {
        "param": "org_id",
        "prompt": "Which organization?",
        "options": ["org1", "org2"]
    }
    loop_state = b"pickled_state_data"

    # Save with negative expiry (already expired)
    save_pending_resume(
        "expired_resume",
        "conv1",
        "agent1",
        question,
        loop_state,
        expires_in_seconds=-1,
        db_conn=test_db
    )

    # Try to retrieve - should return None
    resume = get_pending_resume("expired_resume", test_db)
    assert resume is None


def test_delete_pending_resume(test_db):
    """Test deleting a pending resume."""
    question = {
        "param": "org_id",
        "prompt": "Which organization?",
        "options": []
    }
    loop_state = b"state"

    save_pending_resume(
        "resume1",
        "conv1",
        "agent1",
        question,
        loop_state,
        db_conn=test_db
    )

    # Verify it exists
    resume = get_pending_resume("resume1", test_db)
    assert resume is not None

    # Delete it
    delete_pending_resume("resume1", test_db)

    # Verify it's gone
    resume = get_pending_resume("resume1", test_db)
    assert resume is None


def test_cleanup_expired_resumes(test_db):
    """Test cleaning up expired resumes."""
    question = {
        "param": "org_id",
        "prompt": "Which organization?",
        "options": []
    }
    loop_state = b"state"

    # Save one expired and one valid
    save_pending_resume(
        "expired1",
        "conv1",
        "agent1",
        question,
        loop_state,
        expires_in_seconds=-1,  # Expired
        db_conn=test_db
    )

    save_pending_resume(
        "valid1",
        "conv1",
        "agent1",
        question,
        loop_state,
        expires_in_seconds=3600,  # Valid for 1 hour
        db_conn=test_db
    )

    # Clean up
    deleted = cleanup_expired_resumes(test_db)
    assert deleted == 1

    # Verify only valid one remains
    assert get_pending_resume("expired1", test_db) is None
    assert get_pending_resume("valid1", test_db) is not None


def test_react_context_dataclass():
    """Test ReACTContext dataclass initialization."""
    # Test with defaults
    ctx = ReACTContext()
    assert ctx.org_id is None
    assert ctx.network_id is None
    assert ctx.serial is None
    assert ctx.last_tool_results == []
    assert ctx.active_block_context == {}
    assert ctx.user_answers == {}

    # Test with values
    ctx = ReACTContext(
        org_id="org123",
        network_id="net456",
        serial="serial789",
        last_tool_results=[{"tool": "list-orgs", "result": "success"}],
        active_block_context={"block_id": "block1"},
        user_answers={"org_id": "org123"}
    )
    assert ctx.org_id == "org123"
    assert ctx.network_id == "net456"
    assert ctx.serial == "serial789"
    assert len(ctx.last_tool_results) == 1
    assert ctx.active_block_context["block_id"] == "block1"
    assert ctx.user_answers["org_id"] == "org123"

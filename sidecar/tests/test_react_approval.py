"""
Tests for ReACT approval and blast-radius gating.

Tests:
- Tier comparison logic
- Approval request event emission
- Audit logging
- Session approval tracking
- Sensitive field redaction
"""

import json
import sqlite3
import time
from pathlib import Path

import pytest

from ccie_sidecar.agents.react_approval import (
    ApprovalResult,
    get_session_approvals,
    is_tier_allowed,
    log_tool_call,
    request_approval,
)


class TestTierComparison:
    """Test blast-radius tier comparison logic."""

    def test_low_tier_allowed_by_low(self):
        assert is_tier_allowed("low", "low") is True

    def test_low_tier_allowed_by_medium(self):
        assert is_tier_allowed("low", "medium") is True

    def test_low_tier_allowed_by_high(self):
        assert is_tier_allowed("low", "high") is True

    def test_medium_tier_blocked_by_low(self):
        assert is_tier_allowed("medium", "low") is False

    def test_medium_tier_allowed_by_medium(self):
        assert is_tier_allowed("medium", "medium") is True

    def test_medium_tier_allowed_by_high(self):
        assert is_tier_allowed("medium", "high") is True

    def test_high_tier_blocked_by_low(self):
        assert is_tier_allowed("high", "low") is False

    def test_high_tier_blocked_by_medium(self):
        assert is_tier_allowed("high", "medium") is False

    def test_high_tier_allowed_by_high(self):
        assert is_tier_allowed("high", "high") is True

    def test_destructive_tier_blocked_by_all(self):
        assert is_tier_allowed("destructive", "low") is False
        assert is_tier_allowed("destructive", "medium") is False
        assert is_tier_allowed("destructive", "high") is False

    def test_destructive_tier_allowed_by_destructive(self):
        assert is_tier_allowed("destructive", "destructive") is True

    def test_invalid_tier_blocked(self):
        """Unknown tiers should be blocked by default."""
        assert is_tier_allowed("unknown", "high") is False

    def test_invalid_default_allows_nothing(self):
        """Invalid default tier should block everything."""
        assert is_tier_allowed("low", "invalid") is False


@pytest.mark.asyncio
async def test_request_approval_emits_event():
    """Test that request_approval emits the correct event."""
    events = []

    def on_event(event):
        events.append(event)

    tool_spec = {
        "name": "meraki.networks.update-ssid",
        "description": "Update SSID settings",
        "endpoint": {
            "method": "PUT",
            "path": "/networks/{networkId}/wireless/ssids/{number}"
        }
    }

    args = {
        "networkId": "N_12345",
        "number": 0,
        "name": "Office-WiFi"
    }

    result = await request_approval(
        tool_spec=tool_spec,
        args=args,
        tier="high",
        conversation_id="conv_123",
        on_event=on_event
    )

    # Should emit tool_approval_request event
    assert len(events) == 1
    event = events[0]
    assert event["type"] == "tool_approval_request"
    assert "pending_id" in event
    assert event["tool_name"] == "meraki.networks.update-ssid"
    assert event["description"] == "Update SSID settings"
    assert event["blast_radius"] == "high"
    assert event["args"] == args
    assert event["endpoint"]["method"] == "PUT"

    # Result should indicate pending (will be resolved by react_resume)
    assert result.granted is False
    assert result.mode == "pending"


class TestAuditLogging:
    """Test audit logging functionality."""

    @pytest.fixture
    def db_conn(self, tmp_path):
        """Create an in-memory database with the audit table."""
        db_path = tmp_path / "test.db"
        conn = sqlite3.connect(str(db_path))

        # Create the audit table
        conn.execute("""
            CREATE TABLE meraki_tool_calls (
                id               INTEGER PRIMARY KEY AUTOINCREMENT,
                conversation_id  TEXT,
                agent_id         TEXT,
                tool_name        TEXT NOT NULL,
                method           TEXT NOT NULL,
                path             TEXT NOT NULL,
                args_json        TEXT NOT NULL,
                blast_radius     TEXT NOT NULL,
                approval_status  TEXT,
                response_status  INTEGER,
                response_summary TEXT,
                error_code       TEXT,
                duration_ms      INTEGER NOT NULL,
                created_at       INTEGER NOT NULL
            )
        """)

        yield conn
        conn.close()

    def test_log_successful_tool_call(self, db_conn):
        """Test logging a successful tool call."""
        result = {
            "ok": True,
            "data": [
                {"id": "N_123", "name": "HQ"},
                {"id": "N_456", "name": "Branch"}
            ]
        }

        log_tool_call(
            conversation_id="conv_123",
            agent_id="agent_001",
            tool_name="meraki.organizations.list-networks",
            method="GET",
            path="/organizations/{organizationId}/networks",
            args={"organizationId": "O_123"},
            blast_radius="low",
            approval_status="auto",
            result=result,
            duration_ms=250,
            db_conn=db_conn
        )

        # Verify log entry
        cursor = db_conn.cursor()
        cursor.execute("SELECT * FROM meraki_tool_calls")
        row = cursor.fetchone()

        assert row is not None
        assert row[1] == "conv_123"  # conversation_id
        assert row[2] == "agent_001"  # agent_id
        assert row[3] == "meraki.organizations.list-networks"  # tool_name
        assert row[4] == "GET"  # method
        assert row[5] == "/organizations/{organizationId}/networks"  # path
        assert json.loads(row[6]) == {"organizationId": "O_123"}  # args_json
        assert row[7] == "low"  # blast_radius
        assert row[8] == "auto"  # approval_status
        assert row[9] == 200  # response_status
        assert row[10] == "2 items"  # response_summary
        assert row[11] is None  # error_code
        assert row[12] == 250  # duration_ms

    def test_log_failed_tool_call(self, db_conn):
        """Test logging a failed tool call."""
        result = {
            "ok": False,
            "error": {
                "code": "auth_error",
                "message": "Invalid API key"
            }
        }

        log_tool_call(
            conversation_id="conv_123",
            agent_id="agent_001",
            tool_name="meraki.organizations.list",
            method="GET",
            path="/organizations",
            args={},
            blast_radius="low",
            approval_status="auto",
            result=result,
            duration_ms=100,
            db_conn=db_conn
        )

        # Verify log entry
        cursor = db_conn.cursor()
        cursor.execute("SELECT * FROM meraki_tool_calls")
        row = cursor.fetchone()

        assert row is not None
        assert row[9] is None  # response_status (null for errors)
        assert row[10] == "Invalid API key"  # response_summary
        assert row[11] == "auth_error"  # error_code

    def test_log_truncates_large_responses(self, db_conn):
        """Test that large responses are truncated to 1KB."""
        large_data = {"data": "x" * 2000}  # More than 1KB
        result = {
            "ok": True,
            "data": large_data
        }

        log_tool_call(
            conversation_id="conv_123",
            agent_id="agent_001",
            tool_name="meraki.test.large-response",
            method="GET",
            path="/test",
            args={},
            blast_radius="low",
            approval_status="auto",
            result=result,
            duration_ms=500,
            db_conn=db_conn
        )

        # Verify truncation
        cursor = db_conn.cursor()
        cursor.execute("SELECT response_summary FROM meraki_tool_calls")
        summary = cursor.fetchone()[0]

        assert len(summary) <= 1024

    def test_log_redacts_sensitive_fields(self, db_conn):
        """Test that sensitive fields are redacted in logs."""
        result = {
            "ok": True,
            "data": {
                "id": "N_123",
                "api_key": "secret123",
                "password": "hunter2",
                "token": "abc123"
            }
        }

        log_tool_call(
            conversation_id="conv_123",
            agent_id="agent_001",
            tool_name="meraki.test.with-secrets",
            method="GET",
            path="/test",
            args={},
            blast_radius="low",
            approval_status="auto",
            result=result,
            duration_ms=100,
            db_conn=db_conn
        )

        # Verify redaction
        cursor = db_conn.cursor()
        cursor.execute("SELECT response_summary FROM meraki_tool_calls")
        summary = cursor.fetchone()[0]
        summary_data = json.loads(summary)

        assert summary_data["id"] == "N_123"
        assert summary_data["api_key"] == "[REDACTED]"
        assert summary_data["password"] == "[REDACTED]"
        assert summary_data["token"] == "[REDACTED]"

    def test_log_with_denied_approval(self, db_conn):
        """Test logging a denied tool call."""
        result = {
            "ok": False,
            "error": {
                "code": "denied",
                "message": "User denied approval"
            }
        }

        log_tool_call(
            conversation_id="conv_123",
            agent_id="agent_001",
            tool_name="meraki.networks.update-ssid",
            method="PUT",
            path="/networks/{networkId}/wireless/ssids/{number}",
            args={"networkId": "N_123", "number": 0},
            blast_radius="high",
            approval_status="denied",
            result=result,
            duration_ms=50,
            db_conn=db_conn
        )

        # Verify log entry
        cursor = db_conn.cursor()
        cursor.execute("SELECT approval_status, error_code FROM meraki_tool_calls")
        row = cursor.fetchone()

        assert row[0] == "denied"
        assert row[1] == "denied"


class TestSessionApprovals:
    """Test session-based approval tracking."""

    @pytest.fixture
    def db_conn(self, tmp_path):
        """Create an in-memory database with the audit table."""
        db_path = tmp_path / "test.db"
        conn = sqlite3.connect(str(db_path))

        # Create the audit table
        conn.execute("""
            CREATE TABLE meraki_tool_calls (
                id               INTEGER PRIMARY KEY AUTOINCREMENT,
                conversation_id  TEXT,
                agent_id         TEXT,
                tool_name        TEXT NOT NULL,
                method           TEXT NOT NULL,
                path             TEXT NOT NULL,
                args_json        TEXT NOT NULL,
                blast_radius     TEXT NOT NULL,
                approval_status  TEXT,
                response_status  INTEGER,
                response_summary TEXT,
                error_code       TEXT,
                duration_ms      INTEGER NOT NULL,
                created_at       INTEGER NOT NULL
            )
        """)

        yield conn
        conn.close()

    def test_get_session_approvals_empty(self, db_conn):
        """Test getting approvals from empty database."""
        approvals = get_session_approvals("conv_123", db_conn)
        assert approvals == {}

    def test_get_session_approvals_with_data(self, db_conn):
        """Test getting session approvals."""
        # Insert some approved_session entries
        cursor = db_conn.cursor()
        cursor.execute("""
            INSERT INTO meraki_tool_calls (
                conversation_id, agent_id, tool_name, method, path,
                args_json, blast_radius, approval_status,
                response_status, response_summary, error_code,
                duration_ms, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            "conv_123",
            "agent_001",
            "meraki.networks.update-ssid",
            "PUT",
            "/path",
            "{}",
            "high",
            "approved_session",
            200,
            "OK",
            None,
            100,
            int(time.time() * 1000)
        ))

        # Insert an auto approval (should not be returned)
        cursor.execute("""
            INSERT INTO meraki_tool_calls (
                conversation_id, agent_id, tool_name, method, path,
                args_json, blast_radius, approval_status,
                response_status, response_summary, error_code,
                duration_ms, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            "conv_123",
            "agent_001",
            "meraki.organizations.list",
            "GET",
            "/path",
            "{}",
            "low",
            "auto",
            200,
            "OK",
            None,
            50,
            int(time.time() * 1000)
        ))

        db_conn.commit()

        # Get approvals
        approvals = get_session_approvals("conv_123", db_conn)

        # Should only return approved_session entries
        assert len(approvals) == 1
        assert "meraki.networks.update-ssid" in approvals
        assert approvals["meraki.networks.update-ssid"] == "approved_session"

    def test_get_session_approvals_different_conversation(self, db_conn):
        """Test that approvals are isolated by conversation."""
        # Insert approval for conv_123
        cursor = db_conn.cursor()
        cursor.execute("""
            INSERT INTO meraki_tool_calls (
                conversation_id, agent_id, tool_name, method, path,
                args_json, blast_radius, approval_status,
                response_status, response_summary, error_code,
                duration_ms, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            "conv_123",
            "agent_001",
            "meraki.networks.update-ssid",
            "PUT",
            "/path",
            "{}",
            "high",
            "approved_session",
            200,
            "OK",
            None,
            100,
            int(time.time() * 1000)
        ))
        db_conn.commit()

        # Query for different conversation
        approvals = get_session_approvals("conv_456", db_conn)

        # Should be empty
        assert approvals == {}

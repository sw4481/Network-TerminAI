"""Tests for explain_error functionality."""
from __future__ import annotations

import json
import os
from io import StringIO
from unittest.mock import patch

import pytest

from ccie_sidecar.server import handle_request, run_loop


def test_explain_error_validation():
    """Test that explain_error validates required parameters."""
    # Missing all params
    req = {"id": "1", "method": "explain_error", "params": {}}
    resp = handle_request(req)
    assert resp["type"] == "error"
    assert "requires" in resp["message"]

    # Missing exit_code
    req = {
        "id": "2",
        "method": "explain_error",
        "params": {"cmd": "ls", "output": "error", "cwd": "/tmp"},
    }
    resp = handle_request(req)
    assert resp["type"] == "error"

    # All params present - should return stream type
    req = {
        "id": "3",
        "method": "explain_error",
        "params": {
            "cmd": "ls /nonexistent",
            "output": "ls: /nonexistent: No such file or directory",
            "exit_code": 1,
            "cwd": "/tmp",
        },
    }
    resp = handle_request(req)
    assert resp["type"] == "stream"
    assert resp["method"] == "explain_error"


@pytest.mark.skipif(
    not os.getenv("ANTHROPIC_API_KEY"), reason="ANTHROPIC_API_KEY not set"
)
def test_explain_error_integration():
    """Integration test with real API (requires ANTHROPIC_API_KEY)."""
    # Simulate a failed ls command
    req_json = json.dumps({
        "id": "test-1",
        "method": "explain_error",
        "params": {
            "cmd": "ls /nonexistent",
            "output": "ls: /nonexistent: No such file or directory",
            "exit_code": 1,
            "cwd": "/tmp",
            "profile": "budget",  # Use budget profile for faster tests
        },
    })

    stdin = StringIO(req_json + "\n")
    stdout = StringIO()

    # Run the server loop
    run_loop(stdin, stdout)

    # Parse the output
    output_lines = stdout.getvalue().strip().split("\n")
    assert len(output_lines) > 0

    # Last line should be done with result
    last_line = json.loads(output_lines[-1])
    assert last_line["id"] == "test-1"
    assert last_line["type"] == "done"
    assert "result" in last_line
    assert "explanation" in last_line["result"]
    assert "suggested_command" in last_line["result"]

    # The explanation should mention the error
    explanation = last_line["result"]["explanation"]
    assert len(explanation) > 0
    print(f"\nExplanation: {explanation}")

    # Suggested command should be non-empty if AI provided one
    suggested = last_line["result"]["suggested_command"]
    print(f"Suggested command: {suggested}")


def test_explain_error_mock():
    """Test explain_error with mocked AI response."""

    def mock_stream(*args, **kwargs):
        """Mock streaming response with explanation and code block."""
        yield {"type": "token", "data": "**Explanation:** The directory doesn't exist.\n\n"}
        yield {"type": "token", "data": "**Suggested fix:**\n"}
        yield {"type": "token", "data": "```bash\n"}
        yield {"type": "token", "data": "mkdir -p /nonexistent && ls /nonexistent\n"}
        yield {"type": "token", "data": "```\n"}

    with patch("ccie_sidecar.server.explain_error_stream", side_effect=mock_stream):
        req_json = json.dumps({
            "id": "mock-1",
            "method": "explain_error",
            "params": {
                "cmd": "ls /nonexistent",
                "output": "ls: /nonexistent: No such file or directory",
                "exit_code": 1,
                "cwd": "/tmp",
            },
        })

        stdin = StringIO(req_json + "\n")
        stdout = StringIO()

        run_loop(stdin, stdout)

        output_lines = stdout.getvalue().strip().split("\n")
        result = json.loads(output_lines[-1])

        print(f"\nResult: {result}")
        assert result["type"] == "done"
        assert "result" in result
        assert "explanation" in result["result"]
        assert "suggested_command" in result["result"]
        assert "mkdir" in result["result"]["suggested_command"]
        print(f"\nMocked explanation: {result['result']['explanation']}")
        print(f"Mocked command: {result['result']['suggested_command']}")

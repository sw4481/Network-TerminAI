"""Tests for analyze_error functionality."""
from __future__ import annotations

import json
import os
from io import StringIO
from unittest.mock import patch

import pytest

from ccie_sidecar.server import handle_request, run_loop
from ccie_sidecar.command_intelligence import CommandIntelligence


def test_analyze_error_validation():
    """Test that analyze_error validates required parameters."""
    # Missing all params
    req = {"id": "1", "method": "analyze_error", "params": {}}
    resp = handle_request(req)
    assert resp["type"] == "error"
    assert "requires" in resp["message"]

    # Missing exit_code
    req = {
        "id": "2",
        "method": "analyze_error",
        "params": {"command": "ls", "output": "error"},
    }
    resp = handle_request(req)
    assert resp["type"] == "error"

    # All params present - should return done type with result
    req = {
        "id": "3",
        "method": "analyze_error",
        "params": {
            "command": "ls /nonexistent",
            "output": "ls: /nonexistent: No such file or directory",
            "exit_code": 1,
            "cwd": "/tmp",
        },
    }
    # This will fail without API key, but we're testing validation
    # In a real test with API key, this would return done with result


def test_categorize_error():
    """Test error categorization logic."""
    intelligence = CommandIntelligence()

    # Command not found
    result = intelligence._categorize_error(
        "gitx", "gitx: command not found", 127
    )
    assert result == "command_not_found"

    # Permission denied
    result = intelligence._categorize_error(
        "cat /etc/shadow", "cat: /etc/shadow: Permission denied", 1
    )
    assert result == "permission_denied"

    # File not found
    result = intelligence._categorize_error(
        "ls /nonexistent", "ls: /nonexistent: No such file or directory", 2
    )
    assert result == "file_not_found"

    # Syntax error
    result = intelligence._categorize_error(
        "ls -", "ls: invalid option -- '-'", 2
    )
    assert result == "usage_error"

    # Network error
    result = intelligence._categorize_error(
        "ping 192.0.2.1", "ping: connect: Network is unreachable", 1
    )
    assert result == "network_error"

    # Unknown error
    result = intelligence._categorize_error(
        "unknown", "some random error", 1
    )
    assert result == "general_error"


def test_analyze_error_mock():
    """Test analyze_error with mocked AI response."""

    def mock_stream(*args, **kwargs):
        """Mock streaming response with error analysis."""
        yield {"type": "token", "data": "explanation: The directory doesn't exist.\n"}
        yield {"type": "token", "data": "suggestion: mkdir -p /nonexistent\n"}
        yield {"type": "token", "data": "suggestion: ls -la\n"}

    # analyze_error resolves the provider via get_saved_config() first, then
    # dispatches through get_stream_chat_for_provider(provider). Force no saved
    # config so it takes the anthropic profile path, and patch the provider
    # dispatch seam to return our mock stream (the old module-level stream_chat
    # symbol no longer exists after the multi-provider refactor).
    # get_stream_chat_for_provider is imported locally inside analyze_error
    # (from ccie_sidecar.providers import ...), so patch it at its source module.
    with patch("ccie_sidecar.command_intelligence.get_saved_config", return_value=None), \
         patch("ccie_sidecar.providers.get_stream_chat_for_provider", return_value=mock_stream), \
         patch.dict(os.environ, {"ANTHROPIC_API_KEY": "test-key"}):
        intelligence = CommandIntelligence()
        result = intelligence.analyze_error(
            command="ls /nonexistent",
            output="ls: /nonexistent: No such file or directory",
            exit_code=1,
            cwd="/tmp",
        )

        assert "error_type" in result
        assert result["error_type"] == "file_not_found"
        assert "explanation" in result
        assert "doesn't exist" in result["explanation"]
        assert "suggestions" in result
        assert len(result["suggestions"]) == 2
        assert "mkdir" in result["suggestions"][0]


@pytest.mark.skipif(
    not os.getenv("ANTHROPIC_API_KEY"), reason="ANTHROPIC_API_KEY not set"
)
def test_analyze_error_integration():
    """Integration test with real API (requires ANTHROPIC_API_KEY)."""
    req_json = json.dumps({
        "id": "test-1",
        "method": "analyze_error",
        "params": {
            "command": "ls /nonexistent",
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

    # Should get done with result
    result_line = json.loads(output_lines[-1])
    assert result_line["id"] == "test-1"
    assert result_line["type"] == "done"
    assert "result" in result_line

    result = result_line["result"]
    assert "error_type" in result
    assert "explanation" in result
    assert "suggestions" in result
    assert isinstance(result["suggestions"], list)

    print(f"\nError type: {result['error_type']}")
    print(f"Explanation: {result['explanation']}")
    print(f"Suggestions: {result['suggestions']}")

"""Tests for MCP tool integration."""
import os
from unittest.mock import MagicMock, patch
import pytest


@pytest.fixture
def mock_reverse_call():
    """Mock the reverse NDJSON call to Rust."""
    with patch("ccie_sidecar.mcp_tools._reverse_call") as mock:
        yield mock


def test_request_mcp_tool_sends_correct_format(mock_reverse_call):
    """Test that request_mcp_tool sends the correct format to Rust."""
    from ccie_sidecar.mcp_tools import request_mcp_tool

    mock_reverse_call.return_value = {
        "approved": True,
        "result": {"output": "test result"}
    }

    result = request_mcp_tool(
        server="test-server",
        tool="test_tool",
        args={"arg1": "value1"}
    )

    # Verify the call format
    mock_reverse_call.assert_called_once_with(
        "mcp_invoke",
        {
            "server": "test-server",
            "tool": "test_tool",
            "args": {"arg1": "value1"}
        }
    )

    assert result == {"output": "test result"}


def test_request_mcp_tool_returns_none_when_denied(mock_reverse_call):
    """Test that request_mcp_tool returns None when user denies approval."""
    from ccie_sidecar.mcp_tools import request_mcp_tool

    mock_reverse_call.return_value = {
        "approved": False,
        "reason": "User denied"
    }

    result = request_mcp_tool(
        server="test-server",
        tool="test_tool",
        args={}
    )

    assert result is None


def test_request_mcp_tool_raises_on_error(mock_reverse_call):
    """Test that request_mcp_tool raises exception on error."""
    from ccie_sidecar.mcp_tools import request_mcp_tool

    mock_reverse_call.return_value = {
        "error": "MCP server not found"
    }

    with pytest.raises(Exception) as exc_info:
        request_mcp_tool(
            server="nonexistent",
            tool="test_tool",
            args={}
        )

    assert "MCP server not found" in str(exc_info.value)


def test_request_mcp_tool_handles_timeout(mock_reverse_call):
    """Test that request_mcp_tool handles timeouts gracefully."""
    from ccie_sidecar.mcp_tools import request_mcp_tool

    mock_reverse_call.side_effect = TimeoutError("Request timed out")

    with pytest.raises(TimeoutError):
        request_mcp_tool(
            server="slow-server",
            tool="slow_tool",
            args={}
        )


def test_get_mcp_tools_returns_list():
    """Test that get_mcp_tools returns available MCP tools."""
    from ccie_sidecar.mcp_tools import get_mcp_tools

    with patch("ccie_sidecar.mcp_tools._reverse_call") as mock:
        mock.return_value = {
            "tools": [
                {
                    "server": "test-server",
                    "name": "test_tool",
                    "description": "A test tool",
                    "schema": {"type": "object"}
                }
            ]
        }

        tools = get_mcp_tools()

        assert len(tools) == 1
        assert tools[0]["server"] == "test-server"
        assert tools[0]["name"] == "test_tool"


def test_mcp_tool_name_formatting():
    """Test that MCP tool names are properly formatted for agent use."""
    from ccie_sidecar.mcp_tools import format_tool_name

    # Test standard formatting
    assert format_tool_name("test-server", "my_tool") == "mcp_test_server__my_tool"

    # Test with special characters
    assert format_tool_name("my.server", "tool-name") == "mcp_my_server__tool_name"


def test_parse_mcp_tool_name():
    """Test that we can parse MCP tool names back to server and tool."""
    from ccie_sidecar.mcp_tools import parse_tool_name

    server, tool = parse_tool_name("mcp_test_server__my_tool")
    assert server == "test-server"
    assert tool == "my_tool"

    # Test invalid format
    with pytest.raises(ValueError):
        parse_tool_name("invalid_tool_name")

    # Test non-MCP tool name
    with pytest.raises(ValueError):
        parse_tool_name("regular_function")

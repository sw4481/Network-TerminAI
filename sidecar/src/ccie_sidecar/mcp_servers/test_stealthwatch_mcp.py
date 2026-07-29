import json
import os
import pytest
from unittest.mock import Mock, patch, MagicMock
from io import StringIO


def parse_jsonrpc_response(line):
    """Parse a single JSON-RPC response line."""
    return json.loads(line.strip())


def test_initialize_returns_capabilities():
    """Test MCP initialize handshake."""
    from . import stealthwatch_mcp

    request = {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {}
    }

    response = stealthwatch_mcp.handle_request(request)

    assert response["jsonrpc"] == "2.0"
    assert response["id"] == 1
    assert "result" in response
    assert response["result"]["protocolVersion"] == "2024-11-05"
    assert response["result"]["serverInfo"]["name"] == "stealthwatch-mcp"
    assert "capabilities" in response["result"]


def test_tools_list_returns_single_tool():
    """Test tools/list returns stealthwatch_api_call definition."""
    from . import stealthwatch_mcp

    request = {
        "jsonrpc": "2.0",
        "id": 2,
        "method": "tools/list",
        "params": {}
    }

    response = stealthwatch_mcp.handle_request(request)

    assert response["jsonrpc"] == "2.0"
    assert response["id"] == 2
    assert "result" in response
    assert "tools" in response["result"]
    assert len(response["result"]["tools"]) == 1

    tool = response["result"]["tools"][0]
    assert tool["name"] == "stealthwatch_api_call"
    assert "description" in tool
    assert "BLAST RADIUS" in tool["description"]
    assert "inputSchema" in tool
    assert "method" in tool["inputSchema"]["properties"]
    assert "path" in tool["inputSchema"]["properties"]


def test_blast_radius_classification():
    """Test blast radius tier classification logic."""
    from . import stealthwatch_mcp

    assert stealthwatch_mcp.get_blast_radius("GET", "/any/path") == "low"
    assert stealthwatch_mcp.get_blast_radius("DELETE", "/any/path") == "destructive"
    assert stealthwatch_mcp.get_blast_radius("POST", "/tenants/123/tags") == "high"
    assert stealthwatch_mcp.get_blast_radius("PUT", "/tenants/123/custom-security-events") == "high"
    assert stealthwatch_mcp.get_blast_radius("POST", "/tenants/123/flows/queries") == "medium"


def test_tools_call_authenticates_and_calls_api():
    """Test tools/call performs authentication and API request."""
    from . import stealthwatch_mcp

    request = {
        "jsonrpc": "2.0",
        "id": 3,
        "method": "tools/call",
        "params": {
            "name": "stealthwatch_api_call",
            "arguments": {
                "method": "GET",
                "path": "/sw-reporting/v1/tenants/123/hosts"
            }
        }
    }

    with patch.dict(os.environ, {
        "STEALTHWATCH_HOST": "smc.test.local",
        "STEALTHWATCH_USERNAME": "admin",
        "STEALTHWATCH_PASSWORD": "secret",
        "STEALTHWATCH_VERIFY_SSL": "1"
    }):
        # The shared StealthwatchClient uses a persistent requests.Session whose
        # login response sets the XSRF-TOKEN cookie (mirrors the real SMC).
        with patch("ccie_sidecar.stealthwatch.requests.Session") as mock_session_cls:
            mock_session = MagicMock()
            mock_session.cookies.get.return_value = "token123"  # XSRF-TOKEN cookie

            mock_auth_response = Mock()
            mock_auth_response.status_code = 200
            mock_session.post.return_value = mock_auth_response

            mock_api_response = Mock()
            mock_api_response.status_code = 200
            mock_api_response.json.return_value = {"hosts": [{"id": 1, "ip": "10.0.0.1"}]}
            mock_session.request.return_value = mock_api_response

            mock_session_cls.return_value = mock_session

            # Reset the cached client so it re-reads the patched env/session.
            stealthwatch_mcp._client = None

            response = stealthwatch_mcp.handle_request(request)

            assert response["jsonrpc"] == "2.0"
            assert response["id"] == 3
            assert "result" in response
            assert response["result"]["blast_radius"] == "low"
            assert len(response["result"]["content"]) == 1
            assert "hosts" in response["result"]["content"][0]["text"]

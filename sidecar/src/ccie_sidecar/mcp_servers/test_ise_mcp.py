import json
import os
from unittest.mock import Mock, patch, MagicMock


def parse_jsonrpc_response(line):
    """Parse a single JSON-RPC response line."""
    return json.loads(line.strip())


def test_initialize_returns_capabilities():
    """Test MCP initialize handshake."""
    from . import ise_mcp

    request = {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {}
    }

    response = ise_mcp.handle_request(request)

    assert response["jsonrpc"] == "2.0"
    assert response["id"] == 1
    assert "result" in response
    assert response["result"]["protocolVersion"] == "2024-11-05"
    assert response["result"]["serverInfo"]["name"] == "ise-mcp"
    assert "capabilities" in response["result"]


def test_tools_list_returns_single_tool():
    """Test tools/list returns the single ise_api_call definition."""
    from . import ise_mcp

    request = {
        "jsonrpc": "2.0",
        "id": 2,
        "method": "tools/list",
        "params": {}
    }

    response = ise_mcp.handle_request(request)

    assert response["jsonrpc"] == "2.0"
    assert response["id"] == 2
    assert "result" in response
    assert "tools" in response["result"]
    assert len(response["result"]["tools"]) == 1

    tool = response["result"]["tools"][0]
    assert tool["name"] == "ise_api_call"
    assert "description" in tool
    assert "BLAST RADIUS" in tool["description"]
    assert "inputSchema" in tool
    assert "method" in tool["inputSchema"]["properties"]
    assert "path" in tool["inputSchema"]["properties"]
    assert "base" in tool["inputSchema"]["properties"]


def test_blast_radius_classification():
    """Test blast radius tier classification logic."""
    from . import ise_mcp

    assert ise_mcp.get_blast_radius("GET", "/ers/config/endpoint") == "low"
    assert ise_mcp.get_blast_radius("DELETE", "/ers/config/networkdevice/1") == "destructive"
    assert ise_mcp.get_blast_radius("POST", "/ers/config/networkdevice") == "high"
    assert ise_mcp.get_blast_radius("POST", "/ers/config/internaluser") == "high"
    assert ise_mcp.get_blast_radius("POST", "/ers/config/sgt") == "high"
    # MnT is always low even on non-GET (it is read-only anyway)
    assert ise_mcp.get_blast_radius("GET", "/admin/API/mnt/Session/ActiveList") == "low"


def test_tools_call_authenticates_and_calls_api():
    """Test tools/call performs a Basic-Auth API request."""
    from . import ise_mcp

    request = {
        "jsonrpc": "2.0",
        "id": 3,
        "method": "tools/call",
        "params": {
            "name": "ise_api_call",
            "arguments": {
                "method": "GET",
                "path": "/ers/config/networkdevice"
            }
        }
    }

    with patch.dict(os.environ, {
        "ISE_HOST": "ise.test.local",
        "ISE_USERNAME": "admin",
        "ISE_PASSWORD": "secret",
        "ISE_VERIFY_SSL": "1"
    }):
        with patch("ccie_sidecar.ise.requests.Session") as mock_session_cls:
            mock_session = MagicMock()

            mock_api_response = Mock()
            mock_api_response.status_code = 200
            mock_api_response.json.return_value = {
                "SearchResult": {"total": 1, "resources": [{"id": "1", "name": "sw1"}]}
            }
            mock_session.request.return_value = mock_api_response
            mock_session_cls.return_value = mock_session

            # Reset the cached client so it re-reads the patched env/session.
            ise_mcp._client = None

            response = ise_mcp.handle_request(request)

            assert response["jsonrpc"] == "2.0"
            assert response["id"] == 3
            assert "result" in response
            assert response["result"]["blast_radius"] == "low"
            assert len(response["result"]["content"]) == 1
            assert "SearchResult" in response["result"]["content"][0]["text"]


def test_tools_call_routes_mnt_to_admin_port():
    """A MnT path should hit the :443 admin port, not :9060."""
    from . import ise_mcp

    request = {
        "jsonrpc": "2.0",
        "id": 4,
        "method": "tools/call",
        "params": {
            "name": "ise_api_call",
            "arguments": {
                "method": "GET",
                "path": "/admin/API/mnt/Session/ActiveCount",
            }
        }
    }

    with patch.dict(os.environ, {
        "ISE_HOST": "ise.test.local",
        "ISE_USERNAME": "admin",
        "ISE_PASSWORD": "secret",
        "ISE_VERIFY_SSL": "0",
    }):
        with patch("ccie_sidecar.ise.requests.Session") as mock_session_cls:
            mock_session = MagicMock()
            mock_resp = Mock()
            mock_resp.status_code = 200
            mock_resp.json.return_value = {"count": 3}
            mock_session.request.return_value = mock_resp
            mock_session_cls.return_value = mock_session

            ise_mcp._client = None
            ise_mcp.handle_request(request)

            # The URL passed to session.request must use the :443 admin port.
            _, kwargs = mock_session.request.call_args
            assert kwargs["url"] == "https://ise.test.local:443/admin/API/mnt/Session/ActiveCount"

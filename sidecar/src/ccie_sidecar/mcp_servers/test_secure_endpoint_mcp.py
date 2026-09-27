from ccie_sidecar.mcp_servers import secure_endpoint_mcp as srv


def test_initialize():
    resp = srv.handle_request({"jsonrpc": "2.0", "id": 1, "method": "initialize"})
    assert resp["result"]["serverInfo"]["name"] == "secure-endpoint-mcp"


def test_tools_list_exposes_single_tool():
    resp = srv.handle_request({"jsonrpc": "2.0", "id": 2, "method": "tools/list"})
    tools = resp["result"]["tools"]
    assert len(tools) == 1
    t = tools[0]
    assert t["name"] == "secure_endpoint_api_call"
    props = t["inputSchema"]["properties"]
    assert set(["method", "path", "body", "query_params"]).issubset(props.keys())
    assert t["inputSchema"]["required"] == ["method", "path"]
    # The description must teach the model the envelope + key paths.
    assert "/v1/computers" in t["description"]
    assert "isolation" in t["description"]


def test_tools_call_unknown_tool_errors():
    resp = srv.handle_request({
        "jsonrpc": "2.0", "id": 3, "method": "tools/call",
        "params": {"name": "nope", "arguments": {}},
    })
    assert resp["error"]["code"] == -32602


def test_tools_call_missing_args_errors():
    resp = srv.handle_request({
        "jsonrpc": "2.0", "id": 4, "method": "tools/call",
        "params": {"name": "secure_endpoint_api_call", "arguments": {"method": "GET"}},
    })
    assert resp["error"]["code"] == -32602

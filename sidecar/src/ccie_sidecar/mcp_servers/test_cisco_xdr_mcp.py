from ccie_sidecar.mcp_servers import cisco_xdr_mcp as srv


def test_initialize():
    resp = srv.handle_request({"jsonrpc": "2.0", "id": 1, "method": "initialize"})
    assert resp["result"]["serverInfo"]["name"] == "cisco-xdr-mcp"


def test_tools_list_exposes_single_tool():
    resp = srv.handle_request({"jsonrpc": "2.0", "id": 2, "method": "tools/list"})
    tools = resp["result"]["tools"]
    assert len(tools) == 1
    t = tools[0]
    assert t["name"] == "cisco_xdr_api_call"
    props = t["inputSchema"]["properties"]
    assert set(["method", "path", "body", "query_params"]).issubset(props.keys())
    assert t["inputSchema"]["required"] == ["method", "path"]
    # The description must teach the model the path-prefix host routing + key paths.
    desc = t["description"]
    assert "/iroh/*" in desc and "/ctia/*" in desc and "/v2/*" in desc and "/api/v1/*" in desc
    assert "observe/observables" in desc
    # Disambiguation: XDR uses no Secure-Endpoint-style host paths, but DOES
    # expose its devices via the CTIA asset store (the wording must not deny that).
    assert "NO /v1/computers" in desc
    assert "/ctia/asset/search" in desc
    # Incident search shape must be taught (the live-debug fix).
    assert "/v2/incident/search" in desc and "query is REQUIRED" in desc


def test_description_is_single_source_of_truth():
    """The MCP tool description must embed the shared XDR_CAPABILITIES_DOC constant
    so it can never drift from the in-sandbox client-section."""
    from ccie_sidecar.cisco_xdr import XDR_CAPABILITIES_DOC
    assert XDR_CAPABILITIES_DOC in srv.get_tool_description()


def test_tools_call_unknown_tool_errors():
    resp = srv.handle_request({
        "jsonrpc": "2.0", "id": 3, "method": "tools/call",
        "params": {"name": "nope", "arguments": {}},
    })
    assert resp["error"]["code"] == -32602


def test_tools_call_missing_args_errors():
    resp = srv.handle_request({
        "jsonrpc": "2.0", "id": 4, "method": "tools/call",
        "params": {"name": "cisco_xdr_api_call", "arguments": {"method": "GET"}},
    })
    assert resp["error"]["code"] == -32602

"""Contract tests for the dedicated Topolograph adapter."""

from dataclasses import FrozenInstanceError

import pytest
import requests

from ccie_sidecar.topolograph import (
    CERTIFIED_TOOL_ALLOWLIST,
    TopolographClient,
    TopolographConnectionReport,
    TopolographError,
    TopolographRuntimeConfig,
)


CERTIFIED_TOOLS = (
    "get_graph_by_time",
    "get_all_graphs",
    "get_network_by_graph_time",
    "get_graph_status",
    "get_network_events",
    "get_adjacency_events",
    "get_events_timeline",
    "get_nodes",
    "get_edges",
    "get_lsps",
    "get_shortest_path",
    "get_cspf_path",
    "get_edge_failure_reaction",
    "list_bgp_graphs",
    "get_bgp_graph",
    "list_bgp_nodes",
    "list_bgp_sessions",
    "search_bgp_routes",
    "get_bgp_node_route_summary",
    "get_bgp_route_state",
    "compare_bgp_routes",
    "get_bgp_events_timeline",
    "list_bgp_bindings",
    "get_bgp_binding",
    "resolve_route",
    "get_vrf_inventory",
    "list_vpn_routers",
    "upload_graph",
    "add_lsp",
    "update_lsp",
    "delete_lsp",
)


class FakeResponse:
    def __init__(self, payload=None, *, status_code=200, content_type="application/json", headers=None, text=None):
        self.status_code = status_code
        self.headers = {"Content-Type": content_type, **(headers or {})}
        self._payload = payload
        self.text = text if text is not None else ("" if payload is None else str(payload))

    def json(self):
        if isinstance(self._payload, Exception):
            raise self._payload
        return self._payload


class FakeSession:
    def __init__(self, outcomes):
        self.outcomes = list(outcomes)
        self.calls = []

    def request(self, **kwargs):
        self.calls.append(kwargs)
        outcome = self.outcomes.pop(0)
        if isinstance(outcome, Exception):
            raise outcome
        return outcome


def rpc_result(request_id, result, *, content_type="application/json", headers=None):
    return FakeResponse(
        {"jsonrpc": "2.0", "id": request_id, "result": result},
        content_type=content_type,
        headers=headers,
    )


def make_client(session, clock=None):
    return TopolographClient(
        TopolographRuntimeConfig("https://topolograph.example:8080", True),
        "private-test-token",
        session=session,
        clock=clock or (lambda: 10.0),
    )


def test_certified_allowlist_contains_exactly_the_31_approved_tools():
    assert CERTIFIED_TOOL_ALLOWLIST == frozenset(CERTIFIED_TOOLS)


def test_runtime_config_is_frozen_and_report_is_frozen():
    config = TopolographRuntimeConfig("http://localhost:8080", False)
    report = TopolographConnectionReport("server", "1.0", 2.5, ("get_all_graphs",), ())

    with pytest.raises(FrozenInstanceError):
        config.base_url = "http://other.example"
    with pytest.raises(FrozenInstanceError):
        report.server_name = "other"


def test_test_connection_initializes_lists_tools_and_runs_bounded_probe_with_json_and_sse():
    sse_tools = "data: {\"jsonrpc\":\"2.0\",\"id\":2,\"result\":{\"tools\":[" + \
        ",".join('{"name":"' + name + '"}' for name in CERTIFIED_TOOLS) + \
        ',{"name":"future_tool"}]}}\n\ndata: [DONE]\n'
    session = FakeSession([
        rpc_result(1, {
            "protocolVersion": "2025-06-18",
            "serverInfo": {"name": "Topolograph MCP", "version": "1.3.1"},
            "capabilities": {},
        }, headers={"Mcp-Session-Id": "session-1"}),
        FakeResponse(None, status_code=202, content_type="application/json"),
        FakeResponse(
            None,
            content_type="text/event-stream",
            text=sse_tools,
        ),
        rpc_result(3, {"content": [{"type": "text", "text": "[]"}]}),
    ])
    times = iter((100.0, 100.0125))

    report = make_client(session, clock=lambda: next(times)).test_connection()

    assert report == TopolographConnectionReport(
        "Topolograph MCP", "1.3.1", 12.5,
        (*CERTIFIED_TOOLS, "future_tool"),
        ("future_tool",),
        (("initialize", "passed"), ("tool_inventory", "passed"), ("bounded_probe", "passed")),
    )
    assert [call["url"] for call in session.calls] == [
        "https://topolograph.example:8080/mcp",
        "https://topolograph.example:8080/mcp",
        "https://topolograph.example:8080/mcp",
        "https://topolograph.example:8080/mcp",
    ]
    assert session.calls[0]["json"]["method"] == "initialize"
    assert session.calls[1]["json"]["method"] == "notifications/initialized"
    assert session.calls[2]["headers"]["MCP-Session-Id"] == "session-1"
    assert session.calls[3]["json"] == {
        "jsonrpc": "2.0", "id": 3, "method": "tools/call",
        "params": {"name": "get_all_graphs", "arguments": {"page": 1, "per_page": 1}},
    }
    assert "private-test-token" not in repr(report)


def test_test_connection_rejects_missing_required_probe_tool_without_calling_it():
    session = FakeSession([
        rpc_result(1, {
            "protocolVersion": "2025-06-18",
            "serverInfo": {"name": "server", "version": "1"},
            "capabilities": {},
        }),
        FakeResponse(None, status_code=202),
        rpc_result(2, {"tools": [{"name": "get_graph_status"}]}),
    ])

    with pytest.raises(TopolographError) as exc_info:
        make_client(session).test_connection()

    assert exc_info.value.code == "REQUIRED_TOOL_MISSING"
    assert len(session.calls) == 3


def test_read_tool_retries_once_after_timeout():
    session = FakeSession([
        requests.exceptions.Timeout(),
        rpc_result(1, {"content": [{"type": "text", "text": "ok"}]}),
    ])

    result = make_client(session).call_tool("get_graph_status", {"graph_id": "g1"})

    assert result == {"content": [{"type": "text", "text": "ok"}]}
    assert len(session.calls) == 2


def test_sse_read_accepts_crlf_event_framing():
    session = FakeSession([
        FakeResponse(
            None,
            content_type="text/event-stream",
            text='data: {"jsonrpc":"2.0","id":1,"result":{"ok":true}}\r\n\r\n',
        ),
    ])

    assert make_client(session).call_tool("get_graph_status") == {"ok": True}


def test_sse_read_ignores_crlf_notifications_before_final_result():
    session = FakeSession([
        FakeResponse(
            None,
            content_type="text/event-stream",
            text=(
                'data: {"jsonrpc":"2.0","method":"notifications/progress"}\r\n\r\n'
                'data: {"jsonrpc":"2.0","id":1,"result":{"ok":true}}\r\n\r\n'
            ),
        ),
    ])

    assert make_client(session).call_tool("get_graph_status") == {"ok": True}


def test_mutation_does_not_retry_and_does_not_leak_token_or_payload_on_reset():
    session = FakeSession([requests.exceptions.ConnectionError("connection reset private-test-token")])

    with pytest.raises(TopolographError) as exc_info:
        make_client(session).call_tool("add_lsp", {"secret": "raw-payload"})

    assert exc_info.value.code == "UPSTREAM_UNAVAILABLE"
    assert len(session.calls) == 1
    assert "private-test-token" not in str(exc_info.value)
    assert "raw-payload" not in str(exc_info.value)


@pytest.mark.parametrize("arguments", [{}, {"lsp_name": ""}, {"unexpected": True}])
def test_generic_delete_lsp_requires_named_lsp_or_explicit_delete_all(arguments):
    session = FakeSession([])

    with pytest.raises(TopolographError) as exc_info:
        make_client(session).call_tool("delete_lsp", arguments)

    assert exc_info.value.code == "DELETE_CONFIRMATION_REQUIRED"
    assert session.calls == []


def test_generic_delete_lsp_allows_named_or_explicit_delete_all():
    session = FakeSession([
        rpc_result(1, {"ok": True}),
        rpc_result(1, {"ok": True}),
    ])

    assert make_client(session).call_tool("delete_lsp", {"lsp_name": "edge-1"}) == {"ok": True}
    assert make_client(session).call_tool("delete_lsp", {"delete_all": True}) == {"ok": True}


def test_uncertified_tool_is_rejected_before_network_call():
    session = FakeSession([])

    with pytest.raises(TopolographError) as exc_info:
        make_client(session).call_tool("delete_database", {})

    assert exc_info.value.code == "TOOL_NOT_CERTIFIED"
    assert session.calls == []


def test_delete_lsp_requires_name_or_explicit_bulk_confirmation():
    session = FakeSession([])
    client = make_client(session)

    with pytest.raises(TopolographError) as exc_info:
        client.delete_lsp()
    assert exc_info.value.code == "DELETE_CONFIRMATION_REQUIRED"
    assert session.calls == []


def test_delete_lsp_allows_named_and_explicit_bulk_deletes_without_retry():
    session = FakeSession([
        rpc_result(1, {"content": [{"type": "text", "text": "named"}]}),
        rpc_result(2, {"content": [{"type": "text", "text": "all"}]}),
    ])
    client = make_client(session)

    assert client.delete_lsp(lsp_name="LSP-1") == {"content": [{"type": "text", "text": "named"}]}
    assert client.delete_lsp(delete_all=True) == {"content": [{"type": "text", "text": "all"}]}
    assert session.calls[0]["json"]["params"]["arguments"] == {"lsp_name": "LSP-1"}
    assert session.calls[1]["json"]["params"]["arguments"] == {"delete_all": True}


def test_upload_lsdb_sends_the_swagger_json_payload():
    session = FakeSession([
        FakeResponse({"accepted": True}),
    ])
    client = make_client(session)

    assert client.upload_lsdb("LSDB CONTENT", "Cisco", "ospf", "nightly") == {"accepted": True}

    assert session.calls[0]["url"] == "https://topolograph.example:8080/api/graph/"
    assert session.calls[0]["headers"]["Content-Type"] == "application/json"
    assert session.calls[0]["json"] == {
        "lsdb_output": "LSDB CONTENT",
        "vendor_device": "Cisco",
        "igp_protocol": "ospf",
        "graph_description": "nightly",
    }
    assert "files" not in session.calls[0]
    assert "data" not in session.calls[0]


def test_upload_yaml_sends_the_swagger_json_payload():
    session = FakeSession([FakeResponse({"accepted": True})])
    client = make_client(session)

    assert client.upload_yaml("diagram: {}") == {"accepted": True}

    assert session.calls[0]["url"] == "https://topolograph.example:8080/api/diagram"
    assert session.calls[0]["headers"]["Content-Type"] == "application/json"
    assert session.calls[0]["json"] == {"yaml_diagram_str": "diagram: {}"}
    assert "files" not in session.calls[0]
    assert "data" not in session.calls[0]


def test_upload_lsdb_rejects_invalid_protocol_and_url_credentials():
    session = FakeSession([])
    client = make_client(session)

    with pytest.raises(TopolographError) as protocol_error:
        client.upload_lsdb("content", "Cisco", "bgp")
    assert protocol_error.value.code == "INVALID_UPLOAD"

    with pytest.raises(TopolographError) as url_error:
        TopolographClient(TopolographRuntimeConfig("https://user:password@example/mcp?token=x", True), "token", session=session)
    assert url_error.value.code == "INVALID_CONFIGURATION"
    assert "password" not in str(url_error.value)
    assert "token" not in str(url_error.value)

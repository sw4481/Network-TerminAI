"""Milestone A Task 5 tests for the direct Topolograph seams."""

import json
from pathlib import Path
from unittest.mock import patch

import pytest

from ccie_sidecar.server import handle_request
from ccie_sidecar.topolograph import TopolographError


class FakeTopolographClient:
    instances = []
    failure = None

    def __init__(self, config, token):
        self.config = config
        self.token = token
        type(self).instances.append(self)

    def test_connection(self):
        if self.failure:
            raise self.failure
        return {
            "server_name": "Topolograph MCP",
            "server_version": "1.3.1",
            "latency_ms": 4.2,
            "tools": ["get_all_graphs"],
            "unexpected_tools": [],
            "stages": [
                {"name": "initialize", "status": "passed"},
                {"name": "tool_inventory", "status": "passed"},
                {"name": "bounded_probe", "status": "passed"},
            ],
        }

    def call_tool(self, name, arguments):
        if self.failure:
            raise self.failure
        return {"name": name, "arguments": arguments}

    def upload_lsdb(self, content, vendor, protocol, description=None):
        if self.failure:
            raise self.failure
        return {"accepted": True, "vendor": vendor, "protocol": protocol}

    def upload_yaml(self, content):
        if self.failure:
            raise self.failure
        return {"accepted": True}


@pytest.fixture(autouse=True)
def reset_fake_client():
    FakeTopolographClient.instances = []
    FakeTopolographClient.failure = None


def direct_params(**overrides):
    params = {
        "base_url": "https://topolograph.example",
        "verify_tls": False,
        "token": "selected-token",
        "enabled": True,
        "configured": True,
        "unlocked": True,
    }
    params.update(overrides)
    return params


def test_direct_topolograph_methods_construct_private_client_and_forward_params():
    with patch("ccie_sidecar.topolograph.TopolographClient", FakeTopolographClient):
        connection = handle_request({
            "id": "connection",
            "method": "topolograph.test_connection",
            "params": direct_params(),
        })
        tool = handle_request({
            "id": "tool",
            "method": "topolograph.call_tool",
            "params": direct_params(name="get_all_graphs", arguments={"page": 1}),
        })
        lsdb = handle_request({
            "id": "lsdb",
            "method": "topolograph.upload_lsdb",
            "params": direct_params(
                content="raw LSDB body",
                vendor="Cisco",
                protocol="ospf",
                description="test upload",
            ),
        })
        yaml = handle_request({
            "id": "yaml",
            "method": "topolograph.upload_yaml",
            "params": direct_params(content="diagram: {}"),
        })

    assert connection["type"] == tool["type"] == lsdb["type"] == yaml["type"] == "done"
    assert FakeTopolographClient.instances
    assert all(instance.token == "selected-token" for instance in FakeTopolographClient.instances)
    assert connection["result"]["stages"] == [
        {"name": "initialize", "status": "passed"},
        {"name": "tool_inventory", "status": "passed"},
        {"name": "bounded_probe", "status": "passed"},
    ]
    assert tool["result"]["ok"] is True
    assert "summary" in tool["result"]
    assert lsdb["result"]["accepted"] is True
    assert yaml["result"]["accepted"] is True


def test_direct_topolograph_dispatch_validates_params_before_client_creation():
    with patch("ccie_sidecar.topolograph.TopolographClient", FakeTopolographClient):
        missing_url = handle_request({
            "id": "bad-url",
            "method": "topolograph.test_connection",
            "params": direct_params(base_url=None),
        })
        bad_arguments = handle_request({
            "id": "bad-args",
            "method": "topolograph.call_tool",
            "params": direct_params(name="get_all_graphs", arguments=["not-an-object"]),
        })

    assert missing_url["type"] == bad_arguments["type"] == "error"
    assert missing_url["code"] == bad_arguments["code"] == "INVALID_PARAMETERS"
    assert FakeTopolographClient.instances == []


def test_topolograph_errors_have_safe_codes_and_never_echo_token_or_body():
    FakeTopolographClient.failure = TopolographError(
        "UPSTREAM_RPC_ERROR", "Topolograph rejected the MCP request."
    )
    with patch("ccie_sidecar.topolograph.TopolographClient", FakeTopolographClient):
        response = handle_request({
            "id": "safe-error",
            "method": "topolograph.call_tool",
            "params": direct_params(name="get_all_graphs", arguments={"raw": "secret-body"}),
        })

    encoded = json.dumps(response)
    assert response["type"] == "error"
    assert response["code"] == "UPSTREAM_RPC_ERROR"
    assert "selected-token" not in encoded
    assert "secret-body" not in encoded


@pytest.mark.parametrize(
    "field, value, code",
    [
        ("enabled", False, "CONNECTOR_DISABLED"),
        ("configured", False, "CONNECTOR_UNCONFIGURED"),
        ("unlocked", False, "CONNECTOR_LOCKED"),
        ("token", "", "TOKEN_REQUIRED"),
    ],
)
def test_direct_topolograph_dispatch_requires_enabled_complete_unlocked_connector(
    field, value, code
):
    params = direct_params(**{field: value})
    with patch("ccie_sidecar.topolograph.TopolographClient", FakeTopolographClient):
        response = handle_request({
            "id": "gated",
            "method": "topolograph.call_tool",
            "params": direct_params(**{field: value}, name="get_all_graphs"),
        })

    assert response["type"] == "error"
    assert response["code"] == code
    assert FakeTopolographClient.instances == []


def test_topolograph_results_are_bounded_before_sidecar_or_model_visibility():
    raw_body = "RAW_TOPOLOGY_BODY " * 1000
    FakeTopolographClient.call_tool = lambda self, name, arguments: {
        "name": name,
        "content": [{"type": "text", "text": raw_body}],
        "graph": {"nodes": list(range(1000)), "edges": list(range(1000))},
    }
    with patch("ccie_sidecar.topolograph.TopolographClient", FakeTopolographClient):
        response = handle_request({
            "id": "bounded",
            "method": "topolograph.call_tool",
            "params": direct_params(name="get_all_graphs"),
        })

    encoded = json.dumps(response)
    assert len(encoded) < 4096
    assert raw_body not in encoded
    assert response["result"]["ok"] is True


def test_topolograph_bounded_results_discard_untrusted_text_metadata():
    from ccie_sidecar.server import _bounded_topolograph_result

    raw = "RAW_UPSTREAM_PAYLOAD selected-token " * 2000
    result = _bounded_topolograph_result({
        "ok": True,
        "message": raw,
        "warnings": [raw],
        "server_name": "OSPF_Analyser",
        "server_version": "1.3.1",
        "stages": [{"name": "initialize", "status": "passed"}],
    })

    encoded = json.dumps(result)
    assert raw not in encoded
    assert "selected-token" not in encoded
    assert result["summary"] == "Topolograph operation completed."


def test_topolograph_catalog_has_exactly_the_certified_names():
    catalog = json.loads(
        (Path(__file__).parents[2] / "bundled-agents" / "topolograph" / "tools.json")
        .read_text(encoding="utf-8")
    )
    from ccie_sidecar.topolograph import CERTIFIED_TOOL_ALLOWLIST

    assert len(catalog) == 31
    assert {entry["name"] for entry in catalog} == CERTIFIED_TOOL_ALLOWLIST
    assert all(entry.get("description") for entry in catalog)


def test_topolograph_is_routed_as_delegate_only_and_disabled_by_default():
    from ccie_sidecar.agents.architect_subagents import (
        DELEGATE_ONLY_VENDOR_IDS,
        VENDOR_SPECS,
        build_vendor_subagents,
        detect_vendor_ids,
    )

    assert "topolograph" in {spec["id"] for spec in VENDOR_SPECS}
    assert "topolograph" in DELEGATE_ONLY_VENDOR_IDS
    assert detect_vendor_ids("analyze Topolograph BGP routes", ["topolograph"]) == [
        "topolograph"
    ]
    assert not any(
        agent.get("name") == "topolograph-specialist"
        for agent in build_vendor_subagents(catalogs=[])
    )


def test_configured_topolograph_architect_routing_requires_the_delegate_specialist():
    from ccie_sidecar.agents.architect_subagents import architect_routing_hint

    hint = architect_routing_hint("inspect Topolograph graphs", ["topolograph"])
    assert "topolograph-specialist" in hint
    assert "shared inline sandbox" in hint


def test_topolograph_specialist_binding_is_secret_private_and_requires_complete_runtime_values():
    from ccie_sidecar.agents.architect_subagents import (
        TopolographAgentBinding,
        build_topolograph_specialist,
    )

    assert build_topolograph_specialist(None, catalogs=[]) is None
    binding = TopolographAgentBinding(
        base_url="https://topolograph.example",
        verify_tls=True,
        token="selected-token",
    )
    with patch("ccie_sidecar.topolograph.TopolographClient", FakeTopolographClient):
        specialist = build_topolograph_specialist(binding, catalogs=[])

    assert specialist is not None
    assert specialist["name"] == "topolograph-specialist"
    assert "selected-token" not in specialist["system_prompt"]
    assert all("selected-token" not in str(tool) for tool in specialist["tools"])


def test_topolograph_catalog_search_describes_its_available_operation_helper():
    from ccie_sidecar.agents.architect_subagents import (
        TopolographAgentBinding,
        build_topolograph_specialist,
    )

    catalog = json.loads(
        (Path(__file__).parents[2] / "bundled-agents" / "topolograph" / "tools.json")
        .read_text(encoding="utf-8")
    )
    binding = TopolographAgentBinding(
        "https://topolograph.example", True, "selected-token"
    )
    with patch("ccie_sidecar.topolograph.TopolographClient", FakeTopolographClient):
        specialist = build_topolograph_specialist(
            binding,
            catalogs=[{"id": "topolograph", "entries": catalog}],
        )
        tool_names = {tool.name for tool in specialist["tools"]}
        search_tool = next(
            tool for tool in specialist["tools"] if tool.name == "search_api_catalog"
        )

    assert tool_names == {"search_api_catalog", "topolograph_mcp_call"}
    assert "execute_python_code" not in search_tool.description
    assert "topolograph_mcp_call" in search_tool.description
    assert "matches[*].operation" in search_tool.description


def test_topolograph_specialist_calls_the_catalog_operation_not_its_record_label():
    from ccie_sidecar.agents.architect_subagents import (
        TopolographAgentBinding,
        build_topolograph_specialist,
    )
    from ccie_sidecar.agents.catalog_grounding import CatalogIndex

    catalog = json.loads(
        (Path(__file__).parents[2] / "bundled-agents" / "topolograph" / "tools.json")
        .read_text(encoding="utf-8")
    )
    match = CatalogIndex([{"id": "topolograph", "entries": catalog}]).search(
        "available Topolograph graphs",
        catalog_id="topolograph",
        limit=1,
    )["matches"][0]
    calls = []

    class RecordingClient(FakeTopolographClient):
        def call_tool(self, name, arguments):
            calls.append((name, arguments))
            return {"ok": True}

    binding = TopolographAgentBinding(
        "https://topolograph.example", True, "selected-token"
    )
    with patch("ccie_sidecar.topolograph.TopolographClient", RecordingClient):
        specialist = build_topolograph_specialist(
            binding,
            catalogs=[{"id": "topolograph", "entries": catalog}],
        )
        tool = next(
            tool
            for tool in specialist["tools"]
            if tool.name == "topolograph_mcp_call"
        )
        schema = tool.args_schema.model_json_schema()["properties"]
        tool.invoke({"operation": match["operation"], "arguments": {}})

    assert match["name"] == "get_all_graphs:get_all_graphs"
    assert match["operation"] == "get_all_graphs"
    assert "operation" in schema
    assert "name" not in schema
    assert calls == [("get_all_graphs", {})]


def test_topolograph_specialist_never_returns_raw_mcp_result_body():
    raw_body = "RAW_TOPOLOGY_BODY " * 1000
    FakeTopolographClient.call_tool = lambda self, name, arguments: {
        "content": [{"type": "text", "text": raw_body}],
        "nodes": list(range(1000)),
    }
    from ccie_sidecar.agents.architect_subagents import (
        TopolographAgentBinding,
        build_topolograph_specialist,
    )

    binding = TopolographAgentBinding("https://topolograph.example", True, "selected-token")
    with patch("ccie_sidecar.topolograph.TopolographClient", FakeTopolographClient):
        specialist = build_topolograph_specialist(binding, catalogs=[])
        tool = next(tool for tool in specialist["tools"] if tool.name == "topolograph_mcp_call")
        result = tool.invoke({"operation": "get_all_graphs", "arguments": {}})

    assert len(result) < 4096
    assert raw_body not in result
    assert "selected-token" not in result


def test_topolograph_specialist_discards_untrusted_message_and_warning_text():
    raw = "RAW_UPSTREAM_PAYLOAD selected-token " * 1000
    FakeTopolographClient.call_tool = lambda self, name, arguments: {
        "message": raw,
        "warnings": [raw],
    }
    from ccie_sidecar.agents.architect_subagents import (
        TopolographAgentBinding,
        build_topolograph_specialist,
    )

    binding = TopolographAgentBinding("https://topolograph.example", True, "selected-token")
    with patch("ccie_sidecar.topolograph.TopolographClient", FakeTopolographClient):
        specialist = build_topolograph_specialist(binding, catalogs=[])
        tool = next(tool for tool in specialist["tools"] if tool.name == "topolograph_mcp_call")
        result = tool.invoke({"operation": "get_all_graphs", "arguments": {}})

    assert raw not in result
    assert "selected-token" not in result


def test_production_deep_agent_definition_constructs_private_topolograph_binding_for_react_code():
    from ccie_sidecar.agents.architect_subagents import TopolographAgentBinding
    from ccie_sidecar.server import build_deepagents_agent_definition

    agent_def = build_deepagents_agent_definition(
        agent_id="network-architect",
        system_prompt="architect prompt",
        tools=[],
        vault_entry="",
        vault_secrets={"unrelated": "secret"},
        tool_id="meraki",
        topolograph_runtime={
            "base_url": "https://topolograph.example",
            "verify_tls": True,
            "token": "selected-token",
        },
    )

    assert isinstance(agent_def["topolograph_binding"], TopolographAgentBinding)
    assert agent_def["id"] == agent_def["agent_id"] == "network-architect"
    assert agent_def["topolograph_binding"].usable
    assert agent_def["topolograph_binding"].token == "selected-token"
    assert "selected-token" not in agent_def["system_prompt"]
    assert agent_def["attached_tools"] == [{
        "catalog": [],
        "id": "meraki",
        "vault_entry": "",
        "vault_secrets": {"unrelated": "secret"},
    }]


@pytest.mark.asyncio
async def test_plain_deepagents_architect_path_builds_topolograph_specialist_from_private_binding():
    from ccie_sidecar.agents import deepagents_runtime
    from ccie_sidecar.agents.architect_subagents import TopolographAgentBinding

    captured = {}

    class FakeGraph:
        pass

    def fake_create_deep_agent(**kwargs):
        captured["graph"] = kwargs
        return FakeGraph()

    async def fake_run_and_stream(**kwargs):
        captured["run"] = kwargs

    binding = TopolographAgentBinding(
        base_url="https://topolograph.example",
        verify_tls=True,
        token="selected-token",
    )
    agent_def = {
        "agent_id": "network-architect",
        "system_prompt": "architect prompt",
        "attached_tools": [{"catalog": [], "vault_secrets": {}}],
        "topolograph_binding": binding,
    }

    with (
        patch.object(deepagents_runtime, "build_chat_model", return_value=object()),
        patch.object(deepagents_runtime, "create_deep_agent", side_effect=fake_create_deep_agent),
        patch.object(deepagents_runtime, "_rubric_middleware", return_value=object()),
        patch(
            "ccie_sidecar.agents.deepagents_tools.convert_meraki_catalog_to_langchain_tools",
            return_value=[],
        ),
        patch(
            "ccie_sidecar.agents.deepagents_stream.run_and_stream",
            side_effect=fake_run_and_stream,
        ),
    ):
        await deepagents_runtime.deepagents_react_loop(
            agent_def=agent_def,
            user_msg="analyze Topolograph graphs",
            ctx={},
            on_event=lambda _event: None,
        )

    specialist = next(
        subagent
        for subagent in captured["graph"]["subagents"]
        if subagent["name"] == "topolograph-specialist"
    )
    assert specialist["name"] == "topolograph-specialist"
    assert "selected-token" not in specialist["system_prompt"]
    assert all("selected-token" not in str(tool) for tool in specialist["tools"])


@pytest.mark.asyncio
async def test_plain_deepagents_architect_path_omits_unusable_topolograph_binding():
    from ccie_sidecar.agents import deepagents_runtime

    captured = {}

    def fake_create_deep_agent(**kwargs):
        captured["graph"] = kwargs
        return object()

    async def fake_run_and_stream(**_kwargs):
        return {"interrupted": False}

    agent_def = {
        "agent_id": "network-architect",
        "system_prompt": "architect prompt",
        "attached_tools": [{"catalog": [], "vault_secrets": {}}],
        "topolograph_binding": None,
    }

    with (
        patch.object(deepagents_runtime, "build_chat_model", return_value=object()),
        patch.object(deepagents_runtime, "create_deep_agent", side_effect=fake_create_deep_agent),
        patch.object(deepagents_runtime, "_rubric_middleware", return_value=object()),
        patch(
            "ccie_sidecar.agents.deepagents_tools.convert_meraki_catalog_to_langchain_tools",
            return_value=[],
        ),
        patch(
            "ccie_sidecar.agents.deepagents_stream.run_and_stream",
            side_effect=fake_run_and_stream,
        ),
    ):
        await deepagents_runtime.deepagents_react_loop(
            agent_def=agent_def,
            user_msg="analyze Topolograph graphs",
            ctx={},
            on_event=lambda _event: None,
        )

    assert not any(
        subagent["name"] == "topolograph-specialist"
        for subagent in captured["graph"]["subagents"]
    )


@pytest.mark.asyncio
async def test_user_facing_topolograph_deepagents_path_uses_only_private_bound_tools():
    from ccie_sidecar.agents import deepagents_runtime
    from ccie_sidecar.agents.architect_subagents import TopolographAgentBinding

    captured = {}

    def fake_create_deep_agent(**kwargs):
        captured["graph"] = kwargs
        return object()

    async def fake_run_and_stream(**_kwargs):
        return {"interrupted": False}

    binding = TopolographAgentBinding(
        base_url="https://topolograph.example",
        verify_tls=True,
        token="selected-token",
    )
    agent_def = {
        "agent_id": "topolograph",
        "system_prompt": "topolograph prompt",
        "attached_tools": [{"id": "topolograph", "catalog": [], "vault_secrets": {}}],
        "topolograph_binding": binding,
    }

    with (
        patch.object(deepagents_runtime, "build_chat_model", return_value=object()),
        patch.object(deepagents_runtime, "create_deep_agent", side_effect=fake_create_deep_agent),
        patch.object(deepagents_runtime, "_rubric_middleware", return_value=object()),
        patch.object(deepagents_runtime, "create_execute_python_code_tool", return_value=object()),
        patch(
            "ccie_sidecar.agents.deepagents_stream.run_and_stream",
            side_effect=fake_run_and_stream,
        ),
        patch("ccie_sidecar.topolograph.TopolographClient", FakeTopolographClient),
    ):
        await deepagents_runtime.deepagents_react_code_loop(
            agent_def=agent_def,
            user_msg="inspect Topolograph graphs",
            ctx={},
            on_event=lambda _event: None,
        )

    tool_names = {tool.name for tool in captured["graph"]["tools"]}
    assert "topolograph_mcp_call" in tool_names
    assert "execute_python_code" not in tool_names
    assert all("selected-token" not in str(tool) for tool in captured["graph"]["tools"])

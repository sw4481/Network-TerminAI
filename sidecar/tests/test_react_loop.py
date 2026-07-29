"""
Integration tests for ReACT loop implementation.

Tests the agent's ability to:
1. Parse tool catalogs and convert to Claude format
2. Execute tool calls via MerakiClient
3. Handle errors gracefully
4. Stream events correctly
5. Complete multi-step reasoning chains
"""

import asyncio
import json
from unittest.mock import MagicMock, Mock, patch

import pytest

# Import the module under test
from ccie_sidecar.agents.react import (
    react_loop,
    # Renamed to _convert_catalog_to_tools(catalog, provider) in the
    # multi-provider refactor. These tests target the Anthropic format, so wrap
    # it to preserve the original single-arg call sites below.
    _convert_catalog_to_tools,
    _find_tool_spec,
    _execute_tool,
)


def _convert_catalog_to_claude_tools(catalog):
    """Anthropic-format adapter for the renamed multi-provider converter."""
    return _convert_catalog_to_tools(catalog, "anthropic")


# Sample tool catalog (subset of real Meraki catalog)
SAMPLE_CATALOG = [
    {
        "name": "meraki.organizations.list-organizations",
        "description": "List all organizations the user has access to",
        "resource": "organizations",
        "action": "list-organizations",
        "endpoint": {"method": "GET", "path": "/organizations"},
        "args": {},
        "required": [],
        "blast_radius": "low",
        "destructive": False,
        "sdk_method": "getOrganizations",
    },
    {
        "name": "meraki.organizations.get-organization",
        "description": "Return an organization",
        "resource": "organizations",
        "action": "get-organization",
        "endpoint": {"method": "GET", "path": "/organizations/{organizationId}"},
        "args": {
            "organizationId": {
                "type": "string",
                "description": "Organization ID"
            }
        },
        "required": ["organizationId"],
        "blast_radius": "low",
        "destructive": False,
        "sdk_method": "getOrganization",
    },
    {
        "name": "meraki.networks.update-network",
        "description": "Update a network",
        "resource": "networks",
        "action": "update-network",
        "endpoint": {"method": "PUT", "path": "/networks/{networkId}"},
        "args": {
            "networkId": {"type": "string", "description": "Network ID"},
            "name": {"type": "string", "description": "New network name"},
        },
        "required": ["networkId"],
        "blast_radius": "medium",
        "destructive": False,
        "sdk_method": "updateNetwork",
    },
]


def test_convert_catalog_to_claude_tools():
    """Test conversion of Meraki catalog to Claude tool format."""
    claude_tools = _convert_catalog_to_claude_tools(SAMPLE_CATALOG)

    assert len(claude_tools) == 3

    # Check first tool (list organizations)
    list_orgs = claude_tools[0]
    assert list_orgs["name"] == "meraki_organizations_list_organizations"
    assert "List all organizations" in list_orgs["description"]
    assert list_orgs["input_schema"]["type"] == "object"
    assert list_orgs["input_schema"]["properties"] == {}
    assert list_orgs["input_schema"]["required"] == []

    # Check second tool (get organization)
    get_org = claude_tools[1]
    assert get_org["name"] == "meraki_organizations_get_organization"
    assert "organizationId" in get_org["input_schema"]["properties"]
    assert get_org["input_schema"]["required"] == ["organizationId"]

    # Check third tool (update network)
    update_net = claude_tools[2]
    assert update_net["name"] == "meraki_networks_update_network"
    assert "networkId" in update_net["input_schema"]["properties"]
    assert "name" in update_net["input_schema"]["properties"]


def test_find_tool_spec():
    """Test finding tool specs by Claude tool name."""
    # Find by exact match
    spec = _find_tool_spec(SAMPLE_CATALOG, "meraki_organizations_list_organizations")
    assert spec is not None
    assert spec["name"] == "meraki.organizations.list-organizations"

    # Find with complex action name
    spec = _find_tool_spec(SAMPLE_CATALOG, "meraki_organizations_get_organization")
    assert spec is not None
    assert spec["name"] == "meraki.organizations.get-organization"

    # Not found
    spec = _find_tool_spec(SAMPLE_CATALOG, "meraki_nonexistent_tool")
    assert spec is None


def test_execute_tool_success():
    """Test successful tool execution."""
    # Mock MerakiClient
    mock_client = Mock()
    mock_client.call.return_value = {
        "ok": True,
        "data": [
            {"id": "123", "name": "Org 1"},
            {"id": "456", "name": "Org 2"},
        ],
        "meta": {
            "endpoint": {"resource": "organizations", "action": "list-organizations"},
            "blast_radius": "low",
            "duration_ms": 150,
        }
    }

    result = _execute_tool(
        tool_name="meraki_organizations_list_organizations",
        tool_input={},
        catalog=SAMPLE_CATALOG,
        client=mock_client,
    )

    assert result["ok"] is True
    assert len(result["data"]) == 2
    assert result["data"][0]["name"] == "Org 1"
    assert result["meta"]["blast_radius"] == "low"

    # Verify client was called correctly
    mock_client.call.assert_called_once_with("organizations", "list-organizations")


def test_execute_tool_with_parameters():
    """Test tool execution with input parameters."""
    mock_client = Mock()
    mock_client.call.return_value = {
        "ok": True,
        "data": {"id": "123", "name": "Org 1"},
        "meta": {"blast_radius": "low", "duration_ms": 100}
    }

    result = _execute_tool(
        tool_name="meraki_organizations_get_organization",
        tool_input={"organizationId": "123"},
        catalog=SAMPLE_CATALOG,
        client=mock_client,
    )

    assert result["ok"] is True
    assert result["data"]["id"] == "123"

    mock_client.call.assert_called_once_with(
        "organizations",
        "get-organization",
        organizationId="123"
    )


def test_execute_tool_not_found():
    """Test tool execution when tool not in catalog."""
    mock_client = Mock()

    result = _execute_tool(
        tool_name="meraki_nonexistent_tool",
        tool_input={},
        catalog=SAMPLE_CATALOG,
        client=mock_client,
    )

    assert result["ok"] is False
    assert result["error"]["code"] == "tool_not_found"
    assert "not found in catalog" in result["error"]["message"]


def test_execute_tool_api_error():
    """Test tool execution when API returns error."""
    mock_client = Mock()
    mock_client.call.return_value = {
        "ok": False,
        "error": {
            "code": "auth_error",
            "message": "Invalid API key",
            "hint": "Rotate your API key in the Vault..."
        },
        "meta": {"duration_ms": 50}
    }

    result = _execute_tool(
        tool_name="meraki_organizations_list_organizations",
        tool_input={},
        catalog=SAMPLE_CATALOG,
        client=mock_client,
    )

    assert result["ok"] is False
    assert result["error"]["code"] == "auth_error"
    assert "Invalid API key" in result["error"]["message"]


def test_execute_tool_exception():
    """Test tool execution when client raises exception."""
    mock_client = Mock()
    mock_client.call.side_effect = Exception("Network timeout")

    result = _execute_tool(
        tool_name="meraki_organizations_list_organizations",
        tool_input={},
        catalog=SAMPLE_CATALOG,
        client=mock_client,
    )

    assert result["ok"] is False
    assert result["error"]["code"] == "tool_execution_error"
    assert "Network timeout" in result["error"]["message"]


@pytest.mark.asyncio
async def test_react_loop_no_tools():
    """Test ReACT loop with agent that has no tools."""
    agent_def = {
        "system_prompt": "You are a helpful assistant",
        "attached_tools": [],
    }

    events = []

    def on_event(event):
        events.append(event)

    await react_loop(agent_def, "Hello", {}, on_event)

    # Should emit error about no tools
    assert len(events) == 1
    assert events[0]["type"] == "error"
    assert "No tools attached" in events[0]["message"]


@pytest.mark.asyncio
async def test_react_loop_invalid_catalog():
    """Test ReACT loop with invalid catalog JSON."""
    agent_def = {
        "system_prompt": "You are a helpful assistant",
        "attached_tools": [
            {
                "catalog": "not valid json {",
                "vault_entry": "meraki_default",
            }
        ],
    }

    events = []

    def on_event(event):
        events.append(event)

    await react_loop(agent_def, "Hello", {}, on_event)

    # Should emit error about invalid catalog
    assert len(events) == 1
    assert events[0]["type"] == "error"
    assert "parse tool catalog" in events[0]["message"]


# These tests target the provider-agnostic react_loop. After the multi-provider
# refactor the loop no longer instantiates `Anthropic` directly — it resolves a
# provider via get_saved_config() and calls the unified _call_llm_with_tools(),
# which returns {"stop_reason", "content": [unified blocks], "error"?}. So we
# patch get_saved_config (anthropic provider) and _call_llm_with_tools.
_ANTHROPIC_CONFIG = {
    "provider": "anthropic",
    "model": "claude-sonnet-4-6",
    "api_key": "test-key",
    "base_url": None,
}


@pytest.mark.asyncio
@patch("ccie_sidecar.agents.react._initialize_meraki_client")
@patch("ccie_sidecar.agents.react._call_llm_with_tools")
@patch("ccie_sidecar.agent.get_saved_config", return_value=_ANTHROPIC_CONFIG)
async def test_react_loop_single_turn(mock_config, mock_llm, mock_meraki_init):
    """Test ReACT loop that completes in a single turn."""
    # Unified end_turn response, no tool use
    mock_llm.return_value = {
        "stop_reason": "end_turn",
        "content": [{"type": "text", "text": "Hello! How can I help you?"}],
    }

    agent_def = {
        "system_prompt": "You are a helpful assistant",
        "attached_tools": [
            {
                "catalog": json.dumps(SAMPLE_CATALOG),
                "vault_entry": "meraki_default",
            }
        ],
    }

    events = []

    def on_event(event):
        events.append(event)

    await react_loop(agent_def, "Hello", {}, on_event)

    # Should emit: thought_start, final
    assert len(events) == 2
    assert events[0]["type"] == "thought_start"
    assert events[0]["step"] == 1
    assert events[1]["type"] == "final"
    assert "How can I help you" in events[1]["response"]


@pytest.mark.asyncio
@patch("ccie_sidecar.agents.react._initialize_meraki_client")
@patch("ccie_sidecar.agents.react._call_llm_with_tools")
@patch("ccie_sidecar.agent.get_saved_config", return_value=_ANTHROPIC_CONFIG)
async def test_react_loop_with_tool_use(mock_config, mock_llm, mock_meraki_init):
    """Test ReACT loop with tool use."""
    # Setup Meraki client mock
    mock_meraki_client = Mock()
    mock_meraki_client.call.return_value = {
        "ok": True,
        "data": [{"id": "123", "name": "Test Org"}],
        "meta": {"blast_radius": "low", "duration_ms": 100}
    }
    mock_meraki_init.return_value = mock_meraki_client

    # First response: tool use; second: final answer (unified format)
    mock_llm.side_effect = [
        {
            "stop_reason": "tool_use",
            "content": [{
                "type": "tool_use",
                "id": "tool_123",
                "name": "meraki_organizations_list_organizations",
                "input": {},
            }],
        },
        {
            "stop_reason": "end_turn",
            "content": [{"type": "text", "text": "You have 1 organization: Test Org"}],
        },
    ]

    agent_def = {
        "system_prompt": "You are a Meraki assistant",
        "attached_tools": [
            {
                "catalog": json.dumps(SAMPLE_CATALOG),
                "vault_entry": "meraki_default",
            }
        ],
    }

    events = []

    def on_event(event):
        events.append(event)

    await react_loop(agent_def, "List my organizations", {}, on_event)

    # Verify event sequence:
    # thought_start (1), tool_call, tool_result, thought_start (2), final = 5 events
    assert len(events) == 5

    assert events[0]["type"] == "thought_start"
    assert events[0]["step"] == 1

    assert events[1]["type"] == "tool_call"
    assert events[1]["name"] == "meraki_organizations_list_organizations"
    assert events[1]["blast_radius"] == "low"

    assert events[2]["type"] == "tool_result"
    assert events[2]["success"] is True
    assert "Test Org" in events[2]["result"]

    assert events[3]["type"] == "thought_start"
    assert events[3]["step"] == 2

    assert events[4]["type"] == "final"
    assert "Test Org" in events[4]["response"]

    # Verify Meraki client was called
    mock_meraki_client.call.assert_called_once_with("organizations", "list-organizations")


@pytest.mark.asyncio
@patch("ccie_sidecar.agents.react._initialize_meraki_client")
@patch("ccie_sidecar.agents.react._call_llm_with_tools")
@patch("ccie_sidecar.agent.get_saved_config", return_value=_ANTHROPIC_CONFIG)
async def test_react_loop_max_steps(mock_config, mock_llm, mock_meraki_init):
    """Test ReACT loop hitting max steps limit."""
    # Setup Meraki client mock
    mock_meraki_client = Mock()
    mock_meraki_client.call.return_value = {
        "ok": True,
        "data": [],
        "meta": {"blast_radius": "low"}
    }
    mock_meraki_init.return_value = mock_meraki_client

    # Always return tool_use (infinite-loop scenario)
    mock_llm.return_value = {
        "stop_reason": "tool_use",
        "content": [{
            "type": "tool_use",
            "id": "tool_123",
            "name": "meraki_organizations_list_organizations",
            "input": {},
        }],
    }

    agent_def = {
        "system_prompt": "You are a Meraki assistant",
        "attached_tools": [
            {
                "catalog": json.dumps(SAMPLE_CATALOG),
                "vault_entry": "meraki_default",
            }
        ],
    }

    events = []

    def on_event(event):
        events.append(event)

    await react_loop(agent_def, "List my organizations", {}, on_event)

    # Should hit max steps (12) and emit error
    thought_events = [e for e in events if e["type"] == "thought_start"]
    assert len(thought_events) == 12  # MAX_STEPS

    error_events = [e for e in events if e["type"] == "error"]
    assert len(error_events) == 1
    assert "Maximum steps" in error_events[0]["message"]


if __name__ == "__main__":
    pytest.main([__file__, "-v"])

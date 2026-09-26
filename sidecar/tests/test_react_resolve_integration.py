"""
Integration tests for ReACT parameter resolution.

These tests demonstrate end-to-end flows:
1. Auto-resolve from context (org_id remembered)
2. Disambiguation with single option (auto-selects)
3. Disambiguation with multiple options (user_question event)
"""

import importlib.util
import json
import pytest
from unittest.mock import Mock, patch

# The disambiguation tests patch terminai_meraki.catalog, a local package
# (meraki_cli/) that isn't installed on clean CI runners. Skip them there; they
# still run locally where the package is on the path.
requires_terminai_meraki = pytest.mark.skipif(
    importlib.util.find_spec("terminai_meraki") is None,
    reason="terminai_meraki (meraki_cli) not installed",
)

from ccie_sidecar.agents.react_context import ReACTContext
from ccie_sidecar.agents.react_resolve import (
    autoresolve_args,
    disambiguate,
    update_context_from_result,
)


# Sample tool spec for testing
TOOL_SPEC_GET_NETWORK = {
    "name": "meraki.networks.get-network",
    "description": "Get network details",
    "resource": "networks",
    "action": "get-network",
    "args": {
        "networkId": {"type": "string", "description": "Network ID"}
    },
    "required": ["networkId"],
    "blast_radius": "low",
}


@pytest.mark.asyncio
async def test_integration_autoresolve_from_context():
    """
    Test auto-resolve from context.

    Scenario:
    1. User lists organizations → context learns org_id
    2. Agent wants to list networks → auto-resolves org_id from context
    """
    ctx = ReACTContext()

    # Simulate previous tool result (list organizations)
    org_result = {
        "ok": True,
        "data": [
            {"id": "O_123", "name": "Test Org"}
        ],
        "meta": {},
    }
    update_context_from_result(ctx,org_result)

    # Agent now wants to list networks (requires organizationId)
    tool_spec = {
        "name": "meraki.organizations.get-organization-networks",
        "required": ["organizationId"],
    }

    tool_input = {}  # LLM didn't provide organizationId

    # Auto-resolve
    resolved = autoresolve_args(tool_input, tool_spec, ctx, None)

    # Should have resolved organizationId from context
    assert resolved["organizationId"] == "O_123"


@pytest.mark.asyncio
@requires_terminai_meraki
@patch("terminai_meraki.catalog.generate_catalog")
@patch("ccie_sidecar.agents.react._execute_tool")
async def test_integration_disambiguate_single_org(mock_execute, mock_catalog):
    """
    Test disambiguation with single org.

    Scenario:
    1. Agent needs organizationId but context is empty
    2. Disambiguation calls list-organizations
    3. Single org found → auto-selects without user prompt
    """
    mock_catalog.return_value = []
    mock_execute.return_value = {
        "ok": True,
        "data": [
            {"id": "O_123", "name": "Only Org"}
        ],
    }

    ctx = ReACTContext()
    events = []

    def on_event(event):
        events.append(event)

    # Disambiguate organizationId
    result = await disambiguate(
        tool_spec={"name": "test-tool"},
        missing_params=["organizationId"],
        ctx=ctx,
        client=None,
        on_event=on_event,
    )

    # Should auto-select the single org
    assert result["organizationId"] == "O_123"
    assert len(events) == 0  # No user prompt

    # Context should be updated
    assert ctx.org_id == "O_123"


@pytest.mark.asyncio
@requires_terminai_meraki
@patch("terminai_meraki.catalog.generate_catalog")
@patch("ccie_sidecar.agents.react._execute_tool")
async def test_integration_disambiguate_multiple_orgs(mock_execute, mock_catalog):
    """
    Test disambiguation with multiple orgs.

    Scenario:
    1. Agent needs organizationId but context is empty
    2. Disambiguation calls list-organizations
    3. Multiple orgs found → emits user_question event
    4. Loop pauses for user input
    """
    mock_catalog.return_value = []
    mock_execute.return_value = {
        "ok": True,
        "data": [
            {"id": "O_123", "name": "Org 1"},
            {"id": "O_456", "name": "Org 2"},
            {"id": "O_789", "name": "Org 3"},
        ],
    }

    ctx = ReACTContext()
    events = []

    def on_event(event):
        events.append(event)

    # Disambiguate organizationId
    result = await disambiguate(
        tool_spec={"name": "test-tool"},
        missing_params=["organizationId"],
        ctx=ctx,
        client=None,
        on_event=on_event,
    )

    # Should NOT auto-select (ambiguous)
    assert result == {}

    # Should emit user_question event
    assert len(events) == 1
    assert events[0]["type"] == "user_question"
    assert events[0]["param"] == "organizationId"
    assert events[0]["prompt"] == "Which organization?"
    assert len(events[0]["options"]) == 3

    # Options should be formatted
    assert events[0]["options"][0] == {"id": "O_123", "label": "Org 1"}
    assert events[0]["options"][1] == {"id": "O_456", "label": "Org 2"}
    assert events[0]["options"][2] == {"id": "O_789", "label": "Org 3"}

    # pending_id should be present (for frontend to track)
    assert "pending_id" in events[0]


@pytest.mark.asyncio
@requires_terminai_meraki
@patch("terminai_meraki.catalog.generate_catalog")
@patch("ccie_sidecar.agents.react._execute_tool")
async def test_integration_cascading_disambiguation(mock_execute, mock_catalog):
    """
    Test cascading disambiguation (org → network → device).

    Scenario:
    1. Agent needs device serial
    2. First disambiguates org (single org → auto-select)
    3. Then disambiguates network (multiple → user prompt)
    """
    mock_catalog.return_value = []

    # Mock responses for disambiguation calls
    def mock_execute_side_effect(tool_name, tool_input, catalog, client):
        if "list_organizations" in tool_name:
            return {
                "ok": True,
                "data": [{"id": "O_123", "name": "Only Org"}],
            }
        elif "get_organization_networks" in tool_name:
            return {
                "ok": True,
                "data": [
                    {"id": "L_123", "name": "Network 1"},
                    {"id": "L_456", "name": "Network 2"},
                ],
            }
        else:
            return {"ok": False, "error": {}}

    mock_execute.side_effect = mock_execute_side_effect

    ctx = ReACTContext()
    events = []

    def on_event(event):
        events.append(event)

    # Disambiguate networkId (will cascade through org first)
    result = await disambiguate(
        tool_spec={"name": "test-tool"},
        missing_params=["networkId"],
        ctx=ctx,
        client=None,
        on_event=on_event,
    )

    # Org should be auto-selected (single option)
    assert ctx.org_id == "O_123"

    # Network should trigger user_question (multiple options)
    assert result == {}
    assert len(events) == 1
    assert events[0]["type"] == "user_question"
    assert events[0]["param"] == "networkId"
    assert len(events[0]["options"]) == 2


@pytest.mark.asyncio
async def test_integration_context_persistence():
    """
    Test context persists across multiple tool calls.

    Scenario:
    1. List orgs → context learns org_id
    2. Get org details → uses same org_id
    3. List networks → uses same org_id
    4. Get network details → uses network_id from list
    """
    ctx = ReACTContext()

    # Step 1: List organizations
    org_result = {
        "ok": True,
        "data": [{"id": "O_123", "name": "Test Org"}],
    }
    update_context_from_result(ctx,org_result)
    assert ctx.org_id == "O_123"

    # Step 2: Get org details (should use same org_id)
    tool_spec = {"required": ["organizationId"]}
    resolved = autoresolve_args({}, tool_spec, ctx, None)
    assert resolved["organizationId"] == "O_123"

    # Step 3: List networks
    networks_result = {
        "ok": True,
        "data": [
            {"id": "L_456", "name": "Network 1"},
            {"id": "L_789", "name": "Network 2"},
        ],
    }
    update_context_from_result(ctx,networks_result)
    assert ctx.network_id == "L_456"  # Should extract first network

    # Step 4: Get network details (should use network_id)
    tool_spec = {"required": ["networkId"]}
    resolved = autoresolve_args({}, tool_spec, ctx, None)
    assert resolved["networkId"] == "L_456"


@pytest.mark.asyncio
async def test_integration_context_mining_from_history():
    """
    Test context mines IDs from tool result history.

    Scenario:
    1. Multiple tool calls happen (org_id not in main context)
    2. Agent needs org_id
    3. Auto-resolve searches recent results and finds it
    """
    ctx = ReACTContext()

    # Add several results to history (without triggering main ID extraction)
    ctx.last_tool_results.append({
        "ok": True,
        "data": {"name": "Some Device", "model": "MR46"},
    })
    ctx.last_tool_results.append({
        "ok": True,
        "data": {"networkId": "L_123", "devices": []},
    })
    ctx.last_tool_results.append({
        "ok": True,
        "data": {"organizationId": "O_789", "networks": []},
    })

    # Auto-resolve should find org_id from history
    tool_spec = {"required": ["organizationId"]}
    resolved = autoresolve_args({}, tool_spec, ctx, None)
    assert resolved["organizationId"] == "O_789"

    # Auto-resolve should find network_id from history
    tool_spec = {"required": ["networkId"]}
    resolved = autoresolve_args({}, tool_spec, ctx, None)
    assert resolved["networkId"] == "L_123"


if __name__ == "__main__":
    pytest.main([__file__, "-v"])

"""
Unit tests for ReACT parameter resolution and disambiguation.

Tests:
1. ReACTContext state management
2. Auto-resolution from context
3. Disambiguation via helper tools
4. User question events
"""

import importlib.util

import pytest
from unittest.mock import Mock, AsyncMock, patch

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
    _resolve_org_id,
    _resolve_network_id,
    _resolve_serial,
    _disambiguate_org_id,
    _disambiguate_network_id,
    _disambiguate_serial,
)


# Test ReACTContext state management


def test_react_context_initialization():
    """Test ReACTContext initializes with empty state."""
    ctx = ReACTContext()

    assert ctx.org_id is None
    assert ctx.network_id is None
    assert ctx.serial is None
    assert ctx.last_tool_results == []


def test_context_update_from_result_dict():
    """Test updating context from a single object result."""
    ctx = ReACTContext()

    result = {
        "ok": True,
        "data": {
            "id": "O_123456",
            "name": "Test Org",
            "organizationId": "O_123456",
        },
        "meta": {},
    }

    update_context_from_result(ctx, result)

    assert ctx.org_id == "O_123456"
    assert len(ctx.last_tool_results) == 1


def test_context_update_from_result_list():
    """Test updating context from a list result."""
    ctx = ReACTContext()

    result = {
        "ok": True,
        "data": [
            {"id": "L_123456", "name": "Network 1", "networkId": "L_123456"},
            {"id": "L_789012", "name": "Network 2", "networkId": "L_789012"},
        ],
        "meta": {},
    }

    update_context_from_result(ctx, result)

    # Should extract from first item
    assert ctx.network_id == "L_123456"
    assert len(ctx.last_tool_results) == 1


def test_context_update_sliding_window():
    """Test context maintains sliding window of last 10 results."""
    ctx = ReACTContext()

    # Add 15 results
    for i in range(15):
        result = {
            "ok": True,
            "data": {"id": f"O_{i}", "organizationId": f"O_{i}"},
            "meta": {},
        }
        update_context_from_result(ctx, result)

    # Should only keep last 10
    assert len(ctx.last_tool_results) == 10
    # Most recent org_id should be from result 14
    assert ctx.org_id == "O_14"


def test_context_extract_org_id():
    """Test extracting org ID from results."""
    ctx = ReACTContext()

    # Test organizationId field
    result = {
        "ok": True,
        "data": {"organizationId": "O_explicit_123"},
        "meta": {},
    }
    update_context_from_result(ctx, result)
    assert ctx.org_id == "O_explicit_123"

    # Test id field with O_ prefix
    ctx = ReACTContext()
    result = {
        "ok": True,
        "data": {"id": "O_inferred_456"},
        "meta": {},
    }
    update_context_from_result(ctx, result)
    assert ctx.org_id == "O_inferred_456"


def test_context_extract_network_id():
    """Test extracting network ID from results."""
    ctx = ReACTContext()

    # Test networkId field
    result = {
        "ok": True,
        "data": {"networkId": "L_explicit_123"},
        "meta": {},
    }
    update_context_from_result(ctx, result)
    assert ctx.network_id == "L_explicit_123"

    # Test id field with L_ prefix
    ctx = ReACTContext()
    result = {
        "ok": True,
        "data": {"id": "L_inferred_456"},
        "meta": {},
    }
    update_context_from_result(ctx, result)
    assert ctx.network_id == "L_inferred_456"


def test_context_extract_serial():
    """Test extracting device serial from results."""
    ctx = ReACTContext()

    result = {
        "ok": True,
        "data": {"serial": "Q2XX-XXXX-XXXX", "name": "Test Device"},
        "meta": {},
    }
    update_context_from_result(ctx, result)
    assert ctx.serial == "Q2XX-XXXX-XXXX"


# Test auto-resolution


def test_autoresolve_args_with_provided_params():
    """Test autoresolve doesn't override provided params."""
    ctx = ReACTContext()
    ctx.org_id = "O_ctx_123"

    tool_spec = {
        "name": "test-tool",
        "required": ["organizationId"],
    }

    tool_input = {
        "organizationId": "O_provided_456",
    }

    result = autoresolve_args(tool_input, tool_spec, ctx, None)

    # Should keep provided value
    assert result["organizationId"] == "O_provided_456"


def test_autoresolve_args_from_context():
    """Test autoresolve fills in missing params from context."""
    ctx = ReACTContext()
    ctx.org_id = "O_ctx_123"
    ctx.network_id = "L_ctx_456"

    tool_spec = {
        "name": "test-tool",
        "required": ["organizationId", "networkId"],
    }

    tool_input = {}

    result = autoresolve_args(tool_input, tool_spec, ctx, None)

    assert result["organizationId"] == "O_ctx_123"
    assert result["networkId"] == "L_ctx_456"


def test_autoresolve_args_unknown_param():
    """Test autoresolve handles unknown params gracefully."""
    ctx = ReACTContext()

    tool_spec = {
        "name": "test-tool",
        "required": ["unknownParam"],
    }

    tool_input = {}

    result = autoresolve_args(tool_input, tool_spec, ctx, None)

    # Unknown param should not be set (will trigger disambiguation)
    assert "unknownParam" not in result


def test_resolve_org_id_from_context():
    """Test resolving org ID from context."""
    ctx = ReACTContext()
    ctx.org_id = "O_123"

    result = _resolve_org_id(ctx, None)

    assert result == "O_123"


def test_resolve_org_id_from_tool_results():
    """Test resolving org ID from recent tool results."""
    ctx = ReACTContext()

    # Add result with org ID
    ctx.last_tool_results.append({
        "ok": True,
        "data": {"organizationId": "O_from_result"},
    })

    result = _resolve_org_id(ctx, None)

    assert result == "O_from_result"


def test_resolve_org_id_from_list_result():
    """Test resolving org ID from list result."""
    ctx = ReACTContext()

    ctx.last_tool_results.append({
        "ok": True,
        "data": [
            {"id": "O_first"},
            {"id": "O_second"},
        ],
    })

    result = _resolve_org_id(ctx, None)

    assert result == "O_first"


def test_resolve_org_id_not_found():
    """Test resolving org ID when not available."""
    ctx = ReACTContext()

    result = _resolve_org_id(ctx, None)

    assert result is None


def test_resolve_network_id_from_context():
    """Test resolving network ID from context."""
    ctx = ReACTContext()
    ctx.network_id = "L_123"

    result = _resolve_network_id(ctx, None)

    assert result == "L_123"


def test_resolve_network_id_from_tool_results():
    """Test resolving network ID from recent tool results."""
    ctx = ReACTContext()

    ctx.last_tool_results.append({
        "ok": True,
        "data": {"networkId": "L_from_result"},
    })

    result = _resolve_network_id(ctx, None)

    assert result == "L_from_result"


def test_resolve_serial_from_context():
    """Test resolving serial from context."""
    ctx = ReACTContext()
    ctx.serial = "Q2XX-XXXX-XXXX"

    result = _resolve_serial(ctx, None)

    assert result == "Q2XX-XXXX-XXXX"


def test_resolve_serial_from_tool_results():
    """Test resolving serial from recent tool results."""
    ctx = ReACTContext()

    ctx.last_tool_results.append({
        "ok": True,
        "data": {"serial": "Q2YY-YYYY-YYYY"},
    })

    result = _resolve_serial(ctx, None)

    assert result == "Q2YY-YYYY-YYYY"


# Test disambiguation


@pytest.mark.asyncio
@requires_terminai_meraki
@patch("terminai_meraki.catalog.generate_catalog")
@patch("ccie_sidecar.agents.react._execute_tool")
async def test_disambiguate_org_id_single_org(mock_execute, mock_catalog):
    """Test disambiguation with single org auto-selects it."""
    mock_catalog.return_value = []  # Catalog not used in this test

    mock_execute.return_value = {
        "ok": True,
        "data": [
            {"id": "O_123", "name": "Only Org"},
        ],
    }

    ctx = ReACTContext()
    events = []

    def on_event(event):
        events.append(event)

    result = await _disambiguate_org_id(ctx, None, on_event)

    # Should return the single org without user question
    assert result == "O_123"
    assert ctx.org_id == "O_123"
    assert len(events) == 0  # No user question


@pytest.mark.asyncio
@requires_terminai_meraki
@patch("terminai_meraki.catalog.generate_catalog")
@patch("ccie_sidecar.agents.react._execute_tool")
async def test_disambiguate_org_id_multiple_orgs(mock_execute, mock_catalog):
    """Test disambiguation with multiple orgs emits user question."""
    mock_catalog.return_value = []

    mock_execute.return_value = {
        "ok": True,
        "data": [
            {"id": "O_123", "name": "Org 1"},
            {"id": "O_456", "name": "Org 2"},
        ],
    }

    ctx = ReACTContext()
    events = []

    def on_event(event):
        events.append(event)

    result = await _disambiguate_org_id(ctx, None, on_event)

    # Should return None and emit user_question
    assert result is None
    assert len(events) == 1
    assert events[0]["type"] == "user_question"
    assert events[0]["param"] == "organizationId"
    assert events[0]["prompt"] == "Which organization?"
    assert len(events[0]["options"]) == 2
    assert events[0]["options"][0]["id"] == "O_123"
    assert events[0]["options"][0]["label"] == "Org 1"


@pytest.mark.asyncio
@requires_terminai_meraki
@patch("terminai_meraki.catalog.generate_catalog")
@patch("ccie_sidecar.agents.react._execute_tool")
async def test_disambiguate_org_id_api_error(mock_execute, mock_catalog):
    """Test disambiguation handles API errors gracefully."""
    mock_catalog.return_value = []

    mock_execute.return_value = {
        "ok": False,
        "error": {"code": "auth_error", "message": "Invalid API key"},
    }

    ctx = ReACTContext()
    events = []

    def on_event(event):
        events.append(event)

    result = await _disambiguate_org_id(ctx, None, on_event)

    # Should return None without emitting user_question
    assert result is None
    assert len(events) == 0


@pytest.mark.asyncio
@requires_terminai_meraki
@patch("terminai_meraki.catalog.generate_catalog")
@patch("ccie_sidecar.agents.react._execute_tool")
@patch("ccie_sidecar.agents.react_resolve._disambiguate_org_id")
async def test_disambiguate_network_id_resolves_org_first(
    mock_disambiguate_org, mock_execute, mock_catalog
):
    """Test network disambiguation resolves org ID first."""
    mock_catalog.return_value = []
    mock_disambiguate_org.return_value = "O_123"

    mock_execute.return_value = {
        "ok": True,
        "data": [
            {"id": "L_456", "name": "Network 1"},
        ],
    }

    ctx = ReACTContext()
    events = []

    def on_event(event):
        events.append(event)

    result = await _disambiguate_network_id(ctx, None, on_event)

    # Should resolve org first, then network
    mock_disambiguate_org.assert_called_once()
    assert result == "L_456"


@pytest.mark.asyncio
@requires_terminai_meraki
@patch("terminai_meraki.catalog.generate_catalog")
@patch("ccie_sidecar.agents.react._execute_tool")
async def test_disambiguate_network_id_multiple_networks(mock_execute, mock_catalog):
    """Test network disambiguation with multiple networks."""
    mock_catalog.return_value = []
    mock_execute.return_value = {
        "ok": True,
        "data": [
            {"id": "L_123", "name": "Network 1"},
            {"id": "L_456", "name": "Network 2"},
        ],
    }

    ctx = ReACTContext()
    ctx.org_id = "O_123"  # Pre-set org
    events = []

    def on_event(event):
        events.append(event)

    result = await _disambiguate_network_id(ctx, None, on_event)

    # Should emit user_question
    assert result is None
    assert len(events) == 1
    assert events[0]["type"] == "user_question"
    assert events[0]["param"] == "networkId"
    assert "Which network" in events[0]["prompt"]


@pytest.mark.asyncio
@requires_terminai_meraki
@patch("terminai_meraki.catalog.generate_catalog")
@patch("ccie_sidecar.agents.react._execute_tool")
@patch("ccie_sidecar.agents.react_resolve._disambiguate_network_id")
async def test_disambiguate_serial_resolves_network_first(
    mock_disambiguate_net, mock_execute, mock_catalog
):
    """Test serial disambiguation resolves network ID first."""
    mock_catalog.return_value = []
    mock_disambiguate_net.return_value = "L_123"

    mock_execute.return_value = {
        "ok": True,
        "data": [
            {"serial": "Q2XX-XXXX-XXXX", "name": "Device 1", "model": "MR46"},
        ],
    }

    ctx = ReACTContext()
    events = []

    def on_event(event):
        events.append(event)

    result = await _disambiguate_serial(ctx, None, on_event)

    # Should resolve network first, then device
    mock_disambiguate_net.assert_called_once()
    assert result == "Q2XX-XXXX-XXXX"


@pytest.mark.asyncio
@requires_terminai_meraki
@patch("terminai_meraki.catalog.generate_catalog")
@patch("ccie_sidecar.agents.react._execute_tool")
async def test_disambiguate_serial_multiple_devices(mock_execute, mock_catalog):
    """Test serial disambiguation with multiple devices."""
    mock_catalog.return_value = []
    mock_execute.return_value = {
        "ok": True,
        "data": [
            {"serial": "Q2XX-XXXX-XXXX", "name": "Device 1", "model": "MR46"},
            {"serial": "Q2YY-YYYY-YYYY", "name": "Device 2", "model": "MS225"},
        ],
    }

    ctx = ReACTContext()
    ctx.network_id = "L_123"  # Pre-set network
    events = []

    def on_event(event):
        events.append(event)

    result = await _disambiguate_serial(ctx, None, on_event)

    # Should emit user_question
    assert result is None
    assert len(events) == 1
    assert events[0]["type"] == "user_question"
    assert events[0]["param"] == "serial"
    assert "Which device" in events[0]["prompt"]
    assert len(events[0]["options"]) == 2
    # Check formatted label includes name, model, and serial
    assert "Device 1" in events[0]["options"][0]["label"]
    assert "MR46" in events[0]["options"][0]["label"]
    assert "Q2XX-XXXX-XXXX" in events[0]["options"][0]["label"]


@pytest.mark.asyncio
@patch("ccie_sidecar.agents.react_resolve._disambiguate_org_id")
@patch("ccie_sidecar.agents.react_resolve._disambiguate_network_id")
@patch("ccie_sidecar.agents.react_resolve._disambiguate_serial")
async def test_disambiguate_main_function(
    mock_serial, mock_network, mock_org
):
    """Test main disambiguate function."""
    mock_org.return_value = "O_123"
    mock_network.return_value = "L_456"
    mock_serial.return_value = "Q2XX-XXXX-XXXX"

    ctx = ReACTContext()
    tool_spec = {"name": "test-tool"}
    missing_params = ["organizationId", "networkId", "serial"]

    events = []

    def on_event(event):
        events.append(event)

    result = await disambiguate(tool_spec, missing_params, ctx, None, on_event)

    # Should call all disambiguators
    mock_org.assert_called_once()
    mock_network.assert_called_once()
    mock_serial.assert_called_once()

    # Should return all resolved values
    assert result == {
        "organizationId": "O_123",
        "networkId": "L_456",
        "serial": "Q2XX-XXXX-XXXX",
    }


@pytest.mark.asyncio
@patch("ccie_sidecar.agents.react_resolve._disambiguate_org_id")
async def test_disambiguate_main_function_partial_resolution(mock_org):
    """Test main disambiguate function with partial resolution."""
    # Org returns None (user question emitted)
    mock_org.return_value = None

    ctx = ReACTContext()
    tool_spec = {"name": "test-tool"}
    missing_params = ["organizationId"]

    events = []

    def on_event(event):
        events.append(event)

    result = await disambiguate(tool_spec, missing_params, ctx, None, on_event)

    # Should return empty dict (org couldn't be resolved)
    assert result == {}


if __name__ == "__main__":
    pytest.main([__file__, "-v"])

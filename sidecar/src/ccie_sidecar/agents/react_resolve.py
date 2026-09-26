"""
Parameter resolution and disambiguation for ReACT loop.

This module provides:
1. Auto-resolution of missing required parameters from context
2. Disambiguation via helper tool calls when context is ambiguous
3. User question events when manual selection is required

Phase 4: Smart parameter resolution
"""

import uuid
from typing import Any, Callable, Dict, List, Optional

from ccie_sidecar.agents.react_context import ReACTContext


def update_context_from_result(ctx: ReACTContext, result: Dict[str, Any]) -> None:
    """
    Update context from a tool result.

    Extracts and caches org_id, network_id, serial from successful results.
    Maintains a sliding window of recent results for parameter mining.

    Args:
        ctx: ReACTContext instance
        result: Tool result envelope {"ok": bool, "data": any, "meta": dict}
    """
    # Add to history (max 10 results)
    ctx.last_tool_results.append(result)
    if len(ctx.last_tool_results) > 10:
        ctx.last_tool_results.pop(0)

    # Extract IDs from successful results
    if result.get("ok"):
        data = result.get("data")
        if isinstance(data, dict):
            # Single object result
            _extract_ids_from_object(ctx, data)
        elif isinstance(data, list) and len(data) > 0:
            # List result - extract from first item
            _extract_ids_from_object(ctx, data[0])


def _extract_ids_from_object(ctx: ReACTContext, obj: Dict[str, Any]) -> None:
    """Extract and cache IDs from a data object."""
    if "organizationId" in obj:
        ctx.org_id = obj["organizationId"]
    elif "id" in obj and str(obj["id"]).startswith("O_"):
        # Looks like an org ID (Meraki org IDs start with O_)
        ctx.org_id = obj["id"]

    if "networkId" in obj:
        ctx.network_id = obj["networkId"]
    elif "id" in obj and str(obj["id"]).startswith("L_"):
        # Looks like a network ID (Meraki network IDs start with L_)
        ctx.network_id = obj["id"]

    if "serial" in obj:
        ctx.serial = obj["serial"]


def autoresolve_args(
    tool_call_input: Dict[str, Any],
    tool_spec: Dict[str, Any],
    ctx: ReACTContext,
    client,
) -> Dict[str, Any]:
    """
    Auto-resolve missing required parameters from context.

    This function attempts to fill in missing required parameters by:
    1. Checking context for last-used values
    2. Mining recent tool results for relevant IDs

    Parameters that remain None will trigger disambiguation.

    Args:
        tool_call_input: Input parameters from LLM tool call
        tool_spec: Tool specification from catalog
        ctx: ReACT context object
        client: MerakiClient instance (unused in Phase 4, needed for Phase 5)

    Returns:
        Updated args dict with resolved values
    """
    args = tool_call_input.copy()
    required = tool_spec.get("required", [])

    for param in required:
        if param in args and args[param] is not None:
            continue  # Already provided

        # Try to resolve
        resolved = _resolve_param(param, ctx, client)
        if resolved:
            args[param] = resolved

    return args


def _resolve_param(param: str, ctx: ReACTContext, client) -> Optional[str]:
    """
    Resolve a single parameter from context.

    Args:
        param: Parameter name (e.g., "organizationId")
        ctx: ReACT context object
        client: MerakiClient instance

    Returns:
        Resolved value or None
    """
    if param == "organizationId":
        return _resolve_org_id(ctx, client)
    elif param == "networkId":
        return _resolve_network_id(ctx, client)
    elif param == "serial":
        return _resolve_serial(ctx, client)
    else:
        return None


def _resolve_org_id(ctx: ReACTContext, client) -> Optional[str]:
    """
    Resolve organization ID from context.

    Priority:
    1. ctx.org_id (last-used)
    2. ctx.last_tool_results (search for org IDs in recent calls)
    3. None (will trigger disambiguation)

    Args:
        ctx: ReACT context object
        client: MerakiClient instance (unused)

    Returns:
        Organization ID or None
    """
    if ctx.org_id:
        return ctx.org_id

    # Search recent tool results
    for result in ctx.last_tool_results:
        if not result.get("ok"):
            continue

        data = result.get("data")
        if isinstance(data, dict):
            if "organizationId" in data:
                return data["organizationId"]
            if "id" in data and str(data["id"]).startswith("O_"):
                return data["id"]
        elif isinstance(data, list):
            for item in data:
                if isinstance(item, dict):
                    if "organizationId" in item:
                        return item["organizationId"]
                    if "id" in item and str(item["id"]).startswith("O_"):
                        return item["id"]

    return None


def _resolve_network_id(ctx: ReACTContext, client) -> Optional[str]:
    """
    Resolve network ID from context.

    Priority:
    1. ctx.network_id (last-used)
    2. ctx.last_tool_results (search for network IDs)
    3. None (will trigger disambiguation)

    Args:
        ctx: ReACT context object
        client: MerakiClient instance (unused)

    Returns:
        Network ID or None
    """
    if ctx.network_id:
        return ctx.network_id

    # Search recent tool results
    for result in ctx.last_tool_results:
        if not result.get("ok"):
            continue

        data = result.get("data")
        if isinstance(data, dict):
            if "networkId" in data:
                return data["networkId"]
            if "id" in data and str(data["id"]).startswith("L_"):
                return data["id"]
        elif isinstance(data, list):
            for item in data:
                if isinstance(item, dict):
                    if "networkId" in item:
                        return item["networkId"]
                    if "id" in item and str(item["id"]).startswith("L_"):
                        return item["id"]

    return None


def _resolve_serial(ctx: ReACTContext, client) -> Optional[str]:
    """
    Resolve device serial from context.

    Priority:
    1. ctx.serial (last-used)
    2. ctx.last_tool_results (search for serials)
    3. None (will trigger disambiguation)

    Args:
        ctx: ReACT context object
        client: MerakiClient instance (unused)

    Returns:
        Device serial or None
    """
    if ctx.serial:
        return ctx.serial

    # Search recent tool results
    for result in ctx.last_tool_results:
        if not result.get("ok"):
            continue

        data = result.get("data")
        if isinstance(data, dict) and "serial" in data:
            return data["serial"]
        elif isinstance(data, list):
            for item in data:
                if isinstance(item, dict) and "serial" in item:
                    return item["serial"]

    return None


async def disambiguate(
    tool_spec: Dict[str, Any],
    missing_params: List[str],
    ctx: ReACTContext,
    client,
    on_event: Callable,
) -> Dict[str, Any]:
    """
    Disambiguate missing parameters by calling helper tools.

    This function attempts to resolve ambiguous parameters by:
    1. Calling list/get operations to discover available options
    2. If single option: return it automatically
    3. If multiple options: emit user_question event and return None

    Args:
        tool_spec: Tool specification from catalog
        missing_params: List of parameter names that need disambiguation
        ctx: ReACT context object
        client: MerakiClient instance
        on_event: Event callback for emitting user questions

    Returns:
        Dict of resolved parameter values (may be incomplete)
    """
    resolved = {}

    for param in missing_params:
        if param == "organizationId":
            value = await _disambiguate_org_id(ctx, client, on_event)
        elif param == "networkId":
            value = await _disambiguate_network_id(ctx, client, on_event)
        elif param == "serial":
            value = await _disambiguate_serial(ctx, client, on_event)
        else:
            # Unknown param - skip
            continue

        if value:
            resolved[param] = value

    return resolved


async def _disambiguate_org_id(
    ctx: ReACTContext,
    client,
    on_event: Callable,
) -> Optional[str]:
    """
    Disambiguate organization ID.

    Strategy:
    1. Call list-organizations to get all available orgs
    2. If 1 org: return it automatically
    3. If multiple: emit user_question event and return None

    Args:
        ctx: ReACT context object
        client: MerakiClient instance
        on_event: Event callback

    Returns:
        Organization ID or None (None means user input required)
    """
    from ccie_sidecar.agents.react import _execute_tool

    # Import catalog generator
    try:
        from terminai_meraki.catalog import generate_catalog
        catalog = [t.to_dict() for t in generate_catalog()]
    except ImportError:
        # Catalog not available
        return None

    # Call list-organizations
    result = _execute_tool(
        "meraki_organizations_list_organizations",
        {},
        catalog,
        client,
    )

    if not result.get("ok"):
        # API error - can't disambiguate
        return None

    orgs = result.get("data", [])

    if len(orgs) == 0:
        # No orgs available
        return None

    if len(orgs) == 1:
        # Single org - use it
        org_id = orgs[0].get("id")
        if org_id:
            # Update context
            ctx.org_id = org_id
        return org_id

    # Multiple orgs - emit user_question
    pending_id = str(uuid.uuid4())
    on_event({
        "type": "user_question",
        "pending_id": pending_id,
        "param": "organizationId",
        "prompt": "Which organization?",
        "options": [
            {"id": o.get("id"), "label": o.get("name", o.get("id"))}
            for o in orgs
        ],
    })

    return None  # Loop will pause


async def _disambiguate_network_id(
    ctx: ReACTContext,
    client,
    on_event: Callable,
) -> Optional[str]:
    """
    Disambiguate network ID.

    Strategy:
    1. First resolve org_id (if needed)
    2. Call list-networks for that org
    3. If 1 network: return it
    4. If multiple: emit user_question

    Args:
        ctx: ReACT context object
        client: MerakiClient instance
        on_event: Event callback

    Returns:
        Network ID or None
    """
    from ccie_sidecar.agents.react import _execute_tool

    # Import catalog generator
    try:
        from terminai_meraki.catalog import generate_catalog
        catalog = [t.to_dict() for t in generate_catalog()]
    except ImportError:
        return None

    # First resolve org_id
    org_id = ctx.org_id
    if not org_id:
        org_id = await _disambiguate_org_id(ctx, client, on_event)

    if not org_id:
        # Can't proceed without org_id
        return None

    # List networks in org
    result = _execute_tool(
        "meraki_organizations_get_organization_networks",
        {"organizationId": org_id},
        catalog,
        client,
    )

    if not result.get("ok"):
        return None

    networks = result.get("data", [])

    if len(networks) == 0:
        return None

    if len(networks) == 1:
        # Single network - use it
        net_id = networks[0].get("id")
        if net_id:
            ctx.network_id = net_id
        return net_id

    # Multiple networks - emit user_question
    pending_id = str(uuid.uuid4())
    on_event({
        "type": "user_question",
        "pending_id": pending_id,
        "param": "networkId",
        "prompt": f"Which network in organization {org_id}?",
        "options": [
            {"id": n.get("id"), "label": n.get("name", n.get("id"))}
            for n in networks
        ],
    })

    return None


async def _disambiguate_serial(
    ctx: ReACTContext,
    client,
    on_event: Callable,
) -> Optional[str]:
    """
    Disambiguate device serial.

    Strategy:
    1. First resolve org_id and network_id (if needed)
    2. Call list-devices for that network
    3. If 1 device: return its serial
    4. If multiple: emit user_question

    Args:
        ctx: ReACT context object
        client: MerakiClient instance
        on_event: Event callback

    Returns:
        Device serial or None
    """
    from ccie_sidecar.agents.react import _execute_tool

    # Import catalog generator
    try:
        from terminai_meraki.catalog import generate_catalog
        catalog = [t.to_dict() for t in generate_catalog()]
    except ImportError:
        return None

    # First resolve network_id (this will also resolve org_id)
    network_id = ctx.network_id
    if not network_id:
        network_id = await _disambiguate_network_id(ctx, client, on_event)

    if not network_id:
        # Can't proceed without network_id
        return None

    # List devices in network
    result = _execute_tool(
        "meraki_networks_get_network_devices",
        {"networkId": network_id},
        catalog,
        client,
    )

    if not result.get("ok"):
        return None

    devices = result.get("data", [])

    if len(devices) == 0:
        return None

    if len(devices) == 1:
        # Single device - use it
        serial = devices[0].get("serial")
        if serial:
            ctx.serial = serial
        return serial

    # Multiple devices - emit user_question
    pending_id = str(uuid.uuid4())
    on_event({
        "type": "user_question",
        "pending_id": pending_id,
        "param": "serial",
        "prompt": f"Which device in network {network_id}?",
        "options": [
            {
                "id": d.get("serial"),
                "label": f"{d.get('name', 'Unnamed')} ({d.get('model', 'Unknown')}) - {d.get('serial')}",
            }
            for d in devices
        ],
    })

    return None

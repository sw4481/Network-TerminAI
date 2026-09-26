"""MCP tool integration for CCIE Terminal AI agent."""
from __future__ import annotations

import json
import sys
from typing import Any


def _reverse_call(method: str, params: dict[str, Any]) -> dict[str, Any]:
    """
    Make a reverse call to Rust backend via NDJSON.

    This sends a request to stdout and waits for a response on stdin.

    Args:
        method: The method name to call (e.g., "mcp_invoke")
        params: Parameters for the method

    Returns:
        Response dict from Rust

    Raises:
        Exception: If the call fails or times out
    """
    # Generate unique request ID
    import time
    req_id = f"mcp-{int(time.time() * 1000)}"

    # Send request to Rust via stdout
    request = {
        "id": req_id,
        "method": method,
        "params": params
    }

    sys.stdout.write(json.dumps(request) + "\n")
    sys.stdout.flush()

    # Wait for response on stdin
    # Note: In production, this would have timeout handling
    # For now, we trust Rust to respond
    response_line = sys.stdin.readline()

    if not response_line:
        raise Exception("No response from backend")

    response = json.loads(response_line.strip())

    # Verify response ID matches
    if response.get("id") != req_id:
        raise Exception(f"Response ID mismatch: expected {req_id}, got {response.get('id')}")

    return response


def request_mcp_tool(server: str, tool: str, args: dict[str, Any]) -> dict[str, Any] | None:
    """
    Request execution of an MCP tool with approval gating.

    This function:
    1. Sends request to Rust backend
    2. Waits for user approval (Rust shows UI modal)
    3. If approved, Rust executes tool and returns result
    4. Returns result to agent

    Args:
        server: MCP server name (e.g., "filesystem")
        tool: Tool name (e.g., "read_file")
        args: Tool arguments as dict

    Returns:
        Tool result dict if approved and successful
        None if user denied approval

    Raises:
        Exception: If tool execution fails
    """
    response = _reverse_call("mcp_invoke", {
        "server": server,
        "tool": tool,
        "args": args
    })

    # Check for error
    if "error" in response:
        raise Exception(response["error"])

    # Check if approved
    if not response.get("approved", False):
        return None

    # Return the result
    return response.get("result")


def get_mcp_tools() -> list[dict[str, Any]]:
    """
    Get list of available MCP tools from Rust backend.

    Returns:
        List of tool definitions with server, name, description, and schema
    """
    response = _reverse_call("mcp_list_tools", {})

    if "error" in response:
        raise Exception(response["error"])

    return response.get("tools", [])


def format_tool_name(server: str, tool: str) -> str:
    """
    Format MCP tool name for agent use.

    Converts server and tool names into a unique identifier.
    Example: ("test-server", "my_tool") -> "mcp_test_server__my_tool"

    Args:
        server: MCP server name
        tool: Tool name

    Returns:
        Formatted tool name string
    """
    # Sanitize server name (replace special chars with underscore)
    safe_server = server.replace("-", "_").replace(".", "_")
    # Sanitize tool name as well
    safe_tool = tool.replace("-", "_").replace(".", "_")
    return f"mcp_{safe_server}__{safe_tool}"


def parse_tool_name(tool_name: str) -> tuple[str, str]:
    """
    Parse MCP tool name back to server and tool components.

    Args:
        tool_name: Formatted tool name (e.g., "mcp_test_server__my_tool")

    Returns:
        Tuple of (server_name, tool_name)

    Raises:
        ValueError: If tool name is not in MCP format
    """
    if not tool_name.startswith("mcp_"):
        raise ValueError(f"Not an MCP tool name: {tool_name}")

    # Remove "mcp_" prefix
    remainder = tool_name[4:]

    # Split on double underscore
    if "__" not in remainder:
        raise ValueError(f"Invalid MCP tool name format: {tool_name}")

    safe_server, tool = remainder.split("__", 1)

    # Convert safe server name back to original format
    # (This is a simple heuristic - may need refinement)
    server = safe_server.replace("_", "-")

    return server, tool

"""LangChain tools for DeepAgents — wraps our custom sandbox."""
from __future__ import annotations

from typing import Any, Callable

from langchain_core.tools import StructuredTool
from langgraph.store.base import BaseStore


def create_execute_python_code_tool(
    cli_package: str | None,
    vault_secrets: dict[str, Any],
    emit_callback: Callable[[dict], None],
) -> StructuredTool:
    """
    Create a LangChain tool that wraps our custom code execution sandbox.

    This preserves the proven pyats/meraki/drawio flows by reusing
    _build_sandbox_globals and _execute_code_with_timeout unchanged.

    The emit callback is passed through so drawio.diagram(...) can stream
    diagram events via LangGraph's custom stream.

    Args:
        cli_package: Name of CLI package to load (e.g., "meraki"), or None
        vault_secrets: Vault secrets dict (e.g., {"meraki_api_key": "..."})
        emit_callback: Function to emit custom events (for drawio diagrams)

    Returns:
        StructuredTool wrapping execute_python_code
    """
    from ccie_sidecar.agents.code_exec import (
        _build_sandbox_globals,
        _execute_code_with_timeout,
        _build_env_overrides,
    )

    # Build sandbox once (reused across tool calls in the same session)
    sandbox_globals = _build_sandbox_globals(cli_package, vault_secrets, emit=emit_callback)
    env_overrides = _build_env_overrides(vault_secrets)

    def execute_python_code(code: str) -> str:
        """
        Execute Python code in the sandbox and return stdout.

        Args:
            code: Python code to execute

        Returns:
            String output from the code execution (stdout + stderr)
        """
        # Execute with timeout (returns a dict: success/output/error)
        result = _execute_code_with_timeout(
            code=code,
            globals_dict=sandbox_globals,
            env_overrides=env_overrides,
            timeout=30,
            label=cli_package or "deepagents",
        )

        if result.get("success"):
            output = result.get("output", "")
            return output if output else "(no output)"
        else:
            return f"Error: {result.get('error', 'Unknown error')}"

    # Build tool description showing what's pre-loaded. Memory-first line goes
    # FIRST (same channel as the vendor "your ONLY way" lines) so the agent
    # checks KNOWN FACTS before making a live vendor call. "" when flag off.
    from ccie_sidecar.agents.graph_helper import memory_first_preamble
    preloaded_lines = []
    _mem = memory_first_preamble()
    if _mem:
        preloaded_lines.append(_mem)
    preloaded_lines += [
        "- json, datetime, collections, os (stdlib)",
        "- pd (pandas)",
        "- requests (HTTP client)",
        "- drawio: render draw.io diagrams. drawio.diagram(xml=..., title=...) "
        "for mxGraph/draw.io XML (previews inline in the app); "
        "drawio.from_mermaid(mermaid=..., title=...); drawio.from_csv(csv=..., title=...). "
        "Each call renders the diagram for the user and returns {url, xml}. "
        "Call it from your code; do NOT print the raw XML.",
    ]

    if cli_package == "meraki":
        preloaded_lines.append(
            "- meraki_api_call(method, path, body=None, query_params=None): "
            "your ONLY way to reach the Cisco Meraki Dashboard (do NOT use "
            "requests or the meraki SDK). Returns a JSON string; json.loads it "
            "-> {'status_code', 'data', 'error', 'blast_radius'}. Paths are under "
            "https://api.meraki.com/api/v1 (omit that prefix); GET lists are "
            "auto-paginated. Find by name first, then query by id: "
            "orgs = json.loads(meraki_api_call('GET','/organizations'))['data']; "
            "nets = json.loads(meraki_api_call('GET', f'/organizations/{org_id}/networks'))['data']; "
            "devices = json.loads(meraki_api_call('GET', f'/networks/{net_id}/devices'))['data']; "
            "one device = json.loads(meraki_api_call('GET', f'/devices/{serial}'))['data']; "
            "alerts = json.loads(meraki_api_call('GET', f'/organizations/{org_id}/assurance/alerts'))['data'] "
            "(org-wide; filter by deviceSerial) or /networks/{net_id}/health/alerts. "
            "ALWAYS fetch real data for device detail via GET /devices/{serial} — "
            "NEVER describe a model's specs from memory. If a path 404s, call "
            "meraki.help() for the right one instead of guessing."
        )
    if cli_package == "stealthwatch":
        preloaded_lines.append(
            "- stealthwatch_api_call(method, path, body=None, query_params=None): "
            "your ONLY way to reach Stealthwatch (do NOT use requests or proxmox). "
            "Returns a JSON string; json.loads it -> "
            "{'status_code', 'data', 'error', 'blast_radius'}. "
            "STEP 1 ALWAYS get the tenant id: "
            "json.loads(stealthwatch_api_call('GET','/sw-reporting/v1/tenants'))"
            "['data']['data'][0]['id'], then use it in every subsequent path."
        )
    if vault_secrets:
        secret_names = ", ".join(vault_secrets.keys())
        preloaded_lines.append(f"- Vault secrets as variables: {secret_names}")
    if env_overrides:
        env_names = ", ".join(sorted(env_overrides.keys()))
        preloaded_lines.append(
            f"- Env vars set in os.environ: {env_names} "
            "(use these EXACT names; do not invent shorter aliases)"
        )
    preloaded_lines.append("Standard `import` statements work for any installed package.")
    preloaded = "\n".join(preloaded_lines)

    # Categorized API method index + discovery hint so the model picks the right
    # method instead of guessing from the handful of examples above.
    from ccie_sidecar.agents.sandbox_index import build_method_index, build_discovery_hint
    method_index = build_method_index(cli_package, sandbox_globals)
    discovery_hint = build_discovery_hint(cli_package)

    tool_description = (
        "Execute Python code to answer questions. "
        "Use for calculations, data analysis, or to query infrastructure. "
        "Only print() output is visible to you.\n\n"
        f"Pre-loaded in the sandbox:\n{preloaded}"
    )
    if discovery_hint:
        tool_description += f"\n\n{discovery_hint}"
    if method_index:
        tool_description += f"\n\n{method_index}"

    return StructuredTool.from_function(
        func=execute_python_code,
        name="execute_python_code",
        description=tool_description,
    )


def convert_meraki_catalog_to_langchain_tools(
    catalog: list[dict[str, Any]],
    vault_entry: str | None,
    vault_secrets: dict[str, Any],
) -> list[StructuredTool]:
    """
    Convert Meraki API tool catalog to LangChain StructuredTool list.

    Each tool is tagged with its blast_radius for approval gating.
    Tools execute against the Meraki API via MerakiClient.

    Args:
        catalog: List of tool definitions from bundled-agents/meraki/tools.json
        vault_entry: Name of vault entry (e.g., "meraki_api_key")
        vault_secrets: Dict of secrets from vault (e.g., {"api_key": "..."})

    Returns:
        List of StructuredTool instances with actual Meraki execution
    """
    import sys
    from pathlib import Path

    # Initialize Meraki client (reusing legacy initialization logic)
    meraki_cli_path = Path(__file__).parent.parent.parent.parent.parent / "meraki_cli" / "src"
    if meraki_cli_path.exists() and str(meraki_cli_path) not in sys.path:
        sys.path.insert(0, str(meraki_cli_path))

    try:
        from terminai_meraki import MerakiClient
    except ImportError as e:
        raise ImportError(
            f"Failed to import MerakiClient: {e}\n"
            f"Ensure terminai-meraki package is installed"
        )

    # Initialize client with vault secrets
    if vault_secrets:
        api_key = (
            vault_secrets.get("api_key") or
            vault_secrets.get("MERAKI_API_KEY") or
            vault_secrets.get("meraki_api_key") or
            (list(vault_secrets.values())[0] if len(vault_secrets) == 1 else None)
        )
        if api_key:
            client = MerakiClient(api_key=api_key)
        elif vault_entry:
            client = MerakiClient.from_vault(vault_entry)
        else:
            client = MerakiClient.from_env()
    elif vault_entry:
        client = MerakiClient.from_vault(vault_entry)
    else:
        client = MerakiClient.from_env()

    tools = []

    for tool_def in catalog:
        name = tool_def.get("name", "unknown_tool")
        description = tool_def.get("description", "")
        blast_radius = tool_def.get("blast_radius", "medium")
        resource = tool_def.get("resource", "")
        action = tool_def.get("action", "")

        # Convert catalog name to LangChain-friendly name
        # meraki.organizations.list-organizations → meraki_organizations_list_organizations
        langchain_name = name.replace(".", "_").replace("-", "_")

        def make_tool_func(res: str, act: str, tool_name: str):
            """Closure to capture resource, action, and tool name."""
            def tool_func(**kwargs: Any) -> str:
                """Execute Meraki API call."""
                try:
                    # Call Meraki API
                    result = client.call(res, act, **kwargs)

                    # Return formatted result
                    if result.get("ok"):
                        import json
                        data = result.get("data", {})
                        return json.dumps(data, indent=2) if data else "Success (no data)"
                    else:
                        error = result.get("error", {})
                        error_msg = error.get("message", "Unknown error")
                        error_code = error.get("code", "unknown")
                        return f"Error ({error_code}): {error_msg}"

                except Exception as e:
                    return f"Tool execution error: {str(e)}"

            return tool_func

        tool = StructuredTool.from_function(
            func=make_tool_func(resource, action, name),
            name=langchain_name,
            description=description,
        )
        # Tag with blast_radius for approval middleware
        tool.metadata = {"blast_radius": blast_radius}
        tools.append(tool)

    return tools

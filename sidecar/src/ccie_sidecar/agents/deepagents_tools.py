"""LangChain tools for DeepAgents — wraps our custom sandbox."""
from __future__ import annotations

from typing import Any, Callable

from langchain_core.tools import StructuredTool
from langgraph.store.base import BaseStore

from ccie_sidecar.agents.tool_output import (
    TOOL_OUTPUT_GUIDANCE,
    install_tool_output_policy,
)


def create_execute_python_code_tool(
    cli_package: str | None,
    vault_secrets: dict[str, Any],
    emit_callback: Callable[[dict], None],
    catalogs: list[dict[str, Any]] | None = None,
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
        catalogs: Raw tool catalogs retained inside the sandbox for bounded
            search and endpoint validation. They are never copied into the
            tool description.

    Returns:
        StructuredTool wrapping execute_python_code
    """
    from ccie_sidecar.agents.code_exec import (
        _build_sandbox_globals,
        _execute_code_with_timeout,
        _build_env_overrides,
    )

    # Build sandbox once (reused across tool calls in the same session)
    sandbox_globals = _build_sandbox_globals(
        cli_package,
        vault_secrets,
        emit=emit_callback,
        catalogs=catalogs,
    )
    env_overrides = _build_env_overrides(vault_secrets)
    output_policy, tool_output = install_tool_output_policy(
        sandbox_globals,
        sensitive_values=(
            *vault_secrets.values(),
            *env_overrides.values(),
        ),
    )
    def execute_python_code(code: str) -> str:
        """
        Execute Python code in the sandbox and return stdout.

        Args:
            code: Python code to execute

        Returns:
            String output from the code execution (stdout + stderr)
        """
        # The shared code-exec seam serializes process-global stdout/env state;
        # its queue wait occurs before this 30-second execution budget starts.
        result = _execute_code_with_timeout(
            code=code,
            globals_dict=sandbox_globals,
            env_overrides=env_overrides,
            timeout=30,
            label=cli_package or "deepagents",
        )
        return output_policy.format_execution_result(result, tool_output)

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
        "- tool_output: inspect the latest oversized execute_python_code result "
        "with stats(), head(), tail(), grep(...), or json().",
        "- drawio: render draw.io diagrams. drawio.diagram(xml=..., title=...) "
        "for mxGraph/draw.io XML (previews inline in the app); "
        "drawio.from_mermaid(mermaid=..., title=...); drawio.from_csv(csv=..., title=...). "
        "Each call renders the diagram for the user and returns {url, xml}. "
        "Call it from your code; do NOT print the raw XML.",
        "- blender: control a local Blender scene via the BlenderMCP addon. "
        "Use blender.status(), scene_info(), object_info(name), screenshot(), "
        "execute_code(code), or blender.help().",
        "- computer: configured LXC agent computers. Use computer.list(), "
        "computer.health(name), computer.read_file(name, path). Remote exec/write "
        "require confirm=True after user approval.",
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
    if cli_package == "zabbix":
        preloaded_lines.append(
            "- zabbix_api_call(method, params=None): your ONLY way to make a "
            "read-only Zabbix JSON-RPC request. It is a pre-loaded global: Do NOT "
            "import zabbix_api, inspect the helper, use requests, or read configuration "
            "files. It returns a JSON string; parse and inspect it exactly like this: "
            "import json; result = json.loads(zabbix_api_call('host.get', "
            "{'output':['hostid','host','name'],'limit':10})); "
            "if result['error']: print(result['error']); else: records = result['data']; "
            "print(type(records).__name__); "
            "[print(row.get('hostid'), row.get('host'), row.get('name', '')) "
            "for row in records] if isinstance(records, list) else print(records). "
            "The envelope is {'status_code': int, 'data': payload, 'error': str|None, "
            "'blast_radius': 'low'}. JSON-RPC get/list calls normally put a LIST of "
            "objects directly in result['data']; never use .items() on that list and "
            "never assume a 'name' key exists. Only zabbix_apply(method, params, rationale) "
            "may propose an allowed mutation; never call it for a read."
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
    if sandbox_globals.get("api_catalog") is not None:
        preloaded_lines.append(
            "- Catalog discovery is the TOP-LEVEL search_api_catalog tool; do not perform "
            "discovery inside Python. Vendor helpers returned by that tool are pre-loaded "
            "globals, not modules (for example, call ise_api_call(...) directly; never "
            "`import ise` or `import api_catalog`)."
        )
    preloaded_lines.append(
        "Standard `import` statements work for installed packages only. Names listed "
        "above as pre-loaded helpers are globals and must not be imported."
    )
    preloaded = "\n".join(preloaded_lines)

    # Catalog-backed agents use bounded in-sandbox discovery instead of copying
    # a full schema/method index into every model call. Non-catalog sandboxes keep
    # the legacy compact discovery hints.
    from ccie_sidecar.agents.catalog_grounding import catalog_prompt_hint
    catalog_hint = catalog_prompt_hint(sandbox_globals.get("api_catalog"))
    from ccie_sidecar.agents.sandbox_index import build_method_index, build_discovery_hint
    method_index = "" if catalog_hint else build_method_index(cli_package, sandbox_globals)
    discovery_hint = "" if catalog_hint else build_discovery_hint(cli_package)

    tool_description = (
        "Execute Python code to answer questions. "
        "Use for calculations, data analysis, or to query infrastructure. "
        "Only print() output is visible to you.\n\n"
        f"Pre-loaded in the sandbox:\n{preloaded}\n\n"
        f"{TOOL_OUTPUT_GUIDANCE}"
    )
    if discovery_hint:
        tool_description += f"\n\n{discovery_hint}"
    if method_index:
        tool_description += f"\n\n{method_index}"
    if catalog_hint:
        tool_description += f"\n\n{catalog_hint}"

    tool = StructuredTool.from_function(
        func=execute_python_code,
        name="execute_python_code",
        description=tool_description,
    )
    # Keep the catalog index attached only in process memory. A sibling native
    # search tool reads this exact object, so discovery authorizes the same
    # guarded helpers used by execute_python_code without copying catalog text
    # into either tool description.
    object.__setattr__(
        tool,
        "_ccie_catalog_index",
        sandbox_globals.get("api_catalog"),
    )
    return tool


def create_catalog_search_tool(
    execute_code_tool: StructuredTool,
) -> StructuredTool | None:
    """Expose bounded catalog discovery as a native model tool.

    Requiring the model to write Python merely to call ``api_catalog.search``
    caused small models to waste their graph budget importing and inspecting a
    pre-bound object. This structured tool closes over the *same* CatalogIndex
    used by the code sandbox, preserving authorization while making discovery a
    single, schema-checked tool call.
    """
    index = getattr(execute_code_tool, "_ccie_catalog_index", None)
    if index is None:
        return None

    from ccie_sidecar.agents.catalog_grounding import CatalogGroundingError

    def search_api_catalog(
        query: str,
        catalog_id: str,
        limit: int = 5,
    ) -> dict[str, Any]:
        """Search one configured vendor catalog for the current API intent."""
        try:
            return index.search(query, catalog_id=catalog_id, limit=limit)
        except CatalogGroundingError as error:
            # A native tool exception aborts the entire DeepAgents graph before
            # the model can obey the guard's STOP instruction. Preserve the
            # strict in-memory budget, but return its expected policy failure as
            # tool data so the model can finish from prior live results.
            return {
                "ok": False,
                "error_type": "CatalogGroundingError",
                "error": str(error),
                "instruction": (
                    "STOP SEARCHING. Use an exact allowed match already returned "
                    "for a real helper call. If none fits, report live state as "
                    "unknown; do not guess or enumerate the catalog."
                ),
            }

    tool_properties = execute_code_tool.args_schema.model_json_schema().get(
        "properties", {}
    )
    if "code" in tool_properties:
        call_instruction = (
            f"immediately call {execute_code_tool.name}; for an HTTP match, its code "
            "must call matches[*].helper with matches[*].method and the concrete "
            "matches[*].path, never an SDK-shaped catalog label"
        )
    elif "operation" in tool_properties:
        call_instruction = (
            f"immediately call {execute_code_tool.name} with its exact "
            "matches[*].operation and arguments"
        )
    else:
        call_instruction = (
            f"immediately call {execute_code_tool.name} using the exact returned "
            "record fields accepted by its schema"
        )

    return StructuredTool.from_function(
        func=search_api_catalog,
        name="search_api_catalog",
        description=(
            "MANDATORY first tool for a live platform API operation. Search one "
            "configured vendor's in-memory catalog using the user's specific intent. "
            "Returns {'matches': [...]} with exact authorized methods/paths or operations. "
            f"When any match fits, STOP searching and {call_instruction}; do not "
            "enumerate, import, inspect, or guess."
        ),
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

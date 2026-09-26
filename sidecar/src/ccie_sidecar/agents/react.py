"""
ReACT loop implementation for Meraki CLI agent integration.

This module implements the core reasoning and action loop for agent-driven
Meraki API interactions. It orchestrates LLM reasoning with tool execution,
streaming events back to the frontend for real-time visibility.

Phase 3: Basic loop with tool execution
Phase 4: Disambiguation and context integration
Phase 5: Approval gating for high-risk actions
"""

import json
import os
import sys
import time
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

from ccie_sidecar.approvals import (
    is_tier_allowed,
    request_approval,
    get_session_approvals,
    log_tool_call,
)


# Maximum ReACT loop steps to prevent infinite loops
MAX_STEPS = 12


def _convert_assistant_message_for_provider(
    content_blocks: List[Dict[str, Any]],
    provider: str,
) -> Dict[str, Any]:
    """
    Convert unified content blocks to provider-specific assistant message format.

    Args:
        content_blocks: Unified format [{"type": "text"|"tool_use", ...}]
        provider: Provider name

    Returns:
        Provider-specific message dict
    """
    if provider == "anthropic":
        # Anthropic uses content blocks directly
        return {"role": "assistant", "content": content_blocks}

    # OpenAI/vLLM format
    text_parts = []
    tool_calls = []

    for block in content_blocks:
        if block.get("type") == "text":
            text_parts.append(block.get("text", ""))
        elif block.get("type") == "tool_use":
            tool_calls.append({
                "id": block.get("id"),
                "type": "function",
                "function": {
                    "name": block.get("name"),
                    "arguments": json.dumps(block.get("input", {})),
                }
            })

    message = {"role": "assistant"}
    if text_parts:
        message["content"] = "".join(text_parts)
    else:
        message["content"] = None  # OpenAI requires content even if null

    if tool_calls:
        message["tool_calls"] = tool_calls

    return message


def _convert_tool_result_for_provider(
    tool_call_id: str,
    tool_name: str,
    result: Dict[str, Any],
    provider: str,
) -> Dict[str, Any]:
    """
    Convert tool result to provider-specific format.

    Args:
        tool_call_id: Tool call ID
        tool_name: Tool name
        result: Unified result envelope
        provider: Provider name

    Returns:
        Provider-specific message dict
    """
    if provider == "anthropic":
        # Anthropic format
        return {
            "type": "tool_result",
            "tool_use_id": tool_call_id,
            "content": json.dumps(result)
        }

    # OpenAI/vLLM format
    return {
        "role": "tool",
        "tool_call_id": tool_call_id,
        "name": tool_name,
        "content": json.dumps(result),
    }


def _call_llm_with_tools(
    provider: str,
    model: str,
    api_key: Optional[str],
    base_url: Optional[str],
    messages: List[Dict[str, Any]],
    tools: List[dict],
    system_prompt: str,
) -> Dict[str, Any]:
    """
    Call LLM with tool support across different providers.

    Returns response in unified format:
    {
        "stop_reason": "end_turn" | "tool_use" | "max_tokens" | "error",
        "content": [{"type": "text"|"tool_use", ...}],
        "error": "..." (only if stop_reason == "error")
    }
    """
    if provider == "anthropic":
        from ccie_sidecar.providers.anthropic import call_with_tools
        return call_with_tools(
            api_key=api_key,
            model=model,
            messages=messages,
            tools=tools,
            system=system_prompt,
        )
    elif provider == "openai":
        from ccie_sidecar.providers.openai import call_with_tools
        return call_with_tools(
            api_key=api_key,
            model=model,
            messages=messages,
            tools=tools,
            system=system_prompt,
        )
    elif provider == "nvidia":
        from ccie_sidecar.providers.nvidia import call_with_tools
        return call_with_tools(
            api_key=api_key,
            model=model,
            messages=messages,
            tools=tools,
            system=system_prompt,
        )
    elif provider == "vllm":
        from ccie_sidecar.providers.vllm import call_with_tools
        return call_with_tools(
            endpoint=base_url,
            model=model,
            messages=messages,
            tools=tools,
            api_key=api_key,
        )
    elif provider == "google":
        # Google Gemini tool calling support
        # TODO: Implement when gemini provider supports tools
        return {
            "stop_reason": "error",
            "error": "Google Gemini tool calling not yet implemented"
        }
    elif provider == "ollama":
        # Ollama tool calling support
        # TODO: Implement when ollama provider supports tools
        return {
            "stop_reason": "error",
            "error": "Ollama tool calling not yet implemented"
        }
    else:
        return {
            "stop_reason": "error",
            "error": f"Unknown provider: {provider}"
        }


async def react_loop(
    agent_def: dict,
    user_msg: str,
    ctx: dict,
    on_event: Callable[[dict], None],
    conversation_id: Optional[str] = None,
    db_conn: Optional[Any] = None,
) -> None:
    """
    Execute ReACT loop: Thought → Action → Observation → ... → Final.

    This function implements a basic ReACT (Reasoning and Acting) loop where
    an LLM alternates between:
    1. Thinking about what to do next
    2. Using tools to gather information or take actions
    3. Observing results
    4. Repeating until it has enough information to answer

    Args:
        agent_def: Agent definition dict containing:
            - system_prompt: Base system prompt
            - attached_tools: List of tool attachments with catalog and vault_entry
            - model_override: Optional model configuration
        user_msg: User's message/query
        ctx: Context dict (empty for Phase 3, will contain history in Phase 4)
        on_event: Callback function to emit events to frontend

    Events emitted:
        - {"type": "thought_start", "step": int}
        - {"type": "tool_call", "name": str, "args": dict, "blast_radius": str}
        - {"type": "tool_result", "name": str, "ok": bool, "data": any, "meta": dict}
        - {"type": "final", "response": str}
        - {"type": "error", "message": str, "hint": str}
    """
    try:
        # Load tool catalog from agent definition
        if not agent_def.get("attached_tools"):
            on_event({
                "type": "error",
                "message": "No tools attached to agent",
                "hint": "Agent must have attached_tools with a Meraki catalog"
            })
            return

        tool_attachment = agent_def["attached_tools"][0]
        catalog_json = tool_attachment.get("catalog")
        vault_entry = tool_attachment.get("vault_entry")
        vault_secrets = tool_attachment.get("vault_secrets") or {}

        if not catalog_json:
            on_event({
                "type": "error",
                "message": "No catalog found in tool attachment",
                "hint": "Tool attachment must include a catalog JSON string"
            })
            return

        # Parse catalog
        try:
            catalog = json.loads(catalog_json)
        except json.JSONDecodeError as e:
            on_event({
                "type": "error",
                "message": f"Failed to parse tool catalog: {e}",
                "hint": "Catalog must be valid JSON array of ToolSpec objects"
            })
            return

        # Initialize Meraki client with vault secrets
        meraki_client = _initialize_meraki_client(vault_entry, vault_secrets)

        # Get LLM configuration from user settings
        from ccie_sidecar.agent import get_saved_config

        config = get_saved_config()
        if not config:
            on_event({
                "type": "error",
                "message": "No AI provider configured",
                "hint": "Open Settings → General and configure an AI provider"
            })
            return

        provider = config.get("provider", "anthropic")

        # Convert catalog to tool format appropriate for the provider
        tools = _convert_catalog_to_tools(catalog, provider)
        model = config.get("model", "claude-sonnet-4-6")
        api_key = config.get("api_key")
        base_url = config.get("base_url")

        # Allow agent model_override to specify a different model (but keep same provider)
        if agent_def.get("model_override"):
            override = agent_def["model_override"]
            if isinstance(override, dict) and override.get("model"):
                model = override["model"]

        # Validate API key/endpoint based on provider
        if provider == "anthropic":
            if not api_key:
                api_key = os.getenv("ANTHROPIC_API_KEY")
            if not api_key:
                on_event({
                    "type": "error",
                    "message": "Anthropic API key not configured",
                    "hint": "Set API key in Settings → General or set ANTHROPIC_API_KEY environment variable"
                })
                return
        elif provider == "openai":
            if not api_key:
                api_key = os.getenv("OPENAI_API_KEY")
            if not api_key:
                on_event({
                    "type": "error",
                    "message": "OpenAI API key not configured",
                    "hint": "Set API key in Settings → General or set OPENAI_API_KEY environment variable"
                })
                return
        elif provider == "google":
            if not api_key:
                api_key = os.getenv("GOOGLE_API_KEY")
            if not api_key:
                on_event({
                    "type": "error",
                    "message": "Google API key not configured",
                    "hint": "Set API key in Settings → General or set GOOGLE_API_KEY environment variable"
                })
                return
        elif provider == "nvidia":
            if not api_key:
                api_key = os.getenv("NVIDIA_API_KEY")
            if not api_key:
                on_event({
                    "type": "error",
                    "message": "NVIDIA API key not configured",
                    "hint": "Set API key in Settings → General or set NVIDIA_API_KEY environment variable"
                })
                return
        elif provider == "vllm":
            endpoint = base_url or os.getenv("VLLM_ENDPOINT", "http://localhost:8000")
            if not endpoint.rstrip("/").endswith("/v1"):
                endpoint = endpoint.rstrip("/") + "/v1"
            base_url = endpoint
        elif provider == "ollama":
            endpoint = base_url or os.getenv("OLLAMA_HOST", "http://localhost:11434")
            base_url = endpoint
        else:
            on_event({
                "type": "error",
                "message": f"Unsupported provider: {provider}",
                "hint": f"ReACT loop supports: anthropic, openai, google, nvidia, vllm, ollama. Current: {provider}"
            })
            return

        # Build system prompt
        system_prompt = agent_def.get("system_prompt", "")
        if not system_prompt:
            system_prompt = """You are a Meraki Dashboard API expert.

EFFICIENCY RULES:
- Remember tool results from earlier in this conversation
- NEVER call the same tool with the same parameters twice
- Use data you already have - don't re-fetch
- For "list X in org Y": call list_organizations ONCE, then list_X ONCE

FORMATTING RULES:
- Present lists and data as clean Markdown tables
- Use pipe syntax: | Column1 | Column2 |
- Include header separator: |---------|---------|
- Keep tables readable with proper alignment
- For large datasets: show summary stats + table
- NO ASCII art tables or pipe characters in plain text

Example table format:
| Network Name | Product Types | ID |
|--------------|---------------|-----|
| Main-Office | switch, wireless | 123 |
| Branch-Site | appliance | 456 |

Your goal: answer accurately with MINIMUM tool calls and CLEAN formatting."""

        # Initialize conversation history (prepend prior turns for multi-turn context)
        from ccie_sidecar.agents.code_exec import build_history_messages
        messages: List[Dict[str, Any]] = build_history_messages(ctx, user_msg)

        # Tool call cache to prevent redundant API calls within same conversation
        tool_call_cache: Dict[str, Dict[str, Any]] = {}

        def cache_key(tool_name: str, tool_input: dict) -> str:
            """Generate cache key from tool name and normalized input."""
            import json
            return f"{tool_name}:{json.dumps(tool_input, sort_keys=True)}"

        # ReACT loop
        for step in range(1, MAX_STEPS + 1):
            on_event({"type": "thought_start", "step": step})

            # Call LLM with tools (provider-agnostic)
            try:
                response = _call_llm_with_tools(
                    provider=provider,
                    model=model,
                    api_key=api_key,
                    base_url=base_url,
                    messages=messages,
                    tools=tools,
                    system_prompt=system_prompt,
                )

                if response.get("stop_reason") == "error":
                    on_event({
                        "type": "error",
                        "message": f"LLM request failed: {response.get('error', 'Unknown error')}",
                        "hint": "Check API key and network connectivity"
                    })
                    return
            except Exception as e:
                on_event({
                    "type": "error",
                    "message": f"LLM request failed: {str(e)}",
                    "hint": "Check API key and network connectivity"
                })
                return

            # Check stop reason
            if response.get("stop_reason") == "end_turn":
                # Extract final text content
                text_content = ""
                for block in response.get("content", []):
                    if block.get("type") == "text":
                        text_content += block.get("text", "")

                on_event({"type": "final", "response": text_content})
                return

            # Process tool calls
            if response.get("stop_reason") == "tool_use":
                # Convert and add assistant message
                assistant_msg = _convert_assistant_message_for_provider(
                    response.get("content", []),
                    provider
                )
                messages.append(assistant_msg)

                # Execute each tool call
                tool_results = []
                for block in response.get("content", []):
                    if block.get("type") == "tool_use":
                        tool_call_id = block.get("id")
                        tool_name = block.get("name")
                        tool_input = block.get("input", {})

                        # Find tool spec in catalog for blast radius
                        tool_spec = _find_tool_spec(catalog, tool_name)
                        blast_radius = tool_spec.get("blast_radius", "unknown") if tool_spec else "unknown"

                        # Emit tool call event
                        on_event({
                            "type": "tool_call",
                            "name": tool_name,
                            "args": tool_input,
                            "blast_radius": blast_radius
                        })

                        # === PHASE 5: APPROVAL GATING ===
                        # Check if tier is allowed
                        default_allowed = tool_attachment.get('default_blast_radius_allowed', 'low')
                        approval_status = 'auto'
                        result = None
                        start_time = time.time()

                        if not is_tier_allowed(blast_radius, default_allowed):
                            # Check session approvals
                            session_approvals = get_session_approvals(
                                conversation_id or "unknown",
                                db_conn
                            )

                            tool_catalog_name = tool_spec.get('name', tool_name) if tool_spec else tool_name

                            if tool_catalog_name in session_approvals:
                                approval_status = 'session'
                            else:
                                # Request approval
                                approval = await request_approval(
                                    tool_spec or {'name': tool_name, 'description': 'Unknown tool'},
                                    tool_input,
                                    blast_radius,
                                    conversation_id or "unknown",
                                    on_event
                                )

                                if not approval.granted:
                                    # Approval denied
                                    approval_status = 'denied'
                                    duration_ms = int((time.time() - start_time) * 1000)

                                    # Create error result
                                    result = {
                                        "ok": False,
                                        "error": {
                                            "code": "approval_denied",
                                            "message": "User denied approval for this operation",
                                            "hint": f"This {blast_radius}-risk operation requires approval"
                                        },
                                        "meta": {}
                                    }

                                    # Log denial
                                    if tool_spec:
                                        endpoint = tool_spec.get('endpoint', {})
                                        log_tool_call(
                                            conversation_id or "unknown",
                                            agent_def.get('id', 'unknown'),
                                            tool_spec.get('name', tool_name),
                                            endpoint.get('method', 'UNKNOWN'),
                                            endpoint.get('path', 'unknown'),
                                            tool_input,
                                            blast_radius,
                                            approval_status,
                                            result,
                                            duration_ms,
                                            db_conn
                                        )
                                else:
                                    approval_status = approval.mode

                        # Execute tool if not denied
                        if result is None:
                            # Check cache first to avoid redundant API calls
                            key = cache_key(tool_name, tool_input)
                            if key in tool_call_cache:
                                result = tool_call_cache[key]
                                # Log cache hit
                                print(f"[CACHE HIT] {tool_name} with {tool_input}")
                            else:
                                result = _execute_tool(
                                    tool_name=tool_name,
                                    tool_input=tool_input,
                                    catalog=catalog,
                                    client=meraki_client
                                )
                                # Cache successful results
                                if result.get("ok"):
                                    tool_call_cache[key] = result

                            # Calculate duration and log
                            duration_ms = int((time.time() - start_time) * 1000)

                            if tool_spec:
                                endpoint = tool_spec.get('endpoint', {})
                                log_tool_call(
                                    conversation_id or "unknown",
                                    agent_def.get('id', 'unknown'),
                                    tool_spec.get('name', tool_name),
                                    endpoint.get('method', 'UNKNOWN'),
                                    endpoint.get('path', 'unknown'),
                                    tool_input,
                                    blast_radius,
                                    approval_status,
                                    result,
                                    duration_ms,
                                    db_conn
                                )

                        # Emit tool result event
                        # Format result for display
                        if result.get("ok"):
                            result_str = json.dumps(result.get("data"), indent=2)
                        else:
                            error_info = result.get("error", {})
                            result_str = f"Error: {error_info.get('message', 'Unknown error')}"

                        on_event({
                            "type": "tool_result",
                            "success": result.get("ok", False),
                            "result": result_str
                        })

                        # Convert and add tool result
                        tool_result_msg = _convert_tool_result_for_provider(
                            tool_call_id,
                            tool_name,
                            result,
                            provider
                        )
                        tool_results.append(tool_result_msg)

                # Add tool results to conversation
                if provider == "anthropic":
                    # Anthropic: tool results go in a user message with content array
                    messages.append({"role": "user", "content": tool_results})
                else:
                    # OpenAI/vLLM: each tool result is its own message
                    messages.extend(tool_results)

                # Continue loop
                continue

            # Unexpected stop reason
            stop_reason = response.get("stop_reason", "unknown")
            on_event({
                "type": "error",
                "message": f"Unexpected stop reason: {stop_reason}",
                "hint": "This may indicate an LLM error or API change"
            })
            return

        # Max steps reached
        on_event({
            "type": "error",
            "message": f"Maximum steps ({MAX_STEPS}) reached",
            "hint": "Query may be too complex or agent is stuck in a loop"
        })

    except Exception as e:
        on_event({
            "type": "error",
            "message": f"ReACT loop failed: {str(e)}",
            "hint": "Check logs for detailed error information"
        })


def _convert_catalog_to_tools(catalog: List[dict], provider: str) -> List[dict]:
    """
    Convert Meraki tool catalog to provider-specific format.

    Anthropic format:
    {
        "name": "meraki_organizations_list_organizations",
        "description": "List all organizations",
        "input_schema": {
            "type": "object",
            "properties": {"orgId": {"type": "string", "description": "..."}},
            "required": ["orgId"]
        }
    }

    OpenAI/vLLM format:
    {
        "type": "function",
        "function": {
            "name": "meraki_organizations_list_organizations",
            "description": "List all organizations",
            "parameters": {
                "type": "object",
                "properties": {"orgId": {"type": "string", "description": "..."}},
                "required": ["orgId"]
            }
        }
    }

    Args:
        catalog: List of ToolSpec dicts
        provider: Provider name (anthropic, openai, vllm, etc.)

    Returns:
        List of tool definitions in appropriate format
    """
    tools = []

    for tool_spec in catalog:
        # Convert name (meraki.resource.action → meraki_resource_action)
        # Tool names can't have dots in most APIs
        tool_name = tool_spec["name"].replace(".", "_").replace("-", "_")

        if provider == "anthropic":
            # Anthropic format
            tool = {
                "name": tool_name,
                "description": tool_spec.get("description", ""),
                "input_schema": {
                    "type": "object",
                    "properties": tool_spec.get("args", {}),
                    "required": tool_spec.get("required", [])
                }
            }
        else:
            # OpenAI/vLLM format (also works for Google)
            tool = {
                "type": "function",
                "function": {
                    "name": tool_name,
                    "description": tool_spec.get("description", ""),
                    "parameters": {
                        "type": "object",
                        "properties": tool_spec.get("args", {}),
                        "required": tool_spec.get("required", [])
                    }
                }
            }

        tools.append(tool)

    return tools


def _initialize_meraki_client(vault_entry: Optional[str], vault_secrets: dict):
    """
    Initialize MerakiClient using vault secrets or environment variable.

    Args:
        vault_entry: Name of vault entry (e.g., "meraki_api_key")
        vault_secrets: Dict of secrets from vault envelope (e.g., {"api_key": "..."})

    Returns:
        MerakiClient instance
    """
    # Add terminai-meraki package to path if not already available
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

    # Initialize client
    if vault_secrets:
        # Try multiple key names (api_key, MERAKI_API_KEY, or any key containing "api")
        api_key = (
            vault_secrets.get("api_key") or
            vault_secrets.get("MERAKI_API_KEY") or
            vault_secrets.get("meraki_api_key") or
            # Fallback: use first secret if only one exists
            (list(vault_secrets.values())[0] if len(vault_secrets) == 1 else None)
        )
        if api_key:
            return MerakiClient(api_key=api_key)

    # Fallback: try from_vault factory (will check environment variables)
    if vault_entry:
        return MerakiClient.from_vault(vault_entry)

    # Final fallback: environment variable
    return MerakiClient.from_env()


def _find_tool_spec(catalog: List[dict], tool_name: str) -> Optional[dict]:
    """
    Find tool specification in catalog by Claude tool name.

    Args:
        catalog: List of ToolSpec dicts
        tool_name: Claude tool name (e.g., "meraki_organizations_list_organizations")

    Returns:
        ToolSpec dict or None if not found
    """
    # Convert Claude name back to catalog name
    # meraki_organizations_list_organizations → meraki.organizations.list-organizations
    parts = tool_name.split("_")
    if len(parts) >= 3:
        # Reconstruct with dots and hyphens
        # This is a heuristic; exact mapping depends on action name format
        resource = parts[1]  # "organizations"
        action_parts = parts[2:]  # ["list", "organizations"]
        action = "-".join(action_parts)
        catalog_name = f"meraki.{resource}.{action}"

        for spec in catalog:
            if spec["name"] == catalog_name:
                return spec

    # Fallback: try direct match
    for spec in catalog:
        if spec["name"].replace(".", "_").replace("-", "_") == tool_name:
            return spec

    return None


def _execute_tool(
    tool_name: str,
    tool_input: dict,
    catalog: List[dict],
    client,
) -> Dict[str, Any]:
    """
    Execute a tool call against Meraki API.

    Args:
        tool_name: Claude tool name (e.g., "meraki_organizations_list_organizations")
        tool_input: Tool input parameters from LLM
        catalog: Full tool catalog
        client: MerakiClient instance

    Returns:
        Envelope dict: {"ok": bool, "data"/"error": ..., "meta": ...}
    """
    try:
        # Find tool spec
        tool_spec = _find_tool_spec(catalog, tool_name)
        if not tool_spec:
            return {
                "ok": False,
                "error": {
                    "code": "tool_not_found",
                    "message": f"Tool '{tool_name}' not found in catalog",
                    "hint": "This may be an LLM hallucination or catalog mismatch"
                }
            }

        # Extract resource and action
        resource = tool_spec["resource"]
        action = tool_spec["action"]

        # Call Meraki API
        result = client.call(resource, action, **tool_input)

        return result

    except Exception as e:
        return {
            "ok": False,
            "error": {
                "code": "tool_execution_error",
                "message": str(e),
                "hint": "Check tool parameters and API connectivity"
            },
            "meta": {}
        }

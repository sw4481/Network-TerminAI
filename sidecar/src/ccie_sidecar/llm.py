"""
Thin async wrapper around provider-specific LLM calls.

Provides a unified async interface for the code execution loop
and other async callers that need LLM tool-calling support.
"""

from __future__ import annotations

import asyncio
import os
from typing import Any, Optional


async def call_llm(
    provider: str,
    model: str,
    messages: list[dict[str, Any]],
    tools: Optional[list[dict[str, Any]]] = None,
    system_prompt: Optional[str] = None,
    api_key: Optional[str] = None,
    base_url: Optional[str] = None,
    max_tokens: int = 4096,
) -> dict[str, Any]:
    """
    Async LLM call with optional tool support.

    Delegates to the appropriate provider module (anthropic, openai, vllm).
    Runs the synchronous provider call in a thread executor to avoid blocking.

    Args:
        provider: Provider name ("anthropic", "openai", "nvidia", "vllm")
        model: Model identifier
        messages: Conversation messages
        tools: Optional list of tool definitions
        system_prompt: Optional system prompt
        api_key: API key (falls back to env vars)
        base_url: Base URL for vLLM/ollama endpoints
        max_tokens: Maximum tokens to generate

    Returns:
        Unified response dict:
        {
            "stop_reason": "end_turn" | "tool_use" | "error",
            "content": [{"type": "text"|"tool_use", ...}],
            "error": "..." (only if stop_reason == "error")
        }
    """
    # Resolve API key from environment if not provided
    if not api_key:
        if provider == "anthropic":
            api_key = os.getenv("ANTHROPIC_API_KEY")
        elif provider == "openai":
            api_key = os.getenv("OPENAI_API_KEY")
        elif provider == "nvidia":
            api_key = os.getenv("NVIDIA_API_KEY")

    loop = asyncio.get_event_loop()

    if provider == "anthropic":
        from ccie_sidecar.providers.anthropic import call_with_tools

        if not api_key:
            return {"stop_reason": "error", "error": "Anthropic API key not configured"}

        if tools:
            return await loop.run_in_executor(
                None,
                lambda: call_with_tools(
                    api_key=api_key,
                    model=model,
                    messages=messages,
                    tools=tools,
                    max_tokens=max_tokens,
                    system=system_prompt,
                ),
            )
        else:
            # No tools - still use call_with_tools with empty list
            # The provider handles this gracefully
            return await loop.run_in_executor(
                None,
                lambda: call_with_tools(
                    api_key=api_key,
                    model=model,
                    messages=messages,
                    tools=[],
                    max_tokens=max_tokens,
                    system=system_prompt,
                ),
            )

    elif provider == "openai":
        from ccie_sidecar.providers.openai import call_with_tools

        if not api_key:
            return {"stop_reason": "error", "error": "OpenAI API key not configured"}

        return await loop.run_in_executor(
            None,
            lambda: call_with_tools(
                api_key=api_key,
                model=model,
                messages=messages,
                tools=tools or [],
                system=system_prompt,
            ),
        )

    elif provider == "nvidia":
        from ccie_sidecar.providers.nvidia import call_with_tools

        if not api_key:
            return {"stop_reason": "error", "error": "NVIDIA API key not configured"}

        return await loop.run_in_executor(
            None,
            lambda: call_with_tools(
                api_key=api_key,
                model=model,
                messages=messages,
                tools=tools or [],
                system=system_prompt,
            ),
        )

    elif provider == "vllm":
        from ccie_sidecar.providers.vllm import call_with_tools

        endpoint = base_url or os.getenv("VLLM_ENDPOINT", "http://localhost:8000")
        if not endpoint.rstrip("/").endswith("/v1"):
            endpoint = endpoint.rstrip("/") + "/v1"

        # Prepend system message for OpenAI-compatible API
        vllm_messages = list(messages)
        if system_prompt:
            vllm_messages = [{"role": "system", "content": system_prompt}] + vllm_messages

        return await loop.run_in_executor(
            None,
            lambda: call_with_tools(
                endpoint=endpoint,
                model=model,
                messages=vllm_messages,
                tools=tools or [],
                api_key=api_key,
            ),
        )

    else:
        return {
            "stop_reason": "error",
            "error": f"Unsupported provider for async call_llm: {provider}",
        }

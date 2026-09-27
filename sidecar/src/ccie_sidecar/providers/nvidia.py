"""NVIDIA provider adapter for CCIE Terminal."""
from __future__ import annotations

import json
from typing import Any, Iterator

from openai import OpenAI, AuthenticationError, RateLimitError, APIError


NVIDIA_BASE_URL = "https://integrate.api.nvidia.com/v1"

# Per-request timeout (seconds). A healthy gpt-oss-120b turn is 30-60s, but a
# down endpoint accepts the socket and never responds. Cap so callers get a
# clean error well below the heartbeat/agent budgets (Python 540s < Rust 600s
# < bridge 720s) rather than an infinite hang. Applies to streaming AND
# tool-call paths, which previously had no timeout at all.
REQUEST_TIMEOUT_S = 120

# The OpenAI SDK retries twice by default, which multiplies the timeout by 3x
# (a dead endpoint would burn 360s before failing) and never recovers — a down
# model stays down. One retry covers a transient network blip; a hung endpoint
# still fails fast at ~2x the timeout.
MAX_RETRIES = 1

SUPPORTED_MODELS = {
    "llama-3.3-70b": "meta/llama-3.3-70b-instruct",
    "nemotron-340b": "nvidia/nemotron-4-340b-instruct",
    "mixtral-8x7b": "mistralai/mixtral-8x7b-instruct-v0.1",
}


def stream_chat(
    api_key: str,
    model: str,
    messages: list[dict[str, Any]],
    max_tokens: int = 4096,
    system: str | None = None,
    base_url: str | None = None,
) -> Iterator[dict[str, Any]]:
    """
    Stream a chat completion from NVIDIA's API or OpenAI-compatible endpoint.

    Args:
        api_key: NVIDIA API key from build.nvidia.com or OpenAI-compatible API key
        model: Model identifier (e.g., "meta/llama-3.3-70b-instruct" or "openai/gpt-oss-120b")
        messages: List of message dicts with "role" and "content"
        max_tokens: Maximum tokens to generate
        system: Optional system prompt (will be prepended to messages)
        base_url: Optional base URL (defaults to NVIDIA's hosted API)

    Yields:
        Dicts with {"type": "token", "data": "..."} for tokens
        or {"type": "error", "message": "..."} for errors
    """
    try:
        # Use provided base_url or default to NVIDIA's hosted API
        effective_base_url = base_url or NVIDIA_BASE_URL
        # timeout so a dead/hung model endpoint (NVIDIA sometimes lists a model
        # in /models whose inference endpoint is down and never responds — the
        # connection is accepted but no bytes come back) surfaces as an error
        # the caller can retry/report instead of wedging the single-threaded
        # sidecar (and every heartbeat/agent) forever.
        client = OpenAI(
            api_key=api_key, base_url=effective_base_url, timeout=REQUEST_TIMEOUT_S, max_retries=MAX_RETRIES
        )

        # Map friendly model name to actual API model name
        api_model = SUPPORTED_MODELS.get(model, model)

        # Prepend system message if provided
        api_messages = messages
        if system:
            api_messages = [{"role": "system", "content": system}] + messages

        stream = client.chat.completions.create(
            model=api_model,
            messages=api_messages,
            max_tokens=max_tokens,
            stream=True,
        )

        for chunk in stream:
            if chunk.choices and len(chunk.choices) > 0:
                delta = chunk.choices[0].delta
                if delta.content:
                    yield {"type": "token", "data": delta.content}

    except AuthenticationError as e:
        yield {"type": "error", "message": f"Authentication failed (401): {e}"}
    except RateLimitError as e:
        yield {"type": "error", "message": f"Rate limit exceeded (429): {e}"}
    except APIError as e:
        yield {"type": "error", "message": f"API error: {e}"}
    except Exception as e:
        yield {"type": "error", "message": f"Unexpected error: {e}"}


def complete(
    api_key: str,
    model: str,
    messages: list[dict[str, Any]],
    max_tokens: int = 1024,
    system: str | None = None,
    base_url: str | None = None,
) -> str:
    """
    Get a non-streaming completion from NVIDIA's API or OpenAI-compatible endpoint.

    Args:
        api_key: NVIDIA API key from build.nvidia.com or OpenAI-compatible API key
        model: Model identifier
        messages: List of message dicts with "role" and "content"
        max_tokens: Maximum tokens to generate
        system: Optional system prompt
        base_url: Optional base URL (defaults to NVIDIA's hosted API)

    Returns:
        The complete response text

    Raises:
        Exception: If API call fails (AuthenticationError, RateLimitError, APIError, etc.)
    """
    # Use provided base_url or default to NVIDIA's hosted API
    effective_base_url = base_url or NVIDIA_BASE_URL
    client = OpenAI(
        api_key=api_key, base_url=effective_base_url, timeout=REQUEST_TIMEOUT_S, max_retries=MAX_RETRIES
    )

    # Map friendly model name to actual API model name
    api_model = SUPPORTED_MODELS.get(model, model)

    # Prepend system message if provided
    api_messages = messages
    if system:
        api_messages = [{"role": "system", "content": system}] + messages

    # timeout so a stalled connection surfaces as an error the caller
    # can handle/retry instead of hanging the single-threaded sidecar
    # forever. gpt-oss-120b genuinely takes 30-60s, so we leave headroom.
    response = client.chat.completions.create(
        model=api_model,
        messages=api_messages,
        max_tokens=max_tokens,
        timeout=REQUEST_TIMEOUT_S,
    )

    # Extract text from response
    if response.choices and len(response.choices) > 0:
        return response.choices[0].message.content or ""

    return ""


def call_with_tools(
    api_key: str,
    model: str,
    messages: list[dict[str, Any]],
    tools: list[dict[str, Any]],
    max_tokens: int = 16384,
    system: str | None = None,
    base_url: str | None = None,
) -> dict[str, Any]:
    """
    Call NVIDIA API or OpenAI-compatible endpoint with tool support (non-streaming).

    Args:
        api_key: NVIDIA API key or OpenAI-compatible API key
        model: Model identifier
        messages: List of message dicts
        tools: List of tool definitions in OpenAI format
        max_tokens: Maximum tokens to generate
        system: Optional system prompt
        base_url: Optional base URL (defaults to NVIDIA's hosted API)

    Returns:
        Response dict compatible with ReACT loop format
    """
    try:
        # Use provided base_url or default to NVIDIA's hosted API
        effective_base_url = base_url or NVIDIA_BASE_URL
        client = OpenAI(
            api_key=api_key, base_url=effective_base_url, timeout=REQUEST_TIMEOUT_S, max_retries=MAX_RETRIES
        )
        api_model = SUPPORTED_MODELS.get(model, model)

        # Prepend system message if provided
        api_messages = messages
        if system:
            api_messages = [{"role": "system", "content": system}] + messages

        request_params: dict[str, Any] = {
            "model": api_model,
            "max_tokens": max_tokens,
            "messages": api_messages,
        }

        # Only add tools if the list is non-empty
        if tools:
            request_params["tools"] = tools

        response = client.chat.completions.create(**request_params)

        # Build content blocks
        choice = response.choices[0] if response.choices else None
        if not choice:
            return {"stop_reason": "error", "error": "No response from model"}

        content_blocks = []
        if choice.message.content:
            content_blocks.append({"type": "text", "text": choice.message.content})

        # Handle tool calls if present
        if choice.message.tool_calls:
            for tool_call in choice.message.tool_calls:
                raw_args = tool_call.function.arguments
                try:
                    arguments = json.loads(raw_args)
                except json.JSONDecodeError as e:
                    # gpt-oss-120b (and other OSS models) frequently emit tool
                    # arguments that aren't strict JSON — most often a multi-line
                    # `code` payload with unescaped quotes/newlines. Rather than
                    # kill the whole turn, best-effort repair the arguments.
                    from ccie_sidecar.providers.tool_json import repair_tool_arguments

                    arguments = repair_tool_arguments(raw_args)
                    if arguments is None:
                        # Log the raw payload so this is diagnosable, then fail.
                        import sys
                        print(
                            f"[nvidia] unrepairable tool-call JSON ({e}); "
                            f"raw arguments = {raw_args!r}",
                            file=sys.stderr, flush=True,
                        )
                        return {
                            "stop_reason": "error",
                            "error": f"Invalid tool call JSON from model: {e}",
                        }
                    import sys
                    print(
                        f"[nvidia] repaired malformed tool-call JSON ({e})",
                        file=sys.stderr, flush=True,
                    )

                content_blocks.append({
                    "type": "tool_use",
                    "id": tool_call.id,
                    "name": tool_call.function.name,
                    "input": arguments,
                })

        # Map finish_reason to stop_reason (match OpenAI provider pattern)
        stop_reason_map = {
            "stop": "end_turn",
            "tool_calls": "tool_use",
            "length": "max_tokens",
        }
        stop_reason = stop_reason_map.get(choice.finish_reason, choice.finish_reason or "stop")

        return {
            "stop_reason": stop_reason,
            "content": content_blocks,
        }

    except AuthenticationError as e:
        return {"stop_reason": "error", "error": f"Authentication failed: {e}"}
    except RateLimitError as e:
        return {"stop_reason": "error", "error": f"Rate limit exceeded: {e}"}
    except APIError as e:
        return {"stop_reason": "error", "error": f"API error: {e}"}
    except Exception as e:
        return {"stop_reason": "error", "error": f"Unexpected error: {e}"}

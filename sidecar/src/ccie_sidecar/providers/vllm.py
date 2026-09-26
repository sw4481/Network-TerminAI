"""vLLM provider adapter for CCIE Terminal."""
from __future__ import annotations

from typing import Any, Iterator

from openai import OpenAI, APIConnectionError, AuthenticationError, APIError

# Timeout for vLLM requests to prevent indefinite hangs when the endpoint is
# unreachable (matches NVIDIA provider pattern). Without this, a dead/hung
# vLLM endpoint wedges the single-threaded sidecar forever.
REQUEST_TIMEOUT_S = 120


def stream_chat(
    endpoint: str,
    model: str,
    messages: list[dict[str, Any]],
    api_key: str | None = None,
    max_tokens: int = 4096,
) -> Iterator[dict[str, Any]]:
    """
    Stream a chat completion from vLLM's OpenAI-compatible API.

    Args:
        endpoint: vLLM server endpoint (e.g., "http://localhost:8000/v1")
        model: Model identifier (e.g., "meta-llama/Llama-3.3-70B-Instruct")
        messages: List of message dicts with "role" and "content"
        api_key: Optional API key (some vLLM deployments require it)
        max_tokens: Maximum tokens to generate

    Yields:
        Dicts with {"type": "token", "data": "..."} for tokens
        or {"type": "error", "message": "..."} for errors
    """
    try:
        # vLLM uses OpenAI-compatible API
        client = OpenAI(
            base_url=endpoint,
            api_key=api_key or "EMPTY",  # vLLM defaults to "EMPTY" if no auth
            timeout=REQUEST_TIMEOUT_S,
        )

        stream = client.chat.completions.create(
            model=model,
            messages=messages,
            max_tokens=max_tokens,
            stream=True,
        )

        for chunk in stream:
            if chunk.choices and len(chunk.choices) > 0:
                delta = chunk.choices[0].delta
                if delta.content:
                    yield {"type": "token", "data": delta.content}

    except APIConnectionError as e:
        yield {
            "type": "error",
            "message": f"Connection failed: vLLM server not reachable at {endpoint}. {e}"
        }
    except AuthenticationError as e:
        yield {"type": "error", "message": f"Authentication failed (401): {e}"}
    except APIError as e:
        yield {"type": "error", "message": f"API error: {e}"}
    except Exception as e:
        yield {"type": "error", "message": f"Unexpected error: {e}"}


def complete(
    endpoint: str,
    model: str,
    messages: list[dict[str, Any]],
    api_key: str | None = None,
    max_tokens: int = 1024,
) -> str:
    """
    Get a non-streaming completion from vLLM's OpenAI-compatible API.

    Args:
        endpoint: vLLM server endpoint (e.g., "http://localhost:8000/v1")
        model: Model identifier (e.g., "meta-llama/Llama-3.3-70B-Instruct")
        messages: List of message dicts with "role" and "content"
        api_key: Optional API key (some vLLM deployments require it)
        max_tokens: Maximum tokens to generate

    Returns:
        The complete response text

    Raises:
        APIConnectionError, AuthenticationError, APIError, or Exception
    """
    # vLLM uses OpenAI-compatible API
    client = OpenAI(
        base_url=endpoint,
        api_key=api_key or "EMPTY",  # vLLM defaults to "EMPTY" if no auth
        timeout=REQUEST_TIMEOUT_S,
    )

    response = client.chat.completions.create(
        model=model,
        messages=messages,
        max_tokens=max_tokens,
        stream=False,
    )

    if response.choices and len(response.choices) > 0:
        return response.choices[0].message.content or ""

    return ""


def call_with_tools(
    endpoint: str,
    model: str,
    messages: list[dict[str, Any]],
    tools: list[dict[str, Any]],
    api_key: str | None = None,
    max_tokens: int = 4096,
) -> dict[str, Any]:
    """
    Call vLLM API with tool support (non-streaming).

    vLLM uses OpenAI-compatible API format including tool calling.

    Args:
        endpoint: vLLM server endpoint
        model: Model identifier
        messages: List of message dicts
        tools: List of tool definitions in OpenAI format
        api_key: Optional API key
        max_tokens: Maximum tokens to generate

    Returns:
        Response dict with content, tool_calls, stop_reason, etc.
    """
    try:
        client = OpenAI(
            base_url=endpoint,
            api_key=api_key or "EMPTY",
            timeout=REQUEST_TIMEOUT_S,
        )

        response = client.chat.completions.create(
            model=model,
            messages=messages,
            tools=tools,
            max_tokens=max_tokens,
        )

        if not response.choices or len(response.choices) == 0:
            return {
                "stop_reason": "error",
                "content": [],
                "error": "No response from model"
            }

        choice = response.choices[0]
        message = choice.message

        # Build content blocks
        content_blocks = []
        if message.content:
            content_blocks.append({"type": "text", "text": message.content})

        if message.tool_calls:
            for tool_call in message.tool_calls:
                import json
                content_blocks.append({
                    "type": "tool_use",
                    "id": tool_call.id,
                    "name": tool_call.function.name,
                    "input": json.loads(tool_call.function.arguments),
                })

        # Map finish_reason to stop_reason
        stop_reason_map = {
            "stop": "end_turn",
            "tool_calls": "tool_use",
            "length": "max_tokens",
        }
        stop_reason = stop_reason_map.get(choice.finish_reason, choice.finish_reason)

        return {
            "stop_reason": stop_reason,
            "content": content_blocks,
        }

    except APIConnectionError as e:
        return {"stop_reason": "error", "error": f"Connection failed: {e}"}
    except AuthenticationError as e:
        return {"stop_reason": "error", "error": f"Authentication failed: {e}"}
    except APIError as e:
        return {"stop_reason": "error", "error": f"API error: {e}"}
    except Exception as e:
        return {"stop_reason": "error", "error": f"Unexpected error: {e}"}

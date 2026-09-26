"""Anthropic provider adapter for CCIE Terminal."""
from __future__ import annotations

from typing import Any, Iterator

from anthropic import Anthropic, AuthenticationError, RateLimitError, APIError


# Anthropic's Models API returns model IDs that are directly accepted by the
# Messages API.  Do not rewrite those live IDs to historical snapshot names:
# a model chosen in Settings must be sent exactly as Anthropic advertised it.
SUPPORTED_MODELS: dict[str, str] = {}


def stream_chat(
    api_key: str,
    model: str,
    messages: list[dict[str, Any]],
    max_tokens: int = 4096,
    system: str | None = None,
) -> Iterator[dict[str, Any]]:
    """
    Stream a chat completion from Anthropic's API.

    Args:
        api_key: Anthropic API key
        model: Model identifier (e.g., "claude-sonnet-4-6")
        messages: List of message dicts with "role" and "content"
        max_tokens: Maximum tokens to generate
        system: Optional system prompt

    Yields:
        Dicts with {"type": "token", "data": "..."} for tokens
        or {"type": "error", "message": "..."} for errors
    """
    try:
        client = Anthropic(api_key=api_key)

        # Map friendly model name to actual API model name
        api_model = SUPPORTED_MODELS.get(model, model)

        # Build request parameters
        request_params: dict[str, Any] = {
            "model": api_model,
            "max_tokens": max_tokens,
            "messages": messages,
        }

        if system:
            request_params["system"] = system

        with client.messages.stream(**request_params) as stream:
            for event in stream:
                if event.type == "content_block_delta":
                    if hasattr(event.delta, "text"):
                        yield {"type": "token", "data": event.delta.text}

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
) -> str:
    """
    Get a non-streaming completion from Anthropic's API.

    Args:
        api_key: Anthropic API key
        model: Model identifier (e.g., "claude-sonnet-4-6")
        messages: List of message dicts with "role" and "content"
        max_tokens: Maximum tokens to generate
        system: Optional system prompt

    Returns:
        The complete response text

    Raises:
        AuthenticationError, RateLimitError, APIError, or Exception
    """
    client = Anthropic(api_key=api_key)

    # Map friendly model name to actual API model name
    api_model = SUPPORTED_MODELS.get(model, model)

    # Build request parameters
    request_params: dict[str, Any] = {
        "model": api_model,
        "max_tokens": max_tokens,
        "messages": messages,
    }

    if system:
        request_params["system"] = system

    response = client.messages.create(**request_params)

    # Extract text from response
    text_parts = []
    for block in response.content:
        if hasattr(block, "text"):
            text_parts.append(block.text)

    return "".join(text_parts)


def call_with_tools(
    api_key: str,
    model: str,
    messages: list[dict[str, Any]],
    tools: list[dict[str, Any]],
    max_tokens: int = 16384,
    system: str | None = None,
) -> dict[str, Any]:
    """
    Call Anthropic API with tool support (non-streaming).

    Args:
        api_key: Anthropic API key
        model: Model identifier
        messages: List of message dicts
        tools: List of tool definitions in Anthropic format
        max_tokens: Maximum tokens to generate
        system: Optional system prompt

    Returns:
        Response dict compatible with ReACT loop format
    """
    try:
        client = Anthropic(api_key=api_key)
        api_model = SUPPORTED_MODELS.get(model, model)

        request_params: dict[str, Any] = {
            "model": api_model,
            "max_tokens": max_tokens,
            "messages": messages,
        }

        # Only add tools if the list is non-empty
        if tools:
            request_params["tools"] = tools

        if system:
            request_params["system"] = system

        response = client.messages.create(**request_params)

        # Build content blocks
        content_blocks = []
        for block in response.content:
            if hasattr(block, "text"):
                content_blocks.append({"type": "text", "text": block.text})
            elif block.type == "tool_use":
                content_blocks.append({
                    "type": "tool_use",
                    "id": block.id,
                    "name": block.name,
                    "input": block.input,
                })

        return {
            "stop_reason": response.stop_reason,
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

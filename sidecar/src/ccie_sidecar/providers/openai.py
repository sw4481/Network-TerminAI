"""OpenAI provider adapter for CCIE Terminal."""
from __future__ import annotations

from typing import Any, Iterator

from openai import OpenAI, AuthenticationError, RateLimitError, APIError


SUPPORTED_MODELS = {
    "gpt-4o": "gpt-4o",
    "gpt-4-turbo": "gpt-4-turbo",
    "gpt-3.5-turbo": "gpt-3.5-turbo",
}


def stream_chat(
    api_key: str,
    model: str,
    messages: list[dict[str, Any]],
    max_tokens: int = 4096,
    system: str | None = None,
) -> Iterator[dict[str, Any]]:
    """
    Stream a chat completion from OpenAI's API.

    Args:
        api_key: OpenAI API key
        model: Model identifier (e.g., "gpt-4o", "gpt-4-turbo", "gpt-3.5-turbo")
        messages: List of message dicts with "role" and "content"
        max_tokens: Maximum tokens to generate
        system: Optional system prompt (will be prepended to messages)

    Yields:
        Dicts with {"type": "token", "data": "..."} for tokens
        or {"type": "error", "message": "..."} for errors
    """
    try:
        client = OpenAI(api_key=api_key)

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
) -> str:
    """
    Get a non-streaming completion from OpenAI's API.

    Args:
        api_key: OpenAI API key
        model: Model identifier (e.g., "gpt-4o", "gpt-4-turbo", "gpt-3.5-turbo")
        messages: List of message dicts with "role" and "content"
        max_tokens: Maximum tokens to generate

    Returns:
        The complete response text

    Raises:
        AuthenticationError, RateLimitError, APIError, or Exception
    """
    client = OpenAI(api_key=api_key)

    # Map friendly model name to actual API model name
    api_model = SUPPORTED_MODELS.get(model, model)

    response = client.chat.completions.create(
        model=api_model,
        messages=messages,
        max_tokens=max_tokens,
        stream=False,
    )

    if response.choices and len(response.choices) > 0:
        return response.choices[0].message.content or ""

    return ""


def call_with_tools(
    api_key: str,
    model: str,
    messages: list[dict[str, Any]],
    tools: list[dict[str, Any]],
    max_tokens: int = 4096,
    system: str | None = None,
) -> dict[str, Any]:
    """
    Call OpenAI API with tool support (non-streaming).

    Args:
        api_key: OpenAI API key
        model: Model identifier
        messages: List of message dicts
        tools: List of tool definitions in OpenAI format
        max_tokens: Maximum tokens to generate
        system: Optional system prompt

    Returns:
        Response dict with content, tool_calls, stop_reason, etc.
    """
    try:
        client = OpenAI(api_key=api_key)
        api_model = SUPPORTED_MODELS.get(model, model)

        # Prepend system message if provided
        api_messages = messages
        if system:
            api_messages = [{"role": "system", "content": system}] + messages

        response = client.chat.completions.create(
            model=api_model,
            messages=api_messages,
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

    except AuthenticationError as e:
        return {"stop_reason": "error", "error": f"Authentication failed: {e}"}
    except RateLimitError as e:
        return {"stop_reason": "error", "error": f"Rate limit exceeded: {e}"}
    except APIError as e:
        return {"stop_reason": "error", "error": f"API error: {e}"}
    except Exception as e:
        return {"stop_reason": "error", "error": f"Unexpected error: {e}"}

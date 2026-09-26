"""Google Gemini provider adapter for CCIE Terminal.

Uses the modern `google-genai` SDK (the older `google-generativeai` package is
end-of-life and pins protobuf <6, which conflicts with other sidecar deps).
"""
from __future__ import annotations

from typing import Any, Iterator

from google import genai
from google.genai import types
from google.genai import errors as genai_errors


SUPPORTED_MODELS = {
    "gemini-2.0-flash": "gemini-2.0-flash-exp",
    "gemini-1.5-pro": "gemini-1.5-pro",
    "gemini-1.5-flash": "gemini-1.5-flash",
}


def stream_chat(
    api_key: str,
    model: str,
    messages: list[dict[str, Any]],
    max_tokens: int = 4096,
) -> Iterator[dict[str, Any]]:
    """
    Stream a chat completion from Google's Gemini API.

    Args:
        api_key: Google API key
        model: Model identifier (e.g., "gemini-2.0-flash")
        messages: List of message dicts with "role" and "content"
        max_tokens: Maximum tokens to generate

    Yields:
        Dicts with {"type": "token", "data": "..."} for tokens
        or {"type": "error", "message": "..."} for errors
    """
    try:
        client = genai.Client(api_key=api_key)

        # Map friendly model name to actual API model name
        api_model = SUPPORTED_MODELS.get(model, model)

        # Convert messages from Anthropic/OpenAI format to Gemini format.
        # Gemini uses "user" and "model" (not "assistant").
        contents = []
        for msg in messages:
            role = "model" if msg["role"] == "assistant" else msg["role"]
            contents.append({"role": role, "parts": [{"text": msg["content"]}]})

        config = types.GenerateContentConfig(max_output_tokens=max_tokens)

        for chunk in client.models.generate_content_stream(
            model=api_model,
            contents=contents,
            config=config,
        ):
            if chunk.text:
                yield {"type": "token", "data": chunk.text}

    except genai_errors.ClientError as e:
        # 4xx — includes auth (401/403) and rate-limit (429).
        yield {"type": "error", "message": f"API error ({getattr(e, 'code', '4xx')}): {e}"}
    except genai_errors.APIError as e:
        yield {"type": "error", "message": f"API error: {e}"}
    except Exception as e:
        yield {"type": "error", "message": f"Unexpected error: {e}"}

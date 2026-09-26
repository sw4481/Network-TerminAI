"""Ollama provider adapter for CCIE Terminal."""
from __future__ import annotations

from typing import Any, Iterator

try:
    import ollama
except ImportError:
    ollama = None


SUPPORTED_MODELS = {
    "llama3.3": "llama3.3",
    "codellama": "codellama",
    "mistral": "mistral",
}


def stream_chat(
    host: str,
    model: str,
    messages: list[dict[str, Any]],
) -> Iterator[dict[str, Any]]:
    """
    Stream a chat completion from Ollama.

    Args:
        host: Ollama host URL (e.g., "http://localhost:11434")
        model: Model identifier (e.g., "llama3.3", "codellama", "mistral")
        messages: List of message dicts with "role" and "content"

    Yields:
        Dicts with {"type": "token", "data": "..."} for tokens
        or {"type": "error", "message": "..."} for errors
    """
    if ollama is None:
        yield {
            "type": "error",
            "message": "Ollama Python SDK not installed. Install with: pip install ollama"
        }
        return

    try:
        # Map friendly model name to actual model name
        api_model = SUPPORTED_MODELS.get(model, model)

        # Create client with custom host
        client = ollama.Client(host=host)

        # Stream from Ollama
        stream = client.chat(
            model=api_model,
            messages=messages,
            stream=True,
        )

        for chunk in stream:
            # Extract the message content from the chunk
            if "message" in chunk and "content" in chunk["message"]:
                content = chunk["message"]["content"]
                if content:  # Only yield non-empty content
                    yield {"type": "token", "data": content}

    except ConnectionError as e:
        yield {
            "type": "error",
            "message": f"Failed to connect to Ollama at {host}. Is Ollama running? Error: {e}"
        }
    except Exception as e:
        # Handle other errors (model not found, etc.)
        error_msg = str(e)
        if "not found" in error_msg.lower():
            yield {
                "type": "error",
                "message": f"Model '{model}' not found. Pull it with: ollama pull {api_model}"
            }
        else:
            yield {
                "type": "error",
                "message": f"Ollama error: {e}"
            }

"""Tests for Google Gemini provider adapter (google-genai SDK)."""
import os
from unittest.mock import MagicMock, patch

import pytest


@pytest.fixture
def mock_client():
    """Mock google.genai.Client so no network/auth is needed.

    Yields the client instance mock; configure
    `client.models.generate_content_stream.return_value` per test.
    """
    with patch("ccie_sidecar.providers.google.genai.Client") as mock_ctor:
        instance = MagicMock()
        mock_ctor.return_value = instance
        yield instance


def _chunk(text):
    c = MagicMock()
    c.text = text
    return c


def test_stream_chat_yields_tokens_as_ndjson(mock_client):
    from ccie_sidecar.providers.google import stream_chat

    mock_client.models.generate_content_stream.return_value = iter(
        [_chunk("Hello"), _chunk(" world")]
    )

    messages = [{"role": "user", "content": "test"}]
    results = list(stream_chat(api_key="test-key", model="gemini-2.0-flash", messages=messages))

    assert results == [
        {"type": "token", "data": "Hello"},
        {"type": "token", "data": " world"},
    ]


def test_stream_chat_handles_client_error(mock_client):
    """4xx (auth / rate-limit) surface as an error event."""
    from google.genai import errors as genai_errors
    from ccie_sidecar.providers.google import stream_chat

    # ClientError requires a code + response; fake a minimal 401.
    resp = MagicMock()
    resp.json = {"error": {"message": "Invalid API key"}}
    mock_client.models.generate_content_stream.side_effect = genai_errors.ClientError(
        401, {"error": {"message": "Invalid API key"}}, resp
    )

    messages = [{"role": "user", "content": "test"}]
    results = list(stream_chat(api_key="bad-key", model="gemini-2.0-flash", messages=messages))

    assert len(results) == 1
    assert results[0]["type"] == "error"


def test_stream_chat_supports_all_models(mock_client):
    from ccie_sidecar.providers.google import stream_chat

    mock_client.models.generate_content_stream.return_value = iter([])

    messages = [{"role": "user", "content": "test"}]
    for model in ["gemini-2.0-flash", "gemini-1.5-pro", "gemini-1.5-flash"]:
        list(stream_chat(api_key="test-key", model=model, messages=messages))
        assert mock_client.models.generate_content_stream.called


def test_stream_chat_converts_message_format(mock_client):
    """Anthropic/OpenAI roles → Gemini roles (assistant → model)."""
    from ccie_sidecar.providers.google import stream_chat

    mock_client.models.generate_content_stream.return_value = iter([])

    messages = [
        {"role": "user", "content": "Hello"},
        {"role": "assistant", "content": "Hi there!"},
        {"role": "user", "content": "How are you?"},
    ]
    list(stream_chat(api_key="test-key", model="gemini-2.0-flash", messages=messages))

    kwargs = mock_client.models.generate_content_stream.call_args.kwargs
    contents = kwargs["contents"]
    assert len(contents) == 3
    assert contents[0]["role"] == "user"
    assert contents[1]["role"] == "model"  # converted from assistant
    assert contents[2]["role"] == "user"
    assert contents[0]["parts"][0]["text"] == "Hello"


def test_stream_chat_handles_empty_chunks(mock_client):
    from ccie_sidecar.providers.google import stream_chat

    mock_client.models.generate_content_stream.return_value = iter(
        [_chunk("Hello"), _chunk(None), _chunk(" world")]
    )

    messages = [{"role": "user", "content": "test"}]
    results = list(stream_chat(api_key="test-key", model="gemini-2.0-flash", messages=messages))

    assert results == [
        {"type": "token", "data": "Hello"},
        {"type": "token", "data": " world"},
    ]


@pytest.mark.skipif(
    not os.getenv("GOOGLE_API_KEY"),
    reason="GOOGLE_API_KEY not set",
)
def test_real_google_stream():
    """Integration test with real Google Gemini API (if key is set)."""
    from ccie_sidecar.providers.google import stream_chat

    api_key = os.getenv("GOOGLE_API_KEY")
    messages = [{"role": "user", "content": "Say 'Hello' and nothing else."}]

    results = list(stream_chat(api_key=api_key, model="gemini-2.0-flash", messages=messages))

    assert len(results) > 0
    assert all(r["type"] == "token" for r in results)
    full_text = "".join(r["data"] for r in results)
    assert "hello" in full_text.lower()

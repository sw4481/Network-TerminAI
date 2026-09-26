"""Tests for OpenAI provider adapter."""
import json
import os
from unittest.mock import MagicMock, patch

import pytest


@pytest.fixture
def mock_openai_client():
    """Mock the OpenAI client."""
    with patch("ccie_sidecar.providers.openai.OpenAI") as mock_client:
        yield mock_client


def test_stream_chat_yields_tokens_as_ndjson(mock_openai_client):
    """Test that stream_chat yields tokens in NDJSON format."""
    from ccie_sidecar.providers.openai import stream_chat

    # Mock streaming response
    mock_chunk1 = MagicMock()
    mock_chunk1.choices = [MagicMock()]
    mock_chunk1.choices[0].delta.content = "Hello"

    mock_chunk2 = MagicMock()
    mock_chunk2.choices = [MagicMock()]
    mock_chunk2.choices[0].delta.content = " world"

    mock_client_instance = MagicMock()
    mock_client_instance.chat.completions.create.return_value = iter([mock_chunk1, mock_chunk2])
    mock_openai_client.return_value = mock_client_instance

    messages = [{"role": "user", "content": "test"}]
    results = list(stream_chat(api_key="test-key", model="gpt-4o", messages=messages))

    assert len(results) == 2
    assert results[0] == {"type": "token", "data": "Hello"}
    assert results[1] == {"type": "token", "data": " world"}


def test_stream_chat_handles_401_error(mock_openai_client):
    """Test that stream_chat handles 401 authentication errors."""
    from openai import AuthenticationError
    from ccie_sidecar.providers.openai import stream_chat

    mock_client_instance = MagicMock()
    mock_client_instance.chat.completions.create.side_effect = AuthenticationError(
        message="Invalid API key",
        response=MagicMock(status_code=401),
        body={"error": {"message": "Invalid API key"}}
    )
    mock_openai_client.return_value = mock_client_instance

    messages = [{"role": "user", "content": "test"}]
    results = list(stream_chat(api_key="bad-key", model="gpt-4o", messages=messages))

    assert len(results) == 1
    assert results[0]["type"] == "error"
    assert "authentication" in results[0]["message"].lower() or "401" in results[0]["message"]


def test_stream_chat_handles_429_rate_limit(mock_openai_client):
    """Test that stream_chat handles 429 rate limit errors."""
    from openai import RateLimitError
    from ccie_sidecar.providers.openai import stream_chat

    mock_client_instance = MagicMock()
    mock_client_instance.chat.completions.create.side_effect = RateLimitError(
        message="Rate limit exceeded",
        response=MagicMock(status_code=429),
        body={"error": {"message": "Rate limit exceeded"}}
    )
    mock_openai_client.return_value = mock_client_instance

    messages = [{"role": "user", "content": "test"}]
    results = list(stream_chat(api_key="test-key", model="gpt-4o", messages=messages))

    assert len(results) == 1
    assert results[0]["type"] == "error"
    assert "rate limit" in results[0]["message"].lower() or "429" in results[0]["message"]


def test_stream_chat_supports_all_models(mock_openai_client):
    """Test that stream_chat supports all required models."""
    from ccie_sidecar.providers.openai import stream_chat

    mock_client_instance = MagicMock()
    mock_client_instance.chat.completions.create.return_value = iter([])
    mock_openai_client.return_value = mock_client_instance

    messages = [{"role": "user", "content": "test"}]
    models = ["gpt-4o", "gpt-4-turbo", "gpt-3.5-turbo"]

    for model in models:
        list(stream_chat(api_key="test-key", model=model, messages=messages))
        assert mock_client_instance.chat.completions.create.called


def test_stream_chat_handles_empty_chunks(mock_openai_client):
    """Test that stream_chat handles chunks with no content gracefully."""
    from ccie_sidecar.providers.openai import stream_chat

    # Mock streaming response with empty chunks
    mock_chunk1 = MagicMock()
    mock_chunk1.choices = [MagicMock()]
    mock_chunk1.choices[0].delta.content = None

    mock_chunk2 = MagicMock()
    mock_chunk2.choices = [MagicMock()]
    mock_chunk2.choices[0].delta.content = "Hello"

    mock_chunk3 = MagicMock()
    mock_chunk3.choices = []

    mock_client_instance = MagicMock()
    mock_client_instance.chat.completions.create.return_value = iter([mock_chunk1, mock_chunk2, mock_chunk3])
    mock_openai_client.return_value = mock_client_instance

    messages = [{"role": "user", "content": "test"}]
    results = list(stream_chat(api_key="test-key", model="gpt-4o", messages=messages))

    # Should only yield the chunk with actual content
    assert len(results) == 1
    assert results[0] == {"type": "token", "data": "Hello"}


def test_stream_chat_handles_api_error(mock_openai_client):
    """Test that stream_chat handles general API errors."""
    from openai import APIError
    from ccie_sidecar.providers.openai import stream_chat

    mock_client_instance = MagicMock()
    mock_client_instance.chat.completions.create.side_effect = APIError(
        message="Server error",
        request=MagicMock(),
        body={"error": {"message": "Server error"}}
    )
    mock_openai_client.return_value = mock_client_instance

    messages = [{"role": "user", "content": "test"}]
    results = list(stream_chat(api_key="test-key", model="gpt-4o", messages=messages))

    assert len(results) == 1
    assert results[0]["type"] == "error"
    assert "api error" in results[0]["message"].lower()


@pytest.mark.skipif(
    not os.getenv("OPENAI_API_KEY"),
    reason="OPENAI_API_KEY not set"
)
def test_real_openai_stream():
    """Integration test with real OpenAI API (if key is set)."""
    from ccie_sidecar.providers.openai import stream_chat

    api_key = os.getenv("OPENAI_API_KEY")
    messages = [{"role": "user", "content": "Say 'Hello' and nothing else."}]

    results = list(stream_chat(api_key=api_key, model="gpt-3.5-turbo", messages=messages))

    # Should receive at least one token
    assert len(results) > 0
    # All results should be tokens (no errors)
    assert all(r["type"] == "token" for r in results)
    # Combined tokens should contain "Hello"
    full_text = "".join(r["data"] for r in results)
    assert "Hello" in full_text or "hello" in full_text.lower()

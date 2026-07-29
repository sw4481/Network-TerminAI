"""Tests for Anthropic provider adapter."""
import json
import os
from unittest.mock import MagicMock, patch

import pytest


@pytest.fixture
def mock_anthropic_client():
    """Mock the Anthropic client."""
    with patch("ccie_sidecar.providers.anthropic.Anthropic") as mock_client:
        yield mock_client


def test_stream_chat_yields_tokens_as_ndjson(mock_anthropic_client):
    """Test that stream_chat yields tokens in NDJSON format."""
    from ccie_sidecar.providers.anthropic import stream_chat

    # Mock streaming response
    mock_stream = MagicMock()
    mock_stream.__enter__ = MagicMock(return_value=mock_stream)
    mock_stream.__exit__ = MagicMock(return_value=False)

    # Simulate text delta events
    mock_text_event1 = MagicMock()
    mock_text_event1.type = "content_block_delta"
    mock_text_event1.delta.type = "text_delta"
    mock_text_event1.delta.text = "Hello"

    mock_text_event2 = MagicMock()
    mock_text_event2.type = "content_block_delta"
    mock_text_event2.delta.type = "text_delta"
    mock_text_event2.delta.text = " world"

    mock_stream.__iter__ = MagicMock(return_value=iter([mock_text_event1, mock_text_event2]))

    mock_client_instance = MagicMock()
    mock_client_instance.messages.stream.return_value = mock_stream
    mock_anthropic_client.return_value = mock_client_instance

    messages = [{"role": "user", "content": "test"}]
    results = list(stream_chat(api_key="test-key", model="claude-sonnet-4-6", messages=messages))

    assert len(results) == 2
    assert results[0] == {"type": "token", "data": "Hello"}
    assert results[1] == {"type": "token", "data": " world"}


def test_stream_chat_handles_401_error(mock_anthropic_client):
    """Test that stream_chat handles 401 authentication errors."""
    from anthropic import AuthenticationError
    from ccie_sidecar.providers.anthropic import stream_chat

    # Create a proper mock response
    mock_response = MagicMock()
    mock_response.status_code = 401

    mock_client_instance = MagicMock()
    mock_client_instance.messages.stream.side_effect = AuthenticationError(
        "Invalid API key",
        response=mock_response,
        body={"error": {"message": "Invalid API key"}}
    )
    mock_anthropic_client.return_value = mock_client_instance

    messages = [{"role": "user", "content": "test"}]
    results = list(stream_chat(api_key="bad-key", model="claude-sonnet-4-6", messages=messages))

    assert len(results) == 1
    assert results[0]["type"] == "error"
    assert "authentication" in results[0]["message"].lower() or "401" in results[0]["message"]


def test_stream_chat_handles_429_rate_limit(mock_anthropic_client):
    """Test that stream_chat handles 429 rate limit errors."""
    from anthropic import RateLimitError
    from ccie_sidecar.providers.anthropic import stream_chat

    # Create a proper mock response
    mock_response = MagicMock()
    mock_response.status_code = 429

    mock_client_instance = MagicMock()
    mock_client_instance.messages.stream.side_effect = RateLimitError(
        "Rate limit exceeded",
        response=mock_response,
        body={"error": {"message": "Rate limit exceeded"}}
    )
    mock_anthropic_client.return_value = mock_client_instance

    messages = [{"role": "user", "content": "test"}]
    results = list(stream_chat(api_key="test-key", model="claude-sonnet-4-6", messages=messages))

    assert len(results) == 1
    assert results[0]["type"] == "error"
    assert "rate limit" in results[0]["message"].lower() or "429" in results[0]["message"]


def test_stream_chat_supports_all_models(mock_anthropic_client):
    """Test that stream_chat supports all required models."""
    from ccie_sidecar.providers.anthropic import stream_chat

    mock_stream = MagicMock()
    mock_stream.__enter__ = MagicMock(return_value=mock_stream)
    mock_stream.__exit__ = MagicMock(return_value=False)
    mock_stream.__iter__ = MagicMock(return_value=iter([]))

    mock_client_instance = MagicMock()
    mock_client_instance.messages.stream.return_value = mock_stream
    mock_anthropic_client.return_value = mock_client_instance

    messages = [{"role": "user", "content": "test"}]
    models = ["claude-sonnet-4-6", "claude-opus-4-7", "claude-haiku-4-5"]

    for model in models:
        list(stream_chat(api_key="test-key", model=model, messages=messages))
        assert mock_client_instance.messages.stream.called


@pytest.mark.skipif(
    not os.getenv("ANTHROPIC_API_KEY"),
    reason="ANTHROPIC_API_KEY not set"
)
def test_real_anthropic_stream():
    """Integration test with real Anthropic API (if key is set)."""
    from ccie_sidecar.providers.anthropic import stream_chat

    api_key = os.getenv("ANTHROPIC_API_KEY")
    messages = [{"role": "user", "content": "Say 'Hello' and nothing else."}]

    results = list(stream_chat(api_key=api_key, model="claude-sonnet-4-6", messages=messages))

    # Should receive at least one token
    assert len(results) > 0
    # All results should be tokens (no errors)
    assert all(r["type"] == "token" for r in results)
    # Combined tokens should contain "Hello"
    full_text = "".join(r["data"] for r in results)
    assert "Hello" in full_text or "hello" in full_text.lower()

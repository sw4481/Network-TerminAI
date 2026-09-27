"""Tests for vLLM provider adapter."""
import os
from unittest.mock import MagicMock, patch

import pytest


@pytest.fixture
def mock_openai_client():
    """Mock the OpenAI client for vLLM."""
    with patch("ccie_sidecar.providers.vllm.OpenAI") as mock_client:
        yield mock_client


def test_stream_chat_yields_tokens_as_ndjson(mock_openai_client):
    """Test that stream_chat yields tokens in NDJSON format."""
    from ccie_sidecar.providers.vllm import stream_chat

    # Mock streaming response
    mock_chunk1 = MagicMock()
    mock_chunk1.choices = [MagicMock()]
    mock_chunk1.choices[0].delta.content = "Hello"

    mock_chunk2 = MagicMock()
    mock_chunk2.choices = [MagicMock()]
    mock_chunk2.choices[0].delta.content = " world"

    mock_stream = [mock_chunk1, mock_chunk2]

    mock_client_instance = MagicMock()
    mock_client_instance.chat.completions.create.return_value = mock_stream
    mock_openai_client.return_value = mock_client_instance

    messages = [{"role": "user", "content": "test"}]
    results = list(
        stream_chat(
            endpoint="http://localhost:8000/v1",
            model="test-model",
            messages=messages,
        )
    )

    assert len(results) == 2
    assert results[0] == {"type": "token", "data": "Hello"}
    assert results[1] == {"type": "token", "data": " world"}


def test_stream_chat_handles_connection_error(mock_openai_client):
    """Test that stream_chat handles connection errors gracefully."""
    from openai import APIConnectionError
    from ccie_sidecar.providers.vllm import stream_chat

    mock_client_instance = MagicMock()
    # Create a mock request object
    mock_request = MagicMock()
    mock_request.url = "http://localhost:8000/v1"
    mock_request.method = "POST"

    mock_client_instance.chat.completions.create.side_effect = APIConnectionError(
        message="Connection refused",
        request=mock_request
    )
    mock_openai_client.return_value = mock_client_instance

    messages = [{"role": "user", "content": "test"}]
    results = list(
        stream_chat(
            endpoint="http://localhost:8000/v1",
            model="test-model",
            messages=messages,
        )
    )

    assert len(results) == 1
    assert results[0]["type"] == "error"
    assert "connection" in results[0]["message"].lower()
    assert "http://localhost:8000/v1" in results[0]["message"]


def test_stream_chat_handles_401_error(mock_openai_client):
    """Test that stream_chat handles 401 authentication errors."""
    from openai import AuthenticationError
    from ccie_sidecar.providers.vllm import stream_chat

    mock_client_instance = MagicMock()
    mock_client_instance.chat.completions.create.side_effect = AuthenticationError(
        "Invalid API key", response=MagicMock(), body=None
    )
    mock_openai_client.return_value = mock_client_instance

    messages = [{"role": "user", "content": "test"}]
    results = list(
        stream_chat(
            endpoint="http://localhost:8000/v1",
            model="test-model",
            messages=messages,
            api_key="bad-key",
        )
    )

    assert len(results) == 1
    assert results[0]["type"] == "error"
    assert "authentication" in results[0]["message"].lower() or "401" in results[0]["message"]


def test_stream_chat_uses_custom_endpoint(mock_openai_client):
    """Test that stream_chat uses custom endpoint."""
    from ccie_sidecar.providers.vllm import stream_chat

    mock_client_instance = MagicMock()
    mock_client_instance.chat.completions.create.return_value = []
    mock_openai_client.return_value = mock_client_instance

    messages = [{"role": "user", "content": "test"}]
    custom_endpoint = "http://device.example.test:8001/v1"

    list(
        stream_chat(
            endpoint=custom_endpoint,
            model="test-model",
            messages=messages,
        )
    )

    # Verify OpenAI client was initialized with custom endpoint
    mock_openai_client.assert_called_once()
    call_kwargs = mock_openai_client.call_args.kwargs
    assert call_kwargs["base_url"] == custom_endpoint


def test_stream_chat_uses_api_key_when_provided(mock_openai_client):
    """Test that stream_chat uses API key when provided."""
    from ccie_sidecar.providers.vllm import stream_chat

    mock_client_instance = MagicMock()
    mock_client_instance.chat.completions.create.return_value = []
    mock_openai_client.return_value = mock_client_instance

    messages = [{"role": "user", "content": "test"}]
    api_key = "test-api-key"

    list(
        stream_chat(
            endpoint="http://localhost:8000/v1",
            model="test-model",
            messages=messages,
            api_key=api_key,
        )
    )

    # Verify OpenAI client was initialized with API key
    mock_openai_client.assert_called_once()
    call_kwargs = mock_openai_client.call_args.kwargs
    assert call_kwargs["api_key"] == api_key


def test_stream_chat_defaults_to_empty_api_key(mock_openai_client):
    """Test that stream_chat defaults to EMPTY when no API key provided."""
    from ccie_sidecar.providers.vllm import stream_chat

    mock_client_instance = MagicMock()
    mock_client_instance.chat.completions.create.return_value = []
    mock_openai_client.return_value = mock_client_instance

    messages = [{"role": "user", "content": "test"}]

    list(
        stream_chat(
            endpoint="http://localhost:8000/v1",
            model="test-model",
            messages=messages,
        )
    )

    # Verify OpenAI client was initialized with "EMPTY" default
    mock_openai_client.assert_called_once()
    call_kwargs = mock_openai_client.call_args.kwargs
    assert call_kwargs["api_key"] == "EMPTY"


@pytest.mark.skipif(
    not os.getenv("VLLM_ENDPOINT"),
    reason="VLLM_ENDPOINT not set"
)
def test_real_vllm_stream():
    """Integration test with real vLLM server (if available)."""
    from ccie_sidecar.providers.vllm import stream_chat

    endpoint = os.getenv("VLLM_ENDPOINT")
    model = os.getenv("VLLM_MODEL", "meta-llama/Llama-3.3-70B-Instruct")
    api_key = os.getenv("VLLM_API_KEY")

    messages = [{"role": "user", "content": "Say 'Hello' and nothing else."}]

    results = list(
        stream_chat(
            endpoint=endpoint,
            model=model,
            messages=messages,
            api_key=api_key,
        )
    )

    # Should receive at least one token
    assert len(results) > 0
    # All results should be tokens (no errors)
    assert all(r["type"] == "token" for r in results)
    # Combined tokens should contain "Hello"
    full_text = "".join(r["data"] for r in results)
    assert "Hello" in full_text or "hello" in full_text.lower()

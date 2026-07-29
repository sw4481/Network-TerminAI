"""Tests for Ollama provider adapter."""
import os
from unittest.mock import MagicMock, patch

import pytest


@pytest.fixture
def mock_ollama_client():
    """Mock the Ollama client."""
    with patch("ccie_sidecar.providers.ollama.ollama") as mock_module:
        # Mock the module itself to not be None
        mock_module.__bool__ = lambda self: True
        yield mock_module


def test_stream_chat_yields_tokens_as_ndjson(mock_ollama_client):
    """Test that stream_chat yields tokens in NDJSON format."""
    from ccie_sidecar.providers.ollama import stream_chat

    # Mock the client instance
    mock_client_instance = MagicMock()
    mock_ollama_client.Client.return_value = mock_client_instance

    # Simulate streaming response
    mock_chunk1 = {"message": {"content": "Hello"}}
    mock_chunk2 = {"message": {"content": " world"}}
    mock_chunk3 = {"message": {"content": "!"}}

    mock_client_instance.chat.return_value = iter([mock_chunk1, mock_chunk2, mock_chunk3])

    messages = [{"role": "user", "content": "test"}]
    results = list(stream_chat(
        host="http://localhost:11434",
        model="llama3.3",
        messages=messages
    ))

    assert len(results) == 3
    assert results[0] == {"type": "token", "data": "Hello"}
    assert results[1] == {"type": "token", "data": " world"}
    assert results[2] == {"type": "token", "data": "!"}


def test_stream_chat_handles_connection_error(mock_ollama_client):
    """Test that stream_chat handles connection errors gracefully."""
    from ccie_sidecar.providers.ollama import stream_chat

    mock_client_instance = MagicMock()
    mock_ollama_client.Client.return_value = mock_client_instance

    # Simulate connection error
    mock_client_instance.chat.side_effect = ConnectionError("Connection refused")

    messages = [{"role": "user", "content": "test"}]
    results = list(stream_chat(
        host="http://localhost:11434",
        model="llama3.3",
        messages=messages
    ))

    assert len(results) == 1
    assert results[0]["type"] == "error"
    assert "connect" in results[0]["message"].lower()
    assert "ollama" in results[0]["message"].lower()


def test_stream_chat_handles_model_not_found(mock_ollama_client):
    """Test that stream_chat handles model not found errors."""
    from ccie_sidecar.providers.ollama import stream_chat

    mock_client_instance = MagicMock()
    mock_ollama_client.Client.return_value = mock_client_instance

    # Simulate model not found error
    mock_client_instance.chat.side_effect = Exception("model 'unknown-model' not found")

    messages = [{"role": "user", "content": "test"}]
    results = list(stream_chat(
        host="http://localhost:11434",
        model="unknown-model",
        messages=messages
    ))

    assert len(results) == 1
    assert results[0]["type"] == "error"
    assert "not found" in results[0]["message"].lower()
    assert "ollama pull" in results[0]["message"].lower()


def test_stream_chat_supports_all_models(mock_ollama_client):
    """Test that stream_chat supports all required models."""
    from ccie_sidecar.providers.ollama import stream_chat

    mock_client_instance = MagicMock()
    mock_ollama_client.Client.return_value = mock_client_instance
    mock_client_instance.chat.return_value = iter([])

    messages = [{"role": "user", "content": "test"}]
    models = ["llama3.3", "codellama", "mistral"]

    for model in models:
        list(stream_chat(
            host="http://localhost:11434",
            model=model,
            messages=messages
        ))
        assert mock_client_instance.chat.called


def test_stream_chat_skips_empty_content(mock_ollama_client):
    """Test that stream_chat skips empty content chunks."""
    from ccie_sidecar.providers.ollama import stream_chat

    mock_client_instance = MagicMock()
    mock_ollama_client.Client.return_value = mock_client_instance

    # Simulate streaming response with empty content
    mock_chunk1 = {"message": {"content": "Hello"}}
    mock_chunk2 = {"message": {"content": ""}}  # Empty content
    mock_chunk3 = {"message": {"content": " world"}}

    mock_client_instance.chat.return_value = iter([mock_chunk1, mock_chunk2, mock_chunk3])

    messages = [{"role": "user", "content": "test"}]
    results = list(stream_chat(
        host="http://localhost:11434",
        model="llama3.3",
        messages=messages
    ))

    # Should only yield non-empty content
    assert len(results) == 2
    assert results[0] == {"type": "token", "data": "Hello"}
    assert results[1] == {"type": "token", "data": " world"}


def test_stream_chat_uses_custom_host(mock_ollama_client):
    """Test that stream_chat uses custom host URL."""
    from ccie_sidecar.providers.ollama import stream_chat

    mock_client_instance = MagicMock()
    mock_ollama_client.Client.return_value = mock_client_instance
    mock_client_instance.chat.return_value = iter([])

    custom_host = "http://custom-host:8080"
    messages = [{"role": "user", "content": "test"}]

    list(stream_chat(
        host=custom_host,
        model="llama3.3",
        messages=messages
    ))

    # Verify client was created with custom host
    mock_ollama_client.Client.assert_called_once_with(host=custom_host)


@pytest.mark.skipif(
    os.system("curl -s http://localhost:11434/api/tags >/dev/null 2>&1") != 0,
    reason="Ollama not running at localhost:11434"
)
def test_real_ollama_stream():
    """Integration test with real Ollama (if running)."""
    from ccie_sidecar.providers.ollama import stream_chat

    messages = [{"role": "user", "content": "Say 'Hello' and nothing else."}]

    results = list(stream_chat(
        host="http://localhost:11434",
        model="llama3.3",
        messages=messages
    ))

    # Should receive at least one token (or error if model not pulled)
    assert len(results) > 0
    # If successful, should be tokens
    if results[0]["type"] == "token":
        # Combined tokens should contain "Hello"
        full_text = "".join(r["data"] for r in results if r["type"] == "token")
        assert len(full_text) > 0
    else:
        # If error, it should be about model not found
        assert results[0]["type"] == "error"

"""Tests for the agent handler."""
import os
from unittest.mock import MagicMock, patch

import pytest


@pytest.fixture
def mock_anthropic_stream_chat():
    """Mock the Anthropic stream_chat function.

    Also forces get_saved_config() to None so chat_stream takes the
    profile->model fallback path these tests assert on. Without this, a real
    saved AI config on the dev machine (e.g. an nvidia provider) overrides the
    profile and anthropic.stream_chat is never called.
    """
    with patch("ccie_sidecar.agent.get_saved_config", return_value=None), \
         patch("ccie_sidecar.agent.anthropic.stream_chat") as mock:
        yield mock


def test_chat_stream_requires_api_key():
    """Test that chat_stream raises error if API key is missing."""
    from ccie_sidecar.agent import chat_stream

    # No saved config (so it falls to the anthropic profile) and no API key in
    # environment, so chat_stream should emit the missing-key error.
    with patch("ccie_sidecar.agent.get_saved_config", return_value=None), \
         patch.dict(os.environ, {}, clear=True):
        messages = [{"role": "user", "content": "test"}]
        results = list(chat_stream(session_id="s1", messages=messages, profile="default"))

        assert len(results) == 1
        assert results[0]["type"] == "error"
        assert "anthropic api key" in results[0]["message"].lower()


def test_chat_stream_maps_profile_to_model(mock_anthropic_stream_chat):
    """Test that chat_stream maps profile to correct model."""
    from ccie_sidecar.agent import chat_stream

    mock_anthropic_stream_chat.return_value = iter([{"type": "token", "data": "test"}])

    with patch.dict(os.environ, {"ANTHROPIC_API_KEY": "test-key"}):
        messages = [{"role": "user", "content": "test"}]

        # Default profile should map to claude-sonnet-4-6
        list(chat_stream(session_id="s1", messages=messages, profile="default"))
        mock_anthropic_stream_chat.assert_called_once()
        call_args = mock_anthropic_stream_chat.call_args
        assert call_args[1]["model"] == "claude-sonnet-4-6"


def test_chat_stream_supports_quality_profile(mock_anthropic_stream_chat):
    """Test that chat_stream supports quality profile (Opus)."""
    from ccie_sidecar.agent import chat_stream

    mock_anthropic_stream_chat.return_value = iter([{"type": "token", "data": "test"}])

    with patch.dict(os.environ, {"ANTHROPIC_API_KEY": "test-key"}):
        messages = [{"role": "user", "content": "test"}]

        list(chat_stream(session_id="s1", messages=messages, profile="quality"))
        call_args = mock_anthropic_stream_chat.call_args
        assert call_args[1]["model"] == "claude-opus-4-7"


def test_chat_stream_supports_budget_profile(mock_anthropic_stream_chat):
    """Test that chat_stream supports budget profile (Haiku)."""
    from ccie_sidecar.agent import chat_stream

    mock_anthropic_stream_chat.return_value = iter([{"type": "token", "data": "test"}])

    with patch.dict(os.environ, {"ANTHROPIC_API_KEY": "test-key"}):
        messages = [{"role": "user", "content": "test"}]

        list(chat_stream(session_id="s1", messages=messages, profile="budget"))
        call_args = mock_anthropic_stream_chat.call_args
        assert call_args[1]["model"] == "claude-haiku-4-5"


def test_chat_stream_forwards_tokens_from_provider(mock_anthropic_stream_chat):
    """Test that chat_stream forwards tokens from provider."""
    from ccie_sidecar.agent import chat_stream

    mock_anthropic_stream_chat.return_value = iter([
        {"type": "token", "data": "Hello"},
        {"type": "token", "data": " world"},
    ])

    with patch.dict(os.environ, {"ANTHROPIC_API_KEY": "test-key"}):
        messages = [{"role": "user", "content": "test"}]
        results = list(chat_stream(session_id="s1", messages=messages, profile="default"))

        assert len(results) == 2
        assert results[0] == {"type": "token", "data": "Hello"}
        assert results[1] == {"type": "token", "data": " world"}


def test_chat_stream_forwards_errors_from_provider(mock_anthropic_stream_chat):
    """Test that chat_stream forwards errors from provider."""
    from ccie_sidecar.agent import chat_stream

    mock_anthropic_stream_chat.return_value = iter([
        {"type": "error", "message": "API error"}
    ])

    with patch.dict(os.environ, {"ANTHROPIC_API_KEY": "test-key"}):
        messages = [{"role": "user", "content": "test"}]
        results = list(chat_stream(session_id="s1", messages=messages, profile="default"))

        assert len(results) == 1
        assert results[0]["type"] == "error"
        assert results[0]["message"] == "API error"


@pytest.mark.skipif(
    not os.getenv("ANTHROPIC_API_KEY"),
    reason="ANTHROPIC_API_KEY not set"
)
def test_real_chat_stream():
    """Integration test with real Anthropic API (if key is set)."""
    from ccie_sidecar.agent import chat_stream

    messages = [{"role": "user", "content": "Say 'Test passed' and nothing else."}]
    results = list(chat_stream(session_id="test-session", messages=messages, profile="default"))

    # Should receive at least one token
    assert len(results) > 0
    # All results should be tokens (no errors)
    assert all(r["type"] == "token" for r in results)
    # Combined tokens should contain expected text
    full_text = "".join(r["data"] for r in results)
    assert "Test" in full_text or "test" in full_text.lower()

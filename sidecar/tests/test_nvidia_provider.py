"""Real integration tests for NVIDIA provider."""
import os
from unittest.mock import MagicMock, patch

import pytest


@pytest.fixture
def nvidia_api_key():
    """Get NVIDIA API key from environment."""
    key = os.environ.get("NVIDIA_API_KEY")
    if not key:
        pytest.skip("NVIDIA_API_KEY not set")
    return key


@pytest.fixture
def test_model():
    """Default test model."""
    return "meta/llama-3.3-70b-instruct"


def test_stream_chat_real(nvidia_api_key, test_model):
    """Test streaming chat with real NVIDIA API."""
    from ccie_sidecar.providers import nvidia

    messages = [{"role": "user", "content": "Say hello in one word"}]

    tokens = []
    errors = []

    for event in nvidia.stream_chat(
        api_key=nvidia_api_key,
        model=test_model,
        messages=messages,
        max_tokens=50,
    ):
        if event["type"] == "token":
            tokens.append(event["data"])
        elif event["type"] == "error":
            errors.append(event["message"])

    assert len(errors) == 0, f"Stream had errors: {errors}"
    assert len(tokens) > 0, "No tokens received"

    full_response = "".join(tokens)
    assert len(full_response) > 0, "Empty response"


def test_complete_real(nvidia_api_key, test_model):
    """Test non-streaming completion with real NVIDIA API."""
    from ccie_sidecar.providers import nvidia

    messages = [{"role": "user", "content": "Respond with just the word 'test'"}]

    response = nvidia.complete(
        api_key=nvidia_api_key,
        model=test_model,
        messages=messages,
        max_tokens=10,
    )

    assert isinstance(response, str)
    assert len(response) > 0


def test_system_prompt_real(nvidia_api_key, test_model):
    """Test system prompt handling."""
    from ccie_sidecar.providers import nvidia

    messages = [{"role": "user", "content": "What is your role?"}]
    system = "You are a helpful assistant named TestBot."

    response = nvidia.complete(
        api_key=nvidia_api_key,
        model=test_model,
        messages=messages,
        max_tokens=50,
        system=system,
    )

    assert isinstance(response, str)
    assert len(response) > 0


def test_call_with_tools_real(nvidia_api_key, test_model):
    """Test tool calling with real NVIDIA API (if supported)."""
    from ccie_sidecar.providers import nvidia

    messages = [{"role": "user", "content": "What's the weather in San Francisco?"}]

    tools = [
        {
            "type": "function",
            "function": {
                "name": "get_weather",
                "description": "Get current weather for a location",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "location": {"type": "string", "description": "City name"},
                    },
                    "required": ["location"],
                },
            },
        }
    ]

    response = nvidia.call_with_tools(
        api_key=nvidia_api_key,
        model=test_model,
        messages=messages,
        tools=tools,
        max_tokens=100,
    )

    # Should either call the tool or respond with text
    assert "stop_reason" in response
    assert response["stop_reason"] != "error"
    assert "content" in response
    assert len(response["content"]) > 0


def test_invalid_api_key():
    """Test error handling with invalid API key."""
    from openai import AuthenticationError
    from ccie_sidecar.providers import nvidia

    mock_client = MagicMock()
    mock_client.chat.completions.create.side_effect = AuthenticationError(
        message="Invalid API key",
        response=MagicMock(status_code=401),
        body={"error": {"message": "Invalid API key"}},
    )
    messages = [{"role": "user", "content": "test"}]

    with patch("ccie_sidecar.providers.nvidia.OpenAI", return_value=mock_client):
        errors = []
        for event in nvidia.stream_chat(
            api_key="invalid_key",
            model="meta/llama-3.3-70b-instruct",
            messages=messages,
        ):
            if event["type"] == "error":
                errors.append(event["message"])

    assert len(errors) > 0
    assert "401" in errors[0] or "Authentication" in errors[0]


def test_invalid_model(nvidia_api_key):
    """Test error handling with non-existent model."""
    from ccie_sidecar.providers import nvidia

    messages = [{"role": "user", "content": "test"}]

    errors = []
    for event in nvidia.stream_chat(
        api_key=nvidia_api_key,
        model="nonexistent/model",
        messages=messages,
    ):
        if event["type"] == "error":
            errors.append(event["message"])

    # Should get an error about invalid model
    assert len(errors) > 0

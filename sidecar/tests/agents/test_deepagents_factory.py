"""Unit tests for langchain_factory.py — provider parity (Seam 1)."""
import os
import pytest
from unittest.mock import patch

from langchain_anthropic import ChatAnthropic
from langchain_openai import ChatOpenAI
from langchain_google_genai import ChatGoogleGenerativeAI
from langchain_ollama import ChatOllama

from ccie_sidecar.providers.langchain_factory import build_chat_model


# Parametrized tests for all 5 providers
@pytest.mark.parametrize(
    "provider,model,expected_class,expected_model",
    [
        # Anthropic - current IDs are returned live by its Models API and
        # must be forwarded unchanged.
        ("anthropic", "claude-sonnet-4-6", ChatAnthropic, "claude-sonnet-4-6"),
        ("anthropic", "claude-opus-4-7", ChatAnthropic, "claude-opus-4-7"),
        ("anthropic", "claude-haiku-4-5", ChatAnthropic, "claude-haiku-4-5"),
        # Anthropic - passthrough for any other valid model ID
        ("anthropic", "claude-3-opus-20240229", ChatAnthropic, "claude-3-opus-20240229"),

        # OpenAI - alias resolution
        ("openai", "gpt-4o", ChatOpenAI, "gpt-4o"),
        ("openai", "gpt-4-turbo", ChatOpenAI, "gpt-4-turbo"),
        ("openai", "gpt-3.5-turbo", ChatOpenAI, "gpt-3.5-turbo"),

        # Google - alias resolution
        ("google", "gemini-2.0-flash", ChatGoogleGenerativeAI, "gemini-2.0-flash-exp"),
        ("google", "gemini-1.5-pro", ChatGoogleGenerativeAI, "gemini-1.5-pro"),
        ("google", "gemini-1.5-flash", ChatGoogleGenerativeAI, "gemini-1.5-flash"),

        # Ollama - alias resolution
        ("ollama", "llama3.3", ChatOllama, "llama3.3"),
        ("ollama", "codellama", ChatOllama, "codellama"),
        ("ollama", "mistral", ChatOllama, "mistral"),

        # NVIDIA - alias resolution
        ("nvidia", "llama-3.3-70b", ChatOpenAI, "meta/llama-3.3-70b-instruct"),
        ("nvidia", "nemotron-340b", ChatOpenAI, "nvidia/nemotron-4-340b-instruct"),
        ("nvidia", "mixtral-8x7b", ChatOpenAI, "mistralai/mixtral-8x7b-instruct-v0.1"),
    ],
)
def test_provider_model_alias_resolution(provider, model, expected_class, expected_model):
    """Test that each provider correctly resolves friendly model names to API model names."""
    config = {
        "provider": provider,
        "model": model,
        "api_key": "test-key-12345",
    }

    chat_model = build_chat_model(config)

    # Assert correct LangChain class
    assert isinstance(chat_model, expected_class), f"Expected {expected_class}, got {type(chat_model)}"

    # Assert correct model name after alias resolution
    # Different LangChain models use different attribute names
    actual_model = getattr(chat_model, 'model_name', None) or getattr(chat_model, 'model', None)
    assert actual_model == expected_model, \
        f"Expected model {expected_model}, got {actual_model}"


def test_vllm_base_url_normalization():
    """Test that vllm provider normalizes base_url to include /v1 suffix."""
    config = {
        "provider": "vllm",
        "model": "gpt-4o",
        "api_key": "fake-key",
        "base_url": "http://localhost:8000",
    }

    chat_model = build_chat_model(config)

    assert isinstance(chat_model, ChatOpenAI)
    # LangChain ChatOpenAI stores base_url in openai_api_base
    assert chat_model.openai_api_base == "http://localhost:8000/v1"


def test_anthropic_uses_the_saved_api_key():
    """DeepAgents must pass the persisted credential to ChatAnthropic.

    Guard the actual client field and endpoint so a Settings-tested key is the
    one sent to Anthropic, not an inherited local proxy left over from another
    provider configuration.
    """
    chat_model = build_chat_model(
        {
            "provider": "anthropic",
            "model": "claude-sonnet-4-6",
            "api_key": "saved-anthropic-key",
        }
    )

    assert chat_model.anthropic_api_key.get_secret_value() == "saved-anthropic-key"
    assert chat_model.anthropic_api_url == "https://api.anthropic.com"


def test_vllm_base_url_already_has_v1():
    """Test that vllm doesn't double-add /v1 if already present."""
    config = {
        "provider": "vllm",
        "model": "gpt-4o",
        "api_key": "fake-key",
        "base_url": "http://localhost:8000/v1",
    }

    chat_model = build_chat_model(config)

    assert isinstance(chat_model, ChatOpenAI)
    assert chat_model.openai_api_base == "http://localhost:8000/v1"


def test_vllm_keyless_uses_placeholder_key():
    """A keyless vLLM/NIM server must still build a model.

    ChatOpenAI raises 'Missing credentials' before hitting the wire if no
    api_key is supplied. Self-hosted vLLM servers usually run keyless, so the
    factory falls back to a placeholder key (the server ignores it). Regression
    guard: without this, every keyless vLLM agent run dies at construction.
    """
    config = {
        "provider": "vllm",
        "model": "deepreinforce-ai/Ornith-1.0-35B-FP8",
        "base_url": "http://device.example.test:8888",
        # no api_key — the whole point of this test
    }

    chat_model = build_chat_model(config)

    assert isinstance(chat_model, ChatOpenAI)
    assert chat_model.openai_api_base == "http://device.example.test:8888/v1"
    # A non-empty key is present so construction doesn't raise.
    assert chat_model.openai_api_key.get_secret_value() == "EMPTY"


def test_nvidia_default_base_url():
    """NVIDIA defaults to the hosted build.nvidia.com endpoint."""
    config = {"provider": "nvidia", "model": "llama-3.3-70b", "api_key": "fake-key"}

    chat_model = build_chat_model(config)

    assert isinstance(chat_model, ChatOpenAI)
    assert chat_model.openai_api_base == "https://integrate.api.nvidia.com/v1"


def test_nvidia_honors_local_base_url():
    """A configured base_url (local NIM) must override the cloud default."""
    config = {
        "provider": "nvidia",
        "model": "nvidia/nemotron-3-ultra-550b-a55b",
        "api_key": "fake-key",
        "base_url": "http://device.example.test:8888",
    }

    chat_model = build_chat_model(config)

    assert isinstance(chat_model, ChatOpenAI)
    # /v1 appended, cloud default dropped
    assert chat_model.openai_api_base == "http://device.example.test:8888/v1"


def test_ollama_default_base_url():
    """Test that ollama defaults to http://localhost:11434 when base_url not provided."""
    config = {
        "provider": "ollama",
        "model": "llama3.3",
    }

    chat_model = build_chat_model(config)

    assert isinstance(chat_model, ChatOllama)
    assert chat_model.base_url == "http://localhost:11434"


def test_ollama_custom_base_url():
    """Test that ollama respects custom base_url."""
    config = {
        "provider": "ollama",
        "model": "llama3.3",
        "base_url": "http://device.example.test:11434",
    }

    chat_model = build_chat_model(config)

    assert isinstance(chat_model, ChatOllama)
    assert chat_model.base_url == "http://device.example.test:11434"


def test_nvidia_uses_correct_base_url():
    """Test that NVIDIA provider uses build.nvidia.com endpoint."""
    config = {
        "provider": "nvidia",
        "model": "llama-3.3-70b",
        "api_key": "nvapi-test-key",
    }

    chat_model = build_chat_model(config)

    assert isinstance(chat_model, ChatOpenAI)
    assert chat_model.openai_api_base == "https://integrate.api.nvidia.com/v1"


@patch.dict(os.environ, {"ANTHROPIC_API_KEY": "env-anthropic-key"})
def test_env_var_fallback_anthropic():
    """Test that Anthropic falls back to ANTHROPIC_API_KEY env var."""
    config = {
        "provider": "anthropic",
        "model": "claude-sonnet-4-6",
        # No api_key in config
    }

    chat_model = build_chat_model(config)

    assert isinstance(chat_model, ChatAnthropic)
    assert chat_model.anthropic_api_key.get_secret_value() == "env-anthropic-key"


@patch.dict(os.environ, {"OPENAI_API_KEY": "env-openai-key"})
def test_env_var_fallback_openai():
    """Test that OpenAI falls back to OPENAI_API_KEY env var."""
    config = {
        "provider": "openai",
        "model": "gpt-4o",
        # No api_key in config
    }

    chat_model = build_chat_model(config)

    assert isinstance(chat_model, ChatOpenAI)
    assert chat_model.openai_api_key.get_secret_value() == "env-openai-key"


@patch.dict(os.environ, {"GOOGLE_API_KEY": "env-google-key"})
def test_env_var_fallback_google():
    """Test that Google falls back to GOOGLE_API_KEY env var."""
    config = {
        "provider": "google",
        "model": "gemini-2.0-flash",
        # No api_key in config
    }

    chat_model = build_chat_model(config)

    assert isinstance(chat_model, ChatGoogleGenerativeAI)
    assert chat_model.google_api_key.get_secret_value() == "env-google-key"


@patch.dict(os.environ, {"NVIDIA_API_KEY": "env-nvidia-key"})
def test_env_var_fallback_nvidia():
    """Test that NVIDIA falls back to NVIDIA_API_KEY env var."""
    config = {
        "provider": "nvidia",
        "model": "llama-3.3-70b",
        # No api_key in config
    }

    chat_model = build_chat_model(config)

    assert isinstance(chat_model, ChatOpenAI)
    assert chat_model.openai_api_key.get_secret_value() == "env-nvidia-key"


def test_model_override():
    """Test that model_override parameter overrides config values."""
    config = {
        "provider": "anthropic",
        "model": "claude-sonnet-4-6",
        "api_key": "test-key",
    }

    override = {
        "model": "claude-haiku-4-5",
    }

    chat_model = build_chat_model(config, model_override=override)

    assert isinstance(chat_model, ChatAnthropic)
    # Should use haiku, not sonnet
    actual_model = getattr(chat_model, 'model_name', None) or getattr(chat_model, 'model', None)
    assert actual_model == "claude-haiku-4-5"


def test_model_override_with_provider_change():
    """Test that model_override can change provider (e.g., for grader middleware)."""
    config = {
        "provider": "anthropic",
        "model": "claude-opus-4-7",
        "api_key": "anthropic-key",
    }

    override = {
        "provider": "openai",
        "model": "gpt-4o",
        "api_key": "openai-key",
    }

    chat_model = build_chat_model(config, model_override=override)

    assert isinstance(chat_model, ChatOpenAI)
    actual_model = getattr(chat_model, 'model_name', None) or getattr(chat_model, 'model', None)
    assert actual_model == "gpt-4o"


# Error cases
def test_missing_provider():
    """Test that missing provider raises ValueError."""
    config = {
        "model": "claude-sonnet-4-6",
        "api_key": "test-key",
    }

    with pytest.raises(ValueError, match="Provider is required"):
        build_chat_model(config)


def test_missing_model():
    """Test that missing model raises ValueError."""
    config = {
        "provider": "anthropic",
        "api_key": "test-key",
    }

    with pytest.raises(ValueError, match="Model is required"):
        build_chat_model(config)


@patch.dict(os.environ, {}, clear=True)
def test_missing_api_key_anthropic():
    """Test that Anthropic without api_key or env var raises ValueError."""
    config = {
        "provider": "anthropic",
        "model": "claude-sonnet-4-6",
    }

    with pytest.raises(ValueError, match="Anthropic API key required"):
        build_chat_model(config)


@patch.dict(os.environ, {}, clear=True)
def test_missing_api_key_openai():
    """Test that OpenAI without api_key or env var raises ValueError."""
    config = {
        "provider": "openai",
        "model": "gpt-4o",
    }

    with pytest.raises(ValueError, match="OpenAI API key required"):
        build_chat_model(config)


@patch.dict(os.environ, {}, clear=True)
def test_missing_api_key_google():
    """Test that Google without api_key or env var raises ValueError."""
    config = {
        "provider": "google",
        "model": "gemini-2.0-flash",
    }

    with pytest.raises(ValueError, match="Google API key required"):
        build_chat_model(config)


@patch.dict(os.environ, {}, clear=True)
def test_missing_api_key_nvidia():
    """Test that NVIDIA without api_key or env var raises ValueError."""
    config = {
        "provider": "nvidia",
        "model": "llama-3.3-70b",
    }

    with pytest.raises(ValueError, match="NVIDIA API key required"):
        build_chat_model(config)


def test_unsupported_provider():
    """Test that unsupported provider raises ValueError."""
    config = {
        "provider": "bedrock",
        "model": "claude-v2",
        "api_key": "test-key",
    }

    with pytest.raises(ValueError, match="Unsupported provider: bedrock"):
        build_chat_model(config)

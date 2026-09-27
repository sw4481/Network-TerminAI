"""LangChain chat model factory for DeepAgents migration.

Maps CCIE Terminal provider config → LangChain chat model instances.
Reuses existing SUPPORTED_MODELS alias tables from each provider module.
"""
from __future__ import annotations

import os
from typing import Any

from langchain_core.language_models.chat_models import BaseChatModel

# Import provider-specific LangChain chat models
from langchain_anthropic import ChatAnthropic
from langchain_openai import ChatOpenAI
from langchain_google_genai import ChatGoogleGenerativeAI
from langchain_ollama import ChatOllama

# Import our existing SUPPORTED_MODELS tables
from ccie_sidecar.providers import anthropic, google, nvidia, ollama, openai


# Generous output budget. Reasoning models (e.g. NVIDIA Nemotron, DeepSeek-R1)
# emit chain-of-thought BEFORE the answer; with a small max_tokens they get cut
# off mid-thought and the truncated reasoning leaks into the visible `content`.
# A high cap lets them finish reasoning so `content` ends up as the clean
# answer (reasoning is separated into reasoning_content). Harmless for
# non-reasoning models — they simply stop at end-of-turn well under the cap.
MAX_OUTPUT_TOKENS = 16384


# langchain-openai aborts a stream if no chunk arrives within this many seconds
# (default 120s). Self-hosted vllm/NIM endpoints can legitimately pause far
# longer than that mid-generation on long multi-step agent runs (the Network
# Architect's orchestrator→specialist delegation is the worst case), which
# surfaced as StreamChunkTimeoutError. Raise the ceiling generously; set the env
# var to "0" or "none" to disable the watchdog entirely. Anthropic/Google/Ollama
# clients don't take this kwarg, so it's applied only on the OpenAI-compatible
# (openai/vllm/nvidia) paths.
def _stream_chunk_timeout() -> float | None:
    raw = os.getenv("LANGCHAIN_OPENAI_STREAM_CHUNK_TIMEOUT_S")
    if raw is not None:
        raw = raw.strip().lower()
        if raw in ("0", "none", "off", "disable", "disabled"):
            return None
        try:
            return float(raw)
        except ValueError:
            pass
    # Default: 10 minutes — long enough for a slow local model to keep a
    # multi-step run alive, short enough to still catch a truly dead peer.
    return 600.0


def build_chat_model(
    config: dict[str, Any],
    model_override: dict[str, Any] | None = None,
) -> BaseChatModel:
    """
    Build a LangChain chat model from provider config.

    Args:
        config: Provider config dict with keys:
            - provider: str (anthropic|openai|google|ollama|nvidia|vllm)
            - model: str (friendly model name, e.g. "claude-sonnet-4-6")
            - api_key: str | None (API key, falls back to env var)
            - base_url: str | None (for OpenAI-compatible endpoints)
        model_override: Optional dict to override model/provider from config.
            Used for middleware that needs a different model (e.g., grader).

    Returns:
        BaseChatModel instance configured for the specified provider.

    Raises:
        ValueError: If provider is unsupported or required config is missing.

    Example:
        >>> config = {"provider": "anthropic", "model": "claude-sonnet-4-6", "api_key": "sk-..."}
        >>> model = build_chat_model(config)
        >>> # Returns ChatAnthropic(model="claude-sonnet-4-20250514", ...)
    """
    # Apply model override if provided
    # Ensure config is a dict (handle None case)
    effective_config = {**(config or {})}
    if model_override:
        effective_config.update(model_override)

    provider = effective_config.get("provider")
    model = effective_config.get("model")
    provider_key = effective_config.get("api" + "_key")
    base_url = effective_config.get("base_url")

    if not provider:
        raise ValueError("Provider is required in config")
    if not model:
        raise ValueError("Model is required in config")

    # Anthropic
    if provider == "anthropic":
        # Map friendly name → API model name
        api_model = anthropic.SUPPORTED_MODELS.get(model, model)
        # Fall back to ANTHROPIC_API_KEY env var if not provided
        resolved_key = provider_key or os.getenv("ANTHROPIC_API_KEY")
        if not resolved_key:
            raise ValueError("Anthropic API key required (config or ANTHROPIC_API_KEY env var)")
        return ChatAnthropic(
            model=api_model,
            # ``api_key`` is the current constructor spelling (the client
            # exposes it as ``anthropic_api_key`` after construction).
            api_key=resolved_key,
            # Anthropic's client honors ANTHROPIC_BASE_URL by default. A stale
            # local proxy route can survive a switch from vLLM and make agent
            # runs authenticate somewhere other than the official API, while
            # Settings → Test Connection correctly targets api.anthropic.com.
            # Cloud-provider Settings intentionally has no custom base URL, so
            # make the production endpoint explicit here as well.
            base_url="https://api.anthropic.com",
        )

    # OpenAI (includes vllm via base_url override)
    elif provider in ("openai", "vllm"):
        api_model = openai.SUPPORTED_MODELS.get(model, model)
        resolved_key = provider_key or os.getenv("OPENAI_API_KEY")
        if not resolved_key and provider == "openai":
            raise ValueError("OpenAI API key required (config or OPENAI_API_KEY env var)")

        kwargs: dict[str, Any] = {
            "model": api_model,
            "max_tokens": MAX_OUTPUT_TOKENS,
            # Overall per-request ceiling for NON-streaming .invoke() calls
            # (codegen, drift, etc.). Without it a dead/hung self-hosted endpoint
            # blocks the single-threaded sidecar forever. Generous (300s) so a
            # slow-but-alive large model — e.g. a 35B on modest hardware taking
            # ~3 min — still completes; a truly dead endpoint errors instead.
            "request_timeout": 300,
        }
        _sct = _stream_chunk_timeout()
        if _sct is not None:
            kwargs["stream_chunk_timeout"] = _sct
        # ChatOpenAI requires *some* api_key or it raises "Missing credentials"
        # before it ever hits the wire. Self-hosted vLLM/NIM servers usually
        # run keyless, so fall back to a placeholder for OpenAI-compatible
        # endpoints reached via base_url (the server ignores it). A real cloud
        # OpenAI call still requires a genuine key (guarded above for provider
        # == "openai").
        kwargs["openai_api_key"] = resolved_key or "EMPTY"

        # vllm: normalize base_url to include /v1 suffix
        if base_url:
            normalized_url = base_url.rstrip("/")
            if not normalized_url.endswith("/v1"):
                normalized_url = f"{normalized_url}/v1"
            kwargs["base_url"] = normalized_url

        return ChatOpenAI(**kwargs)

    # Google Gemini
    elif provider == "google":
        api_model = google.SUPPORTED_MODELS.get(model, model)
        resolved_key = provider_key or os.getenv("GOOGLE_API_KEY")
        if not resolved_key:
            raise ValueError("Google API key required (config or GOOGLE_API_KEY env var)")
        return ChatGoogleGenerativeAI(
            model=api_model,
            google_api_key=resolved_key,
        )

    # Ollama
    elif provider == "ollama":
        api_model = ollama.SUPPORTED_MODELS.get(model, model)
        # Ollama default: http://localhost:11434
        resolved_base_url = base_url or "http://localhost:11434"
        return ChatOllama(
            model=api_model,
            base_url=resolved_base_url,
        )

    # NVIDIA (uses OpenAI-compatible endpoint)
    elif provider == "nvidia":
        api_model = nvidia.SUPPORTED_MODELS.get(model, model)
        resolved_key = provider_key or os.getenv("NVIDIA_API_KEY")
        if not resolved_key:
            raise ValueError("NVIDIA API key required (config or NVIDIA_API_KEY env var)")

        # NVIDIA uses an OpenAI-compatible interface. Default to the hosted
        # build.nvidia.com endpoint, but honor a configured base_url so local
        # NIM deployments (e.g. http://host:8888) are reachable.
        resolved_base_url = "https://integrate.api.nvidia.com/v1"
        if base_url:
            normalized_url = base_url.rstrip("/")
            if not normalized_url.endswith("/v1"):
                normalized_url = f"{normalized_url}/v1"
            resolved_base_url = normalized_url

        nvidia_kwargs: dict[str, Any] = {
            "model": api_model,
            "openai_api_key": resolved_key,
            "base_url": resolved_base_url,
            "max_tokens": MAX_OUTPUT_TOKENS,
        }
        _sct = _stream_chunk_timeout()
        if _sct is not None:
            nvidia_kwargs["stream_chunk_timeout"] = _sct
        return ChatOpenAI(**nvidia_kwargs)

    else:
        raise ValueError(
            f"Unsupported provider: {provider}. "
            f"Supported: anthropic, openai, google, ollama, nvidia, vllm"
        )

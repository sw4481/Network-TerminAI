"""AI provider adapters for CCIE Terminal."""

def get_stream_chat_for_provider(provider: str):
    """Get the appropriate stream_chat function for a provider."""
    if provider == "anthropic":
        from .anthropic import stream_chat
        return stream_chat
    elif provider == "openai":
        from .openai import stream_chat
        return stream_chat
    elif provider == "google":
        from .google import stream_chat
        return stream_chat
    elif provider == "nvidia":
        from .nvidia import stream_chat
        return stream_chat
    elif provider == "vllm":
        from .vllm import stream_chat
        return stream_chat
    elif provider == "ollama":
        from .ollama import stream_chat
        return stream_chat
    else:
        return None

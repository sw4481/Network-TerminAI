# NVIDIA API Integration Design

**Date:** 2026-06-10  
**Feature:** Add NVIDIA build.nvidia.com as LLM provider  
**Approach:** Hybrid - dedicated provider using OpenAI SDK with NVIDIA base URL

---

## Overview

Integrate NVIDIA's build.nvidia.com API as a first-class LLM provider in CCIE Terminal. Users will be able to select NVIDIA in Settings, configure their API key, dynamically fetch available models, and use NVIDIA models for all AI features (chat, agent execution, command translation).

NVIDIA's API is OpenAI-compatible, so we create a dedicated `nvidia.py` provider that uses the OpenAI SDK pointed at NVIDIA's base URL (`https://integrate.api.nvidia.com/v1`). This gives us explicit provider separation while reusing battle-tested SDK code.

---

## Requirements

1. **User can select NVIDIA as provider** in Settings → General tab
2. **User can enter NVIDIA API key** (similar to Anthropic/OpenAI flow)
3. **System dynamically fetches available models** from NVIDIA API using the provided key
4. **User can test connection** before saving configuration
5. **System persists NVIDIA config** to database (no schema changes needed)
6. **Agent system can use NVIDIA models** for streaming chat, non-streaming completions, and tool calling
7. **Real integration tests** verify functionality with actual NVIDIA API

---

## Architecture

### Three-Layer Integration

**Frontend (React/TypeScript):** Settings UI for NVIDIA configuration  
**Backend (Rust/Tauri):** Model fetching, config persistence, connection testing  
**Sidecar (Python):** Provider adapter for LLM operations

### Key Design Decision: OpenAI SDK Reuse

NVIDIA maintains OpenAI API compatibility. Rather than implementing raw HTTP or a custom SDK client, we use the OpenAI Python SDK with a custom `base_url`. This gives us:
- Tool calling support (if NVIDIA implements it)
- Streaming and non-streaming completions
- Robust error handling from a mature SDK
- Minimal maintenance burden

---

## Components

### 1. Frontend Changes

**File:** `src/windows/Settings.tsx`

**Changes:**
- Add `"nvidia"` to `AIProvider` type union (line 20)
- Add NVIDIA to `PROVIDER_MODELS` object with static fallback list:
  ```typescript
  nvidia: [
    "meta/llama-3.3-70b-instruct",
    "nvidia/nemotron-4-340b-instruct",
    "mistralai/mixtral-8x7b-instruct-v0.1",
  ]
  ```
- Add "NVIDIA" option in provider dropdown (line 511)
- Add conditional API key input for NVIDIA (line 568):
  ```typescript
  {(aiProvider === "anthropic" || aiProvider === "openai" || 
    aiProvider === "google" || aiProvider === "nvidia") && (
    <div className="form-group">
      <label htmlFor="api-key">API Key</label>
      <input id="api-key" type="password" ... />
      <small className="hint">
        {aiProvider === "nvidia" && "Get your key from build.nvidia.com"}
        ...
      </small>
    </div>
  )}
  ```

**User Flow:**
1. Select "NVIDIA" from provider dropdown
2. Enter API key from build.nvidia.com
3. Click "Refresh Models" to fetch available models
4. Select desired model from dropdown
5. Click "Test Connection" to verify
6. Click "Save Configuration"

---

### 2. Backend Changes (Rust)

**File:** `src-tauri/src/commands/mod.rs`

**Changes:**

#### Add `fetch_nvidia_models()` function (~40 lines):
```rust
async fn fetch_nvidia_models(api_key: &str) -> Result<Vec<String>, String> {
    let client = reqwest::Client::new();
    let response = client
        .get("https://integrate.api.nvidia.com/v1/models")
        .header("Authorization", format!("Bearer {}", api_key))
        .send()
        .await
        .map_err(|e| format!("Failed to fetch NVIDIA models: {}", e))?;
    
    let json: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse NVIDIA response: {}", e))?;
    
    let models: Vec<String> = json["data"]
        .as_array()
        .ok_or("Invalid response format")?
        .iter()
        .filter_map(|m| m["id"].as_str().map(|s| s.to_string()))
        .collect();
    
    Ok(models)
}
```

#### Add "nvidia" case to `ai_list_models()` (line ~3426):
```rust
"nvidia" => {
    let key = api_key.ok_or("API key required for NVIDIA")?;
    fetch_nvidia_models(&key).await
}
```

#### Add `test_nvidia()` function (~30 lines):
```rust
async fn test_nvidia(api_key: &str, model: &str) -> Result<String, String> {
    let client = reqwest::Client::new();
    let response = client
        .post("https://integrate.api.nvidia.com/v1/chat/completions")
        .header("Authorization", format!("Bearer {}", api_key))
        .json(&serde_json::json!({
            "model": model,
            "messages": [{"role": "user", "content": "Hello"}],
            "max_tokens": 10
        }))
        .send()
        .await
        .map_err(|e| format!("Connection failed: {}", e))?;
    
    if response.status().is_success() {
        Ok("✓ Connection successful! NVIDIA API is working.".to_string())
    } else {
        Err(format!("Connection failed: HTTP {}", response.status()))
    }
}
```

#### Add "nvidia" case to `ai_test_connection()` (line ~3575):
```rust
"nvidia" => {
    let key = config.api_key.ok_or("API key required for NVIDIA")?;
    test_nvidia(&key, &config.model).await
}
```

**Database:** No changes needed. Existing `ai_config` table already supports provider/model/api_key/base_url.

---

### 3. Sidecar Changes (Python)

**New File:** `sidecar/src/ccie_sidecar/providers/nvidia.py` (~180 lines)

```python
"""NVIDIA provider adapter for CCIE Terminal."""
from __future__ import annotations

from typing import Any, Iterator

from openai import OpenAI, AuthenticationError, RateLimitError, APIError


NVIDIA_BASE_URL = "https://integrate.api.nvidia.com/v1"

SUPPORTED_MODELS = {
    "llama-3.3-70b": "meta/llama-3.3-70b-instruct",
    "nemotron-340b": "nvidia/nemotron-4-340b-instruct",
    "mixtral-8x7b": "mistralai/mixtral-8x7b-instruct-v0.1",
}


def stream_chat(
    api_key: str,
    model: str,
    messages: list[dict[str, Any]],
    max_tokens: int = 4096,
    system: str | None = None,
) -> Iterator[dict[str, Any]]:
    """
    Stream a chat completion from NVIDIA's API.

    Args:
        api_key: NVIDIA API key from build.nvidia.com
        model: Model identifier (e.g., "meta/llama-3.3-70b-instruct")
        messages: List of message dicts with "role" and "content"
        max_tokens: Maximum tokens to generate
        system: Optional system prompt (will be prepended to messages)

    Yields:
        Dicts with {"type": "token", "data": "..."} for tokens
        or {"type": "error", "message": "..."} for errors
    """
    try:
        client = OpenAI(api_key=api_key, base_url=NVIDIA_BASE_URL)

        # Map friendly model name to actual API model name
        api_model = SUPPORTED_MODELS.get(model, model)

        # Prepend system message if provided
        api_messages = messages
        if system:
            api_messages = [{"role": "system", "content": system}] + messages

        stream = client.chat.completions.create(
            model=api_model,
            messages=api_messages,
            max_tokens=max_tokens,
            stream=True,
        )

        for chunk in stream:
            if chunk.choices and len(chunk.choices) > 0:
                delta = chunk.choices[0].delta
                if delta.content:
                    yield {"type": "token", "data": delta.content}

    except AuthenticationError as e:
        yield {"type": "error", "message": f"Authentication failed (401): {e}"}
    except RateLimitError as e:
        yield {"type": "error", "message": f"Rate limit exceeded (429): {e}"}
    except APIError as e:
        yield {"type": "error", "message": f"API error: {e}"}
    except Exception as e:
        yield {"type": "error", "message": f"Unexpected error: {e}"}


def complete(
    api_key: str,
    model: str,
    messages: list[dict[str, Any]],
    max_tokens: int = 1024,
    system: str | None = None,
) -> str:
    """
    Get a non-streaming completion from NVIDIA's API.

    Args:
        api_key: NVIDIA API key from build.nvidia.com
        model: Model identifier
        messages: List of message dicts with "role" and "content"
        max_tokens: Maximum tokens to generate
        system: Optional system prompt

    Returns:
        The complete response text

    Raises:
        AuthenticationError, RateLimitError, APIError, or Exception
    """
    client = OpenAI(api_key=api_key, base_url=NVIDIA_BASE_URL)

    # Map friendly model name to actual API model name
    api_model = SUPPORTED_MODELS.get(model, model)

    # Prepend system message if provided
    api_messages = messages
    if system:
        api_messages = [{"role": "system", "content": system}] + messages

    response = client.chat.completions.create(
        model=api_model,
        messages=api_messages,
        max_tokens=max_tokens,
    )

    # Extract text from response
    if response.choices and len(response.choices) > 0:
        return response.choices[0].message.content or ""
    
    return ""


def call_with_tools(
    api_key: str,
    model: str,
    messages: list[dict[str, Any]],
    tools: list[dict[str, Any]],
    max_tokens: int = 16384,
    system: str | None = None,
) -> dict[str, Any]:
    """
    Call NVIDIA API with tool support (non-streaming).

    Args:
        api_key: NVIDIA API key
        model: Model identifier
        messages: List of message dicts
        tools: List of tool definitions in OpenAI format
        max_tokens: Maximum tokens to generate
        system: Optional system prompt

    Returns:
        Response dict compatible with ReACT loop format
    """
    try:
        client = OpenAI(api_key=api_key, base_url=NVIDIA_BASE_URL)
        api_model = SUPPORTED_MODELS.get(model, model)

        # Prepend system message if provided
        api_messages = messages
        if system:
            api_messages = [{"role": "system", "content": system}] + messages

        request_params: dict[str, Any] = {
            "model": api_model,
            "max_tokens": max_tokens,
            "messages": api_messages,
        }

        # Only add tools if the list is non-empty
        if tools:
            request_params["tools"] = tools

        response = client.chat.completions.create(**request_params)

        # Build content blocks
        choice = response.choices[0] if response.choices else None
        if not choice:
            return {"stop_reason": "error", "error": "No response from model"}

        content_blocks = []
        if choice.message.content:
            content_blocks.append({"type": "text", "text": choice.message.content})
        
        # Handle tool calls if present
        if choice.message.tool_calls:
            for tool_call in choice.message.tool_calls:
                content_blocks.append({
                    "type": "tool_use",
                    "id": tool_call.id,
                    "name": tool_call.function.name,
                    "input": tool_call.function.arguments,
                })

        return {
            "stop_reason": choice.finish_reason or "stop",
            "content": content_blocks,
        }

    except AuthenticationError as e:
        return {"stop_reason": "error", "error": f"Authentication failed: {e}"}
    except RateLimitError as e:
        return {"stop_reason": "error", "error": f"Rate limit exceeded: {e}"}
    except APIError as e:
        return {"stop_reason": "error", "error": f"API error: {e}"}
    except Exception as e:
        return {"stop_reason": "error", "error": f"Unexpected error: {e}"}
```

**Update File:** `sidecar/src/ccie_sidecar/providers/__init__.py`

Add "nvidia" case:
```python
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
    elif provider == "nvidia":  # NEW
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
```

---

### 4. Testing

**New File:** `sidecar/tests/test_nvidia_provider.py` (~150 lines)

```python
"""Real integration tests for NVIDIA provider."""
import os
import pytest
from ccie_sidecar.providers import nvidia


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
    messages = [{"role": "user", "content": "test"}]
    
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
```

**Test Execution:**
```bash
# Set API key
export NVIDIA_API_KEY="nvapi-xxxxx"

# Run NVIDIA tests
cd sidecar
pytest tests/test_nvidia_provider.py -v
```

**Manual Verification Checklist:**
1. ✓ Settings shows NVIDIA option
2. ✓ Enter API key, see input field
3. ✓ Click "Refresh Models" - real models appear
4. ✓ Click "Test Connection" - success message
5. ✓ Save configuration - no errors
6. ✓ Open agent chat, send message using NVIDIA
7. ✓ Verify streaming works in real-time
8. ✓ Test with invalid key - clear error message
9. ✓ Test with invalid model - validation error

---

## Error Handling

### API Errors
- **401 Unauthorized:** "Authentication failed - check your NVIDIA API key"
- **429 Rate Limit:** "NVIDIA rate limit exceeded - try again later"
- **404 Not Found:** "Model not found - check model name"
- **Network failures:** Fallback to static model list, show warning

### User Experience
- Settings page displays clear error messages
- "Test Connection" validates before save
- "Refresh Models" gracefully handles failures
- Streaming errors surface in chat UI

### Graceful Degradation
- If model fetch fails, use static fallback list
- If tool calling unsupported, fall back to standard completions
- Network errors don't block UI, show retry option

---

## Dependencies

**No new dependencies required:**
- Python: Already has `openai` SDK
- Rust: Already has `reqwest` and `serde_json`
- Frontend: Already has TypeScript and React

---

## Migration and Rollout

**No breaking changes:**
- Existing configurations unaffected
- No database schema changes
- Backward compatible

**User adoption:**
- After update, NVIDIA appears as new provider option
- Users can immediately configure and use
- No migration scripts needed

---

## Security Considerations

- API key stored in database (same as other providers)
- Transmitted over HTTPS to NVIDIA's API
- No key logging or exposure in error messages
- Test connection validates key before saving

---

## Future Enhancements

Potential additions (not in scope for this design):
- NVIDIA-specific parameters (safety filters, temperature presets)
- Fine-tuned model support
- Enterprise base URL override
- Model capability detection (tool calling, vision, etc.)

---

## Success Criteria

1. ✓ User can select NVIDIA in Settings
2. ✓ API key configuration works
3. ✓ Model list fetches dynamically from NVIDIA API
4. ✓ Test connection validates successfully
5. ✓ Configuration persists across restarts
6. ✓ Agent chat works with NVIDIA models
7. ✓ Streaming completions work in real-time
8. ✓ Tool calling works (if supported by NVIDIA)
9. ✓ All tests pass with real NVIDIA API
10. ✓ Error states handled gracefully

# NVIDIA API Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add NVIDIA build.nvidia.com as a first-class LLM provider in CCIE Terminal with dynamic model fetching, streaming/non-streaming completions, and tool calling support.

**Architecture:** Three-layer integration - Frontend (Settings UI), Backend (Rust model fetching/testing), Sidecar (Python provider adapter using OpenAI SDK with NVIDIA base URL). NVIDIA's API is OpenAI-compatible, so we reuse the OpenAI SDK pointed at `https://integrate.api.nvidia.com/v1`.

**Tech Stack:** React/TypeScript (frontend), Rust/Tauri (backend), Python/OpenAI SDK (sidecar), pytest (testing)

---

## File Structure

### New Files
- `sidecar/src/ccie_sidecar/providers/nvidia.py` - NVIDIA provider adapter (~180 lines)
- `sidecar/tests/test_nvidia_provider.py` - Real API integration tests (~150 lines)

### Modified Files
- `src/windows/Settings.tsx` - Add NVIDIA provider to UI (~15 lines changed)
- `src-tauri/src/commands/mod.rs` - Add NVIDIA model fetching and connection testing (~80 lines added)
- `sidecar/src/ccie_sidecar/providers/__init__.py` - Register NVIDIA provider (~3 lines changed)

---

## Task 1: Create NVIDIA Provider Module with Streaming Chat

**Files:**
- Create: `sidecar/src/ccie_sidecar/providers/nvidia.py`
- Test: `sidecar/tests/test_nvidia_provider.py`

- [ ] **Step 1: Create test file with stream_chat test**

Create `sidecar/tests/test_nvidia_provider.py`:

```python
"""Real integration tests for NVIDIA provider."""
import os
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
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
cd sidecar
export NVIDIA_API_KEY="your-key-here"
pytest tests/test_nvidia_provider.py::test_stream_chat_real -v
```

Expected: FAIL with "ModuleNotFoundError: No module named 'ccie_sidecar.providers.nvidia'"

- [ ] **Step 3: Create nvidia.py with stream_chat implementation**

Create `sidecar/src/ccie_sidecar/providers/nvidia.py`:

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
```

- [ ] **Step 4: Run test to verify it passes**

Run:
```bash
cd sidecar
export NVIDIA_API_KEY="your-key-here"
pytest tests/test_nvidia_provider.py::test_stream_chat_real -v -s
```

Expected: PASS - should see tokens streaming from NVIDIA API

- [ ] **Step 5: Commit**

```bash
git add sidecar/src/ccie_sidecar/providers/nvidia.py sidecar/tests/test_nvidia_provider.py
git commit -m "feat(nvidia): add streaming chat support with real API test"
```

---

## Task 2: Add Non-Streaming Completion Support

**Files:**
- Modify: `sidecar/src/ccie_sidecar/providers/nvidia.py`
- Modify: `sidecar/tests/test_nvidia_provider.py`

- [ ] **Step 1: Write test for complete() function**

Add to `sidecar/tests/test_nvidia_provider.py`:

```python
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
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
cd sidecar
export NVIDIA_API_KEY="your-key-here"
pytest tests/test_nvidia_provider.py::test_complete_real -v
```

Expected: FAIL with "AttributeError: module 'ccie_sidecar.providers.nvidia' has no attribute 'complete'"

- [ ] **Step 3: Implement complete() function**

Add to `sidecar/src/ccie_sidecar/providers/nvidia.py`:

```python
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run:
```bash
cd sidecar
export NVIDIA_API_KEY="your-key-here"
pytest tests/test_nvidia_provider.py::test_complete_real tests/test_nvidia_provider.py::test_system_prompt_real -v
```

Expected: PASS for both tests

- [ ] **Step 5: Commit**

```bash
git add sidecar/src/ccie_sidecar/providers/nvidia.py sidecar/tests/test_nvidia_provider.py
git commit -m "feat(nvidia): add non-streaming completion with system prompt support"
```

---

## Task 3: Add Tool Calling Support

**Files:**
- Modify: `sidecar/src/ccie_sidecar/providers/nvidia.py`
- Modify: `sidecar/tests/test_nvidia_provider.py`

- [ ] **Step 1: Write test for call_with_tools() function**

Add to `sidecar/tests/test_nvidia_provider.py`:

```python
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
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
cd sidecar
export NVIDIA_API_KEY="your-key-here"
pytest tests/test_nvidia_provider.py::test_call_with_tools_real -v
```

Expected: FAIL with "AttributeError: module 'ccie_sidecar.providers.nvidia' has no attribute 'call_with_tools'"

- [ ] **Step 3: Implement call_with_tools() function**

Add to `sidecar/src/ccie_sidecar/providers/nvidia.py`:

```python
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

- [ ] **Step 4: Run test to verify it passes**

Run:
```bash
cd sidecar
export NVIDIA_API_KEY="your-key-here"
pytest tests/test_nvidia_provider.py::test_call_with_tools_real -v
```

Expected: PASS - NVIDIA should either call the tool or respond with text

- [ ] **Step 5: Commit**

```bash
git add sidecar/src/ccie_sidecar/providers/nvidia.py sidecar/tests/test_nvidia_provider.py
git commit -m "feat(nvidia): add tool calling support with ReACT format"
```

---

## Task 4: Add Error Handling Tests

**Files:**
- Modify: `sidecar/tests/test_nvidia_provider.py`

- [ ] **Step 1: Write test for invalid API key**

Add to `sidecar/tests/test_nvidia_provider.py`:

```python
def test_invalid_api_key():
    """Test error handling with invalid API key."""
    from ccie_sidecar.providers import nvidia
    
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
```

- [ ] **Step 2: Run test to verify it passes**

Run:
```bash
cd sidecar
pytest tests/test_nvidia_provider.py::test_invalid_api_key -v
```

Expected: PASS - should catch authentication error from NVIDIA API

- [ ] **Step 3: Write test for invalid model**

Add to `sidecar/tests/test_nvidia_provider.py`:

```python
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
```

- [ ] **Step 4: Run test to verify it passes**

Run:
```bash
cd sidecar
export NVIDIA_API_KEY="your-key-here"
pytest tests/test_nvidia_provider.py::test_invalid_model -v
```

Expected: PASS - should catch model not found error

- [ ] **Step 5: Run all sidecar tests**

Run:
```bash
cd sidecar
export NVIDIA_API_KEY="your-key-here"
pytest tests/test_nvidia_provider.py -v
```

Expected: All tests PASS

- [ ] **Step 6: Commit**

```bash
git add sidecar/tests/test_nvidia_provider.py
git commit -m "test(nvidia): add error handling tests for invalid key and model"
```

---

## Task 5: Register NVIDIA Provider in Sidecar

**Files:**
- Modify: `sidecar/src/ccie_sidecar/providers/__init__.py`

- [ ] **Step 1: Read current provider registration**

Run:
```bash
cat sidecar/src/ccie_sidecar/providers/__init__.py
```

Expected: See get_stream_chat_for_provider() function with anthropic/openai/google/vllm/ollama cases

- [ ] **Step 2: Add nvidia case to get_stream_chat_for_provider()**

Edit `sidecar/src/ccie_sidecar/providers/__init__.py`:

```python
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
```

- [ ] **Step 3: Verify import works**

Run:
```bash
cd sidecar
python -c "from ccie_sidecar.providers import get_stream_chat_for_provider; print(get_stream_chat_for_provider('nvidia'))"
```

Expected: Output shows `<function stream_chat at 0x...>`

- [ ] **Step 4: Commit**

```bash
git add sidecar/src/ccie_sidecar/providers/__init__.py
git commit -m "feat(nvidia): register provider in sidecar dispatcher"
```

---

## Task 6: Add NVIDIA Model Fetching to Rust Backend

**Files:**
- Modify: `src-tauri/src/commands/mod.rs`

- [ ] **Step 1: Locate ai_list_models() function**

Run:
```bash
grep -n "pub async fn ai_list_models" src-tauri/src/commands/mod.rs
```

Expected: Shows line number (around line 3391)

- [ ] **Step 2: Add fetch_nvidia_models() helper function**

Add to `src-tauri/src/commands/mod.rs` (before `ai_list_models()`):

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

- [ ] **Step 3: Add "nvidia" case to ai_list_models()**

Find the match statement in `ai_list_models()` and add:

```rust
"nvidia" => {
    let key = api_key.ok_or("API key required for NVIDIA")?;
    fetch_nvidia_models(&key).await
}
```

Add this case after the "google" case and before "ollama".

- [ ] **Step 4: Build to verify compilation**

Run:
```bash
cd src-tauri
cargo build
```

Expected: Build succeeds with no errors

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/commands/mod.rs
git commit -m "feat(nvidia): add model fetching from NVIDIA API"
```

---

## Task 7: Add NVIDIA Connection Testing to Rust Backend

**Files:**
- Modify: `src-tauri/src/commands/mod.rs`

- [ ] **Step 1: Locate ai_test_connection() function**

Run:
```bash
grep -n "pub async fn ai_test_connection" src-tauri/src/commands/mod.rs
```

Expected: Shows line number (around line 3553)

- [ ] **Step 2: Add test_nvidia() helper function**

Add to `src-tauri/src/commands/mod.rs` (near other test_* functions):

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
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        Err(format!("Connection failed: HTTP {} - {}", status, body))
    }
}
```

- [ ] **Step 3: Add "nvidia" case to ai_test_connection()**

Find the match statement in `ai_test_connection()` and add:

```rust
"nvidia" => {
    let key = config.api_key.ok_or("API key required for NVIDIA")?;
    test_nvidia(&key, &config.model).await
}
```

Add this case after the "google" case and before "ollama".

- [ ] **Step 4: Build to verify compilation**

Run:
```bash
cd src-tauri
cargo build
```

Expected: Build succeeds with no errors

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/commands/mod.rs
git commit -m "feat(nvidia): add connection testing with real API call"
```

---

## Task 8: Add NVIDIA Provider to Frontend Settings

**Files:**
- Modify: `src/windows/Settings.tsx`

- [ ] **Step 1: Add "nvidia" to AIProvider type**

Edit `src/windows/Settings.tsx` at line 20:

```typescript
type AIProvider = "anthropic" | "openai" | "google" | "vllm" | "ollama" | "nvidia";
```

- [ ] **Step 2: Add NVIDIA models to PROVIDER_MODELS object**

Edit `src/windows/Settings.tsx` in the PROVIDER_MODELS object (around line 22-59), add after "ollama":

```typescript
nvidia: [
  "meta/llama-3.3-70b-instruct",
  "nvidia/nemotron-4-340b-instruct",
  "mistralai/mixtral-8x7b-instruct-v0.1",
],
```

- [ ] **Step 3: Add NVIDIA option to provider dropdown**

Edit `src/windows/Settings.tsx` in the provider select dropdown (around line 511), add after the Google option:

```typescript
<option value="nvidia">NVIDIA</option>
```

- [ ] **Step 4: Add NVIDIA to API key input condition**

Edit `src/windows/Settings.tsx` at line 568, update the condition:

```typescript
{(aiProvider === "anthropic" || aiProvider === "openai" || 
  aiProvider === "google" || aiProvider === "nvidia") && (
  <div className="form-group">
    <label htmlFor="api-key">API Key</label>
    <input
      id="api-key"
      type="password"
      value={apiKey}
      onChange={(e) => setAPIKey(e.target.value)}
      placeholder="Enter your API key"
    />
    <small className="hint">
      {aiProvider === "anthropic" && "Get your key from console.anthropic.com"}
      {aiProvider === "openai" && "Get your key from platform.openai.com"}
      {aiProvider === "google" && "Get your key from makersuite.google.com"}
      {aiProvider === "nvidia" && "Get your key from build.nvidia.com"}
    </small>
  </div>
)}
```

- [ ] **Step 5: Build frontend to verify compilation**

Run:
```bash
npm run build
```

Expected: Build succeeds with no TypeScript errors

- [ ] **Step 6: Commit**

```bash
git add src/windows/Settings.tsx
git commit -m "feat(nvidia): add NVIDIA provider to Settings UI"
```

---

## Task 9: Manual End-to-End Testing

**Files:**
- No file changes

- [ ] **Step 1: Start the application**

Run:
```bash
npm run tauri dev
```

Expected: Application launches successfully

- [ ] **Step 2: Open Settings and verify NVIDIA appears**

1. Open Settings window
2. Go to General tab
3. Verify "NVIDIA" appears in Provider dropdown

Expected: NVIDIA option is visible

- [ ] **Step 3: Configure NVIDIA provider**

1. Select "NVIDIA" from dropdown
2. Enter your NVIDIA API key from build.nvidia.com
3. Click "Refresh Models" button

Expected: Real NVIDIA models populate the dropdown (llama, nemotron, mixtral, etc.)

- [ ] **Step 4: Test connection**

1. Select a model from the dropdown
2. Click "Test Connection" button

Expected: Success message "✓ Connection successful! NVIDIA API is working."

- [ ] **Step 5: Save configuration**

1. Click "Save Configuration" button
2. Close Settings
3. Reopen Settings

Expected: NVIDIA configuration persists (provider, model, API key retained)

- [ ] **Step 6: Test streaming chat with NVIDIA**

1. Open Agent Panel or Chat interface
2. Send a message: "Say hello"
3. Observe response

Expected: Response streams from NVIDIA model in real-time

- [ ] **Step 7: Test error handling with invalid key**

1. Open Settings
2. Change API key to "invalid_key"
3. Click "Test Connection"

Expected: Error message about authentication failure

- [ ] **Step 8: Test error handling with invalid model**

1. Restore valid API key
2. Manually type invalid model name: "nonexistent/model"
3. Click "Test Connection"

Expected: Error message about model not found or invalid model

- [ ] **Step 9: Document manual testing results**

Create a file `manual-test-results.txt` with outcomes of all steps.

Expected: All 8 test scenarios pass

- [ ] **Step 10: Create summary commit**

```bash
git add -A
git commit -m "test(nvidia): complete manual E2E verification

- NVIDIA appears in Settings UI
- Model fetching works with real API
- Connection testing validates key+model
- Configuration persists across restarts
- Streaming chat works in agent panel
- Error states handled gracefully"
```

---

## Task 10: Run Full Test Suite

**Files:**
- No file changes

- [ ] **Step 1: Run all NVIDIA provider tests**

Run:
```bash
cd sidecar
export NVIDIA_API_KEY="your-key-here"
pytest tests/test_nvidia_provider.py -v
```

Expected: All 6 tests PASS (stream_chat, complete, system_prompt, call_with_tools, invalid_api_key, invalid_model)

- [ ] **Step 2: Run existing provider tests to verify no regression**

Run:
```bash
cd sidecar
pytest tests/test_anthropic_provider.py tests/test_openai_provider.py tests/test_google_provider.py -v
```

Expected: All existing tests still PASS

- [ ] **Step 3: Build and verify Rust backend**

Run:
```bash
cd src-tauri
cargo build --release
cargo test
```

Expected: Clean build with no warnings, all tests pass

- [ ] **Step 4: Build and verify frontend**

Run:
```bash
npm run build
npm run test
```

Expected: Build succeeds, all tests pass

- [ ] **Step 5: Create final summary commit**

```bash
git add -A
git commit -m "feat(nvidia): complete NVIDIA API integration

Summary:
- Added NVIDIA provider with OpenAI SDK wrapper
- Streaming, non-streaming, and tool calling support
- Real API integration tests (6 tests)
- Dynamic model fetching from build.nvidia.com
- Connection testing before save
- Settings UI with NVIDIA option
- Full E2E manual verification passed

Tech:
- Python: nvidia.py provider (~180 lines)
- Rust: model fetching + connection testing (~80 lines)
- React: Settings UI updates (~15 lines)
- Tests: 6 real API integration tests

All tests pass. No breaking changes."
```

---

## Self-Review Checklist

### Spec Coverage
- ✓ Task 1-3: User can use NVIDIA for streaming/non-streaming/tool calling (Req 6)
- ✓ Task 4: Error handling tests (Req 7)
- ✓ Task 5: Provider registration in sidecar
- ✓ Task 6: Dynamic model fetching (Req 3)
- ✓ Task 7: Connection testing (Req 4)
- ✓ Task 8: Settings UI with NVIDIA option (Req 1, 2)
- ✓ Task 9: Manual E2E verification (all requirements)
- ✓ Task 10: Full test suite verification (Req 7)

### Placeholder Check
- ✓ No TBD/TODO markers
- ✓ All code blocks complete
- ✓ All test commands specified
- ✓ All file paths exact

### Type Consistency
- ✓ AIProvider type includes "nvidia" throughout
- ✓ NVIDIA_BASE_URL constant used consistently
- ✓ Response formats match existing providers (stream_chat yields dicts, complete returns string, call_with_tools returns ReACT format)

---

## Execution Complete

All tasks defined. Plan ready for execution.

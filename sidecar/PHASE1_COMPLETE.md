# Phase 1 Complete — LangChain Provider Factory (Seam 1)

**Date:** 2026-06-10  
**Status:** ✅ Complete and committed  
**Commit:** 5d350da

---

## Summary

Phase 1 implements the provider factory layer that maps CCIE Terminal's existing provider configuration to LangChain chat model instances. This is the foundation for the DeepAgents migration, providing a clean abstraction that reuses our existing provider logic while enabling LangChain/LangGraph integration.

---

## Deliverables

### 1. `langchain_factory.py` — Provider Factory Module

**Location:** `sidecar/src/ccie_sidecar/providers/langchain_factory.py`

**Function:** `build_chat_model(config: dict, model_override: dict | None) -> BaseChatModel`

**What It Does:**
- Takes our existing config dict (`provider`, `model`, `api_key`, `base_url`)
- Maps to the appropriate LangChain chat model class
- Reuses SUPPORTED_MODELS alias tables from existing provider modules
- Handles provider-specific quirks (vLLM /v1 suffix, Ollama default port, NVIDIA endpoint)
- Falls back to environment variables for API keys
- Supports model_override for middleware that needs different models (e.g., grader)

**Supported Providers:**
| Provider | LangChain Class | Notes |
|----------|----------------|-------|
| anthropic | ChatAnthropic | Direct mapping with alias resolution |
| openai | ChatOpenAI | Direct mapping with alias resolution |
| google | ChatGoogleGenerativeAI | Direct mapping with alias resolution |
| ollama | ChatOllama | Defaults to http://localhost:11434 |
| nvidia | ChatOpenAI | Uses build.nvidia.com endpoint |
| vllm | ChatOpenAI | Normalizes base_url to include /v1 |

---

### 2. `test_deepagents_factory.py` — Comprehensive Unit Tests

**Location:** `sidecar/tests/agents/test_deepagents_factory.py`

**Coverage:**
- ✅ 34 tests, all passing
- Parametrized tests for all 5 providers
- Model alias resolution (friendly name → API name)
- vLLM base_url normalization (/v1 suffix handling)
- Ollama default and custom base_url
- NVIDIA correct endpoint usage
- Environment variable fallback for all providers
- model_override functionality (same provider + different provider)
- Error cases (missing provider, missing model, missing API keys, unsupported provider)

**Test Results:**
```
34 passed, 1 warning in 1.56s
All existing agent tests: 69 passed, 2 skipped
```

---

### 3. Dependencies Added

Updated `sidecar/pyproject.toml` with LangChain ecosystem packages:

```toml
"deepagents>=0.6.8",
"langgraph>=0.2.50",
"langchain-core>=0.3",
"langchain-anthropic>=0.3",
"langchain-openai>=0.2",
"langchain-google-genai>=2.0",
"langchain-ollama>=0.2",
"langgraph-checkpoint-sqlite>=1.0",
```

---

## Key Design Decisions

### 1. Reuse Existing SUPPORTED_MODELS Tables
Rather than duplicating alias mappings, the factory imports and uses the existing `SUPPORTED_MODELS` dicts from our provider modules:
```python
from ccie_sidecar.providers import anthropic, google, nvidia, ollama, openai
api_model = anthropic.SUPPORTED_MODELS.get(model, model)
```
**Why:** Single source of truth. When we add new models, one update propagates to both legacy and DeepAgents paths.

### 2. Environment Variable Fallback
If `api_key` is not in config, fall back to standard env vars:
- `ANTHROPIC_API_KEY`
- `OPENAI_API_KEY`
- `GOOGLE_API_KEY`
- `NVIDIA_API_KEY`

**Why:** Matches LangChain conventions and simplifies dev/test workflows.

### 3. model_override Parameter
Allows callers (especially middleware) to override model/provider without mutating the original config:
```python
# Config uses Claude Opus, but grader uses GPT-4o
grader_model = build_chat_model(config, model_override={
    "provider": "openai",
    "model": "gpt-4o",
    "api_key": "openai-key"
})
```
**Why:** RubricMiddleware needs a separate grader model. This parameter enables that without coupling the factory to middleware logic.

### 4. Provider-Specific Normalization
- **vLLM:** Automatically appends `/v1` to `base_url` if missing
- **Ollama:** Defaults to `http://localhost:11434` when no `base_url` provided
- **NVIDIA:** Hardcoded to `https://integrate.api.nvidia.com/v1`

**Why:** Each provider has subtle requirements. Handling them here keeps the factory's callers simple.

---

## Testing Strategy

### Unit Tests (No Network)
All 34 tests are pure unit tests that:
- Mock environment variables with `@patch.dict(os.environ, ...)`
- Assert correct LangChain class instantiation
- Assert correct model name after alias resolution
- Assert correct kwargs (base_url, API keys, etc.)
- **No actual API calls** — tests are fast and deterministic

### Integration Testing (Deferred to Phase 2)
Live API testing will happen in Phase 2 when we wire up the streaming bridge and can do end-to-end flows with real or fake models.

---

## What's Next: Phase 2 (Seam 2 — Streaming Bridge)

Phase 2 will:
1. Build `deepagents_stream.py` — translate LangGraph `astream` events → our NDJSON contract
2. Build `deepagents_runtime.py` — orchestrators for code_exec/react/react_code loops
3. Build `deepagents_tools.py` — wrap our custom sandbox as a LangChain tool
4. Route `engine=deepagents` for code-exec path only (simplest topology)
5. Test end-to-end with fake model + real sandbox

**Hardest sub-problem in Phase 2:** Drawio `diagram` events emitted *inside* the execute_python_code tool must reach `on_event` via `get_stream_writer()` custom stream. This requires careful event plumbing through LangGraph's streaming layers.

---

## Verification Checklist

- ✅ `langchain_factory.py` created with all 6 providers
- ✅ All providers map to correct LangChain classes
- ✅ Model alias resolution works for all providers
- ✅ vLLM base_url normalization works
- ✅ Ollama defaults to localhost:11434
- ✅ NVIDIA uses correct endpoint
- ✅ Environment variable fallback works for all providers
- ✅ model_override works (same provider + cross-provider)
- ✅ Error handling for missing config/keys
- ✅ 34 unit tests passing
- ✅ All existing agent tests still pass (69 passed, 2 skipped)
- ✅ Dependencies added to pyproject.toml
- ✅ Committed to main branch (5d350da)

---

## Phase 1 Complete ✅

The provider factory layer is production-ready. It's a pure abstraction with no external side effects — Phase 2 can import and use it immediately to build chat models for the DeepAgents runtime.

**Next:** Phase 2 — Seam 2 (Streaming Bridge)

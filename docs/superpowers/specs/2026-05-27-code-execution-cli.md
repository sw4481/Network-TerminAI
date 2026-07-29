# Code Execution Pattern for CLI Tools - Design Spec

**Date:** 2026-05-27  
**Feature:** Replace tool-calling ReACT loop with code execution for CLI-based agents  
**Inspiration:** https://www.anthropic.com/engineering/code-execution-with-mcp

## Overview

Instead of sending 933 tool definitions to the LLM on every turn (consuming ~1M tokens per query), send a single `execute_python_code` tool. The LLM writes Python code that imports CLI packages directly, executes queries and data processing locally, and only returns final results to the LLM.

**Impact:**
- **Token reduction:** ~1M → ~4K tokens per query (99.6% savings)
- **Cost reduction:** ~$30 → ~$0.12 per query (250x cheaper)
- **Speed improvement:** 30-60s → 5-10s per query
- **API coverage:** Full 933 Meraki endpoints usable (no context limits)

## Scope

**In scope:**
- Add code execution mode as opt-in per agent via `execution-mode: code` in AGENT.md
- Parallel implementation alongside existing ReACT loop (no breaking changes)
- Meraki CLI as first supported tool (others can opt-in later)
- Python sandbox with meraki_cli, pandas, json, datetime, collections
- LLM self-healing: up to 3 retry attempts on code errors
- Expandable code blocks in UI (collapsed by default)
- 30-second execution timeout

**Out of scope:**
- Advanced sandboxing (memory limits, CPU quotas) - v1 uses timeout only
- Tool discovery/search - v1 has all imports available upfront
- Persistent sessions across messages - v1 is stateless per query
- Removing/deprecating ReACT loop - kept as alternative
- Support for non-CLI tools (MCP, skills) - CLI tools only

## Architecture

### High-Level Flow

```
User: "Show me offline devices in SF network"
  ↓
Frontend: Check agent.execution_mode
  ├─ "code" → agent_code_exec_run()    [NEW]
  └─ "react" → agent_react_run()        [EXISTING]
  ↓
Rust Backend (agent_code_exec_run):
  - Load agent definition
  - Validate execution_mode == "code"
  - Load tool catalog (for CLI init, NOT sent to LLM)
  - Retrieve vault secrets
  - Call sidecar "agent.code_exec_loop"
  ↓
Python Sidecar (code_exec_loop):
  - Build sandbox: meraki_cli + pandas + stdlib
  - Send LLM single tool: execute_python_code
  - LLM writes Python code
  - Execute in sandbox (30s timeout)
  - If error: send to LLM, retry (max 3x)
  - If success: send output to LLM
  - LLM formats final answer
  ↓
Frontend: Display expandable code blocks + response
```

### Token Flow Comparison

**Current ReACT:**
```
Turn 1: User msg + 933 tools (233K tokens) → Tool call → Result
Turn 2: 933 tools + Result → Tool call → Result
Turn 3: 933 tools + Result → Tool call → Result
Turn 4: 933 tools + Result → Final answer

Input:  4 × 233K = ~1M tokens
Output: 4 × 500 = 2K tokens
Cost:   ~$30 per query
```

**Code Execution:**
```
Turn 1: User msg + 1 tool (2K tokens) → Python code
[Code executes locally - no LLM involved]
Turn 2: Code output (500 tokens) → Final answer

Input:  2K + 500 = 2.5K tokens
Output: 1K + 500 = 1.5K tokens
Cost:   ~$0.12 per query
```

## Component Designs

### 1. Agent Configuration

**AGENT.md Frontmatter:**
```yaml
---
name: meraki
description: Cisco Meraki Dashboard API expert
execution-mode: code  # NEW: "code" | "react" (default: react)
system-prompt: |
  You are a Cisco Meraki expert with Python code execution.
  
  Write Python code to answer queries using available imports:
  - meraki_cli modules: organizations, networks, devices, wireless, etc.
  - pandas (as pd) for data analysis
  - Standard library: json, datetime, collections
  
  Example query: "Show offline devices"
  ```python
  import pandas as pd
  from meraki_cli import organizations, devices
  
  # Get all devices across organizations
  orgs = organizations.list_organizations()
  all_devices = []
  for org in orgs:
      devs = devices.list_devices(org['id'])
      all_devices.extend(devs)
  
  # Filter and display
  offline = [d for d in all_devices if d['status'] == 'offline']
  print(f"Found {len(offline)} offline devices:")
  for d in offline:
      print(f"  - {d['name']} ({d['model']}): {d['serial']}")
  ```
  
  Use print() to show results. Write efficient, readable code.

attached-tools:
  - id: meraki
    catalog: tools-minimal.json  # Used for CLI initialization
    default-blast-radius-allowed: low
    vault-entry: Meraki
---
```

**Rust Type Update (`src-tauri/src/agents/types.rs`):**
```rust
pub struct Agent {
    pub id: String,
    pub name: String,
    pub description: String,
    pub system_prompt: String,
    pub execution_mode: Option<String>,  // NEW: "code" | "react"
    pub model_override: Option<ModelOverride>,
    pub attached_skills: Vec<String>,
    pub attached_mcp_servers: Vec<String>,
    pub attached_tools: Vec<AttachedTool>,
    pub allowed_commands: Vec<String>,
    pub body: String,
    pub path: PathBuf,
}

// Frontmatter parsing
pub struct AgentFrontmatter {
    // ... existing fields ...
    #[serde(default)]
    pub execution_mode: Option<String>,  // NEW
}
```

### 2. Rust Backend (Tauri Command)

**New Event Type:**
```rust
// src-tauri/src/commands/ai.rs

#[derive(Debug, Clone, serde::Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum CodeExecEvent {
    CodeStart { code: String },
    CodeExecuting,
    CodeResult { success: bool, output: String },
    CodeError { error: String, attempt: u32 },
    Final { response: String },
    Error { message: String },
}
```

**New Command:**
```rust
// src-tauri/src/commands/ai.rs

#[tauri::command]
pub async fn agent_code_exec_run(
    agent_id: String,
    message: String,
    state: State<'_, AppState>,
    on_event: tauri::ipc::Channel<CodeExecEvent>,
) -> Result<(), String> {
    // 1. Load agent
    let agent = state.agents_loader.get(&agent_id)
        .ok_or_else(|| format!("Agent '{}' not found", agent_id))?;
    
    // 2. Validate execution mode
    if agent.execution_mode.as_deref() != Some("code") {
        return Err("Agent not configured for code execution".to_string());
    }
    
    if agent.attached_tools.is_empty() {
        return Err("Agent has no attached tools".to_string());
    }
    
    // 3. Load catalog (for CLI init only)
    let tool_def = &agent.attached_tools[0];
    let catalog_path = &tool_def.catalog;
    
    // 4. Get vault secrets
    let vault_secrets = if !tool_def.vault_entry.is_empty() {
        match _retrieve_vault_secrets(&state, &tool_def.vault_entry).await {
            Ok(secrets) => Some(secrets),
            Err(e) => return Err(format!("Vault error: {}", e)),
        }
    } else {
        None
    };
    
    // 5. Call sidecar
    let params = serde_json::json!({
        "agent_id": agent_id,
        "message": message,
        "system_prompt": agent.system_prompt,
        "tool_id": tool_def.id,
        "catalog_path": catalog_path,
        "vault_entry": tool_def.vault_entry,
        "vault_secrets": vault_secrets,
    });
    
    // 6. Stream events
    let on_event_clone = on_event.clone();
    let result = state.agent.call_stream_ex("agent.code_exec_loop", params, move |ev| {
        let ev_type = ev.get("type").and_then(|v| v.as_str()).unwrap_or("");
        
        match ev_type {
            "code_start" => {
                if let Some(code) = ev.get("code").and_then(|v| v.as_str()) {
                    let _ = on_event_clone.send(CodeExecEvent::CodeStart {
                        code: code.to_string(),
                    });
                }
            }
            "code_executing" => {
                let _ = on_event_clone.send(CodeExecEvent::CodeExecuting);
            }
            "code_result" => {
                let success = ev.get("success").and_then(|v| v.as_bool()).unwrap_or(false);
                let output = ev.get("output").and_then(|v| v.as_str()).unwrap_or("").to_string();
                let _ = on_event_clone.send(CodeExecEvent::CodeResult { success, output });
            }
            "code_error" => {
                let error = ev.get("error").and_then(|v| v.as_str()).unwrap_or("").to_string();
                let attempt = ev.get("attempt").and_then(|v| v.as_u64()).unwrap_or(1) as u32;
                let _ = on_event_clone.send(CodeExecEvent::CodeError { error, attempt });
            }
            "final" => {
                if let Some(response) = ev.get("response").and_then(|v| v.as_str()) {
                    let _ = on_event_clone.send(CodeExecEvent::Final {
                        response: response.to_string(),
                    });
                }
            }
            "error" => {
                if let Some(message) = ev.get("message").and_then(|v| v.as_str()) {
                    let _ = on_event_clone.send(CodeExecEvent::Error {
                        message: message.to_string(),
                    });
                }
            }
            _ => {}
        }
        Ok(())
    }).await;
    
    result.map_err(|e| e.to_string())
}
```

**Register Command:**
```rust
// src-tauri/src/lib.rs

.invoke_handler(tauri::generate_handler![
    // ... existing commands ...
    agent_react_run,
    agent_code_exec_run,  // NEW
    // ...
])
```

### 3. Python Sidecar (Code Execution Engine)

**New File: `sidecar/src/ccie_sidecar/agents/code_exec.py`**

**Key Functions:**

```python
def _build_sandbox_globals(tool_id: str, vault_secrets: Dict[str, str]) -> Dict[str, Any]:
    """
    Build sandbox environment with allowed imports.
    
    Returns dict with:
    - Standard library: json, datetime, collections
    - Data tools: pandas (as pd)
    - CLI package: meraki_cli (initialized with vault secrets)
    """

def _execute_code_with_timeout(code: str, sandbox_globals: Dict, timeout: int = 30) -> Dict:
    """
    Execute code in sandbox with 30-second timeout.
    
    Returns:
        {
            "success": bool,
            "output": str,  # Captured from print()
            "error": str    # Traceback if failed
        }
    
    Uses signal.SIGALRM for timeout enforcement.
    """

async def code_exec_loop(
    agent_def: dict,
    user_msg: str,
    ctx: dict,
    on_event: Callable[[dict], None],
) -> None:
    """
    Main code execution loop.
    
    Flow:
    1. Build sandbox with CLI + pandas + stdlib
    2. Define execute_python_code tool
    3. Send to LLM (only 1 tool!)
    4. LLM writes code
    5. Execute with timeout
    6. If error: send to LLM with retry count (max 3)
    7. If success: send output to LLM
    8. LLM gives final answer
    9. Stream events to frontend
    
    Events emitted:
    - code_start: { code: str }
    - code_executing: {}
    - code_result: { success: bool, output: str }
    - code_error: { error: str, attempt: int }
    - final: { response: str }
    - error: { message: str }
    """
```

**Tool Definition Sent to LLM:**
```python
execute_code_tool = {
    "name": "execute_python_code",
    "description": "Execute Python code with meraki_cli package available. Use to query and analyze Meraki infrastructure. Only print() output is visible.",
    "input_schema": {
        "type": "object",
        "properties": {
            "code": {
                "type": "string",
                "description": "Python code to execute. Available: meraki_cli modules, pandas (pd), json, datetime, collections"
            }
        },
        "required": ["code"]
    }
}
```

**Error Retry Logic:**
```python
MAX_RETRY_ATTEMPTS = 3

for attempt in range(1, MAX_RETRY_ATTEMPTS + 1):
    result = _execute_code_with_timeout(code, sandbox_globals)
    
    if result["success"]:
        # Send output back to LLM
        break
    else:
        if attempt < MAX_RETRY_ATTEMPTS:
            # Ask LLM to fix code
            error_msg = f"Code failed (attempt {attempt}/{MAX_RETRY_ATTEMPTS}):\n{result['error']}\n\nFix and retry."
            # Send error as tool result, LLM will try again
        else:
            # Max retries exceeded, give up
            on_event({"type": "error", "message": f"Failed after {MAX_RETRY_ATTEMPTS} attempts"})
```

**Sandbox Security:**
```python
# v1: Simple timeout only
signal.alarm(30)  # 30-second timeout
exec(code, sandbox_globals)
signal.alarm(0)

# Future enhancements:
# - Memory limit (resource.setrlimit)
# - No file I/O (override open, io)
# - No subprocess (del subprocess from builtins)
# - Network restricted to CLI only
```

**Register Sidecar Method:**
```python
# sidecar/src/ccie_sidecar/server.py

from ccie_sidecar.agents.code_exec import code_exec_loop

# In method registration:
@jsonrpc_method("agent.code_exec_loop")
async def handle_code_exec_loop(
    agent_id: str,
    message: str,
    system_prompt: str,
    tool_id: str,
    catalog_path: str,
    vault_entry: str,
    vault_secrets: dict,
):
    agent_def = {
        "agent_id": agent_id,
        "system_prompt": system_prompt,
        "attached_tools": [{
            "id": tool_id,
            "catalog": catalog_path,
            "vault_entry": vault_entry,
            "vault_secrets": vault_secrets,
        }]
    }
    
    await code_exec_loop(
        agent_def=agent_def,
        user_msg=message,
        ctx={},
        on_event=emit_event  # Stream to frontend
    )
```

### 4. Frontend (TypeScript/React)

**TypeScript Binding (`src/lib/tauri.ts`):**
```typescript
import { Channel } from "@tauri-apps/api/core";

export type CodeExecEvent =
  | { type: "code_start"; code: string }
  | { type: "code_executing" }
  | { type: "code_result"; success: boolean; output: string }
  | { type: "code_error"; error: string; attempt: number }
  | { type: "final"; response: string }
  | { type: "error"; message: string };

export async function agentCodeExecRun(
  agentId: string,
  message: string,
  onEvent: (event: CodeExecEvent) => void
): Promise<void> {
  const channel = new Channel<CodeExecEvent>();
  channel.onmessage = onEvent;
  
  return invoke("agent_code_exec_run", {
    agentId,
    message,
    onEvent: channel,
  });
}
```

**Agent Store Update (`src/state/agentsStore.ts`):**
```typescript
export type Agent = {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
  executionMode?: "react" | "code";  // NEW
  modelOverride?: ModelOverride;
  attachedSkills: string[];
  attachedMcpServers: string[];
  attachedTools: AttachedTool[];
  allowedCommands: string[];
  body: string;
  path: string;
};
```

**AgentPanel Update (`src/components/AgentPanel.tsx`):**
```typescript
const handleSend = async (message: string) => {
  const agent = useAgentsStore.getState().agents.find(a => a.id === activeAgentId);
  
  if (agent?.executionMode === "code") {
    // Code execution mode
    await agentCodeExecRun(activeAgentId, message, (event) => {
      switch (event.type) {
        case "code_start":
          addCodeBlock({ code: event.code, collapsed: true, status: "executing" });
          break;
        case "code_result":
          updateLastCodeBlock({ 
            status: event.success ? "success" : "error",
            output: event.output 
          });
          break;
        case "code_error":
          updateLastCodeBlock({ 
            status: "retrying",
            error: event.error,
            attempt: event.attempt 
          });
          break;
        case "final":
          addMessage({ role: "assistant", content: event.response });
          break;
        case "error":
          addMessage({ role: "error", content: event.message });
          break;
      }
    });
  } else {
    // ReACT mode (existing)
    await agentReactRun(activeAgentId, message, handleReactEvent);
  }
};
```

**New Component: `CodeBlock.tsx`**
```typescript
interface CodeBlockProps {
  code: string;
  collapsed: boolean;
  status: "executing" | "success" | "error" | "retrying";
  output?: string;
  error?: string;
  attempt?: number;
}

export function CodeBlock({ code, collapsed, status, output, error, attempt }: CodeBlockProps) {
  const [isExpanded, setIsExpanded] = useState(!collapsed);
  
  const getStatusIcon = () => {
    switch (status) {
      case "executing": return "⟳";
      case "success": return "✓";
      case "error": return "✗";
      case "retrying": return `⟳ (${attempt}/3)`;
    }
  };
  
  return (
    <div className="code-execution-block">
      <div 
        className="code-header" 
        onClick={() => setIsExpanded(!isExpanded)}
        style={{ cursor: "pointer" }}
      >
        <span className={`status-${status}`}>
          {getStatusIcon()} Executed code
        </span>
        <button className="expand-btn">
          {isExpanded ? "▼" : "▶"}
        </button>
      </div>
      
      {isExpanded && (
        <div className="code-body">
          <pre className="code-content">
            <code className="language-python">{code}</code>
          </pre>
          
          {output && (
            <div className="code-output">
              <strong>Output:</strong>
              <pre>{output}</pre>
            </div>
          )}
          
          {error && (
            <div className="code-error">
              <strong>Error:</strong>
              <pre>{error}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
```

**Styling (`src/components/CodeBlock.css`):**
```css
.code-execution-block {
  margin: 8px 0;
  border: 1px solid #262a33;
  border-radius: 6px;
  background: #0a0c0f;
}

.code-header {
  padding: 8px 12px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  background: #141820;
  border-radius: 6px 6px 0 0;
}

.code-header:hover {
  background: #1a1f2e;
}

.status-executing { color: #5ccfe6; }
.status-success { color: #4ade80; }
.status-error { color: #f87171; }
.status-retrying { color: #fbbf24; }

.code-body {
  padding: 12px;
}

.code-content {
  background: #000;
  padding: 12px;
  border-radius: 4px;
  overflow-x: auto;
}

.code-output, .code-error {
  margin-top: 12px;
  padding: 8px;
  border-radius: 4px;
}

.code-output {
  background: #1a3d2a;
  border-left: 3px solid #4ade80;
}

.code-error {
  background: #3d1a1a;
  border-left: 3px solid #f87171;
}
```

## Data Flow

### Successful Execution
```
User: "Show offline devices"
  ↓
Frontend → agent_code_exec_run("meraki", message)
  ↓
Rust → sidecar "agent.code_exec_loop"
  ↓
Python:
  - Build sandbox (meraki_cli loaded)
  - Call LLM with execute_python_code tool
  ↓
LLM writes code:
  ```python
  orgs = meraki.organizations.list()
  devices = meraki.devices.list(orgs[0]['id'])
  offline = [d for d in devices if d['status'] == 'offline']
  print(f"Found {len(offline)} offline devices")
  ```
  ↓
Python executes code (2 seconds)
  Output: "Found 5 offline devices"
  ↓
Python sends output back to LLM
  ↓
LLM: "There are 5 offline devices in your organization..."
  ↓
Frontend displays:
  [Code Block - collapsed] ✓ Executed code
  [Response] There are 5 offline devices...
```

### Error with Retry
```
User: "Show device statuses"
  ↓
LLM writes code with typo:
  ```python
  devices = meraki.devices.list(org_id)  # org_id not defined!
  ```
  ↓
Execution fails:
  NameError: name 'org_id' is not defined
  ↓
Python sends error to LLM (attempt 1/3)
  ↓
LLM fixes code:
  ```python
  orgs = meraki.organizations.list()
  devices = meraki.devices.list(orgs[0]['id'])
  ```
  ↓
Execution succeeds
  Output: "Found 42 devices"
  ↓
LLM formats response
  ↓
Frontend displays:
  [Code Block] ⟳ (1/3) Executed code [collapsed]
  [Code Block] ✓ Executed code [collapsed]
  [Response] You have 42 devices...
```

## Testing Strategy

### Unit Tests

**Python Sandbox (`test_code_exec.py`):**
```python
def test_sandbox_has_required_imports():
    globals = _build_sandbox_globals("meraki", {"meraki_api_key": "test"})
    assert "json" in globals
    assert "pd" in globals
    assert "meraki" in globals

def test_execute_code_success():
    result = _execute_code_with_timeout("print('hello')", {})
    assert result["success"] is True
    assert "hello" in result["output"]

def test_execute_code_timeout():
    code = "import time; time.sleep(60)"
    result = _execute_code_with_timeout(code, {}, timeout=1)
    assert result["success"] is False
    assert "Timeout" in result["error"]

def test_execute_code_error():
    result = _execute_code_with_timeout("1/0", {})
    assert result["success"] is False
    assert "ZeroDivisionError" in result["error"]
```

**Rust Command (`tests/code_exec_tests.rs`):**
```rust
#[tokio::test]
async fn test_agent_code_exec_run_validates_mode() {
    // Agent with execution_mode: "react" should fail
    let result = agent_code_exec_run(...).await;
    assert!(result.is_err());
}

#[tokio::test]
async fn test_agent_code_exec_run_requires_tools() {
    // Agent with no attached_tools should fail
    let result = agent_code_exec_run(...).await;
    assert!(result.is_err());
}
```

### Integration Tests

**End-to-End Flow:**
1. Create test agent with `execution-mode: code`
2. Send message "list organizations"
3. Verify code_start event received
4. Verify code_result event received
5. Verify final response contains organization data

**Error Recovery:**
1. Mock LLM to return bad code (missing variable)
2. Verify code_error event with attempt=1
3. Mock LLM to return fixed code
4. Verify code_result with success=true

### Manual Testing Checklist

- [ ] Create Meraki agent with `execution-mode: code`
- [ ] Send simple query: "list my organizations"
- [ ] Verify code block appears (collapsed)
- [ ] Click to expand, see Python code
- [ ] Verify response is correct
- [ ] Send query that causes error (e.g., "show device with id 'invalid'")
- [ ] Verify retry indicator shows attempt count
- [ ] Verify LLM fixes code and succeeds
- [ ] Test with existing ReACT agent, verify still works
- [ ] Test switching agent between code and react mode

## Migration Plan

### Phase 1: MVP Implementation (Week 1)

**Day 1-2: Backend**
- Add `execution_mode` field to Agent types
- Implement `agent_code_exec_run` Tauri command
- Register command in invoke_handler

**Day 3-4: Sidecar**
- Create `code_exec.py` module
- Implement `code_exec_loop` function
- Implement sandbox builder and executor
- Register sidecar method

**Day 5: Frontend**
- Add TypeScript bindings
- Update AgentPanel to check execution_mode
- Create basic CodeBlock component (no styling yet)
- Wire up event handlers

**Day 6-7: Testing & Polish**
- Write unit tests
- Manual testing with Meraki agent
- Basic styling for code blocks
- Bug fixes

### Phase 2: Production Hardening (Week 2)

**Day 8-9: UI Polish**
- Improve CodeBlock styling
- Add syntax highlighting (highlight.js or prism)
- Smooth expand/collapse animations
- Status icons and colors

**Day 10-11: Error Handling**
- Better error messages
- Timeout display in UI
- Retry progress indicator
- Graceful degradation

**Day 12: Documentation**
- Update agent creation guide
- Add code execution examples
- Document execution-mode config
- Update troubleshooting guide

**Day 13-14: Rollout**
- Convert meraki agent to code mode
- Monitor performance and costs
- Gather user feedback
- Iterate based on feedback

### Phase 3: Enhancements (Week 3+)

**Optional improvements:**
- Tool search/discovery (`search_meraki_tools`)
- Persistent sessions (variables survive between queries)
- Advanced sandboxing (memory/CPU limits)
- Support for other CLI packages
- Code approval before execution (security mode)

## Success Metrics

**Performance:**
- ✅ Token reduction: >95% (target: ~1M → ~4K)
- ✅ Cost reduction: >90% (target: ~$30 → ~$0.12)
- ✅ Latency reduction: >50% (target: 30-60s → 5-10s)

**Reliability:**
- ✅ Code execution success rate: >85% on first attempt
- ✅ Self-healing success rate: >95% within 3 attempts
- ✅ Zero timeout issues on normal queries

**User Experience:**
- ✅ Users can answer complex queries previously impossible
- ✅ Code blocks are understandable to non-programmers
- ✅ No regressions in existing ReACT agents

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| **LLM writes buggy code** | - LLM can see error and retry (3 attempts)<br>- Good examples in system prompt<br>- Test with multiple query types |
| **Code execution too slow** | - 30s timeout prevents hangs<br>- Most queries complete in <5s<br>- Can optimize sandbox init if needed |
| **Security: malicious code** | - v1: Timeout only (trusted environment)<br>- Future: Full sandbox (no file I/O, network, subprocess)<br>- Only runs user's own CLI with their credentials |
| **Less transparent than ReACT** | - Code blocks are expandable<br>- Show execution status<br>- Better than tool calls for complex queries |
| **Model struggles with code** | - Works well with Opus/Sonnet 4<br>- Good system prompt with examples<br>- Can fall back to ReACT mode if needed |
| **Breaking existing agents** | - Parallel implementation (no breaking changes)<br>- Opt-in via execution-mode<br>- ReACT remains default |

## Future Enhancements

**Tool Discovery (v2):**
```python
# LLM can search for relevant tools
tools = search_meraki_tools("wireless ssid")
# Returns: ['wireless.list_ssids', 'wireless.get_ssid', 'wireless.update_ssid']
```

**Persistent Sessions (v2):**
```python
# Variables survive between queries
# Query 1: "Get all devices"
devices = meraki.devices.list(...)  # Saved in session

# Query 2: "Filter those to switches"
switches = [d for d in devices if d['model'].startswith('MS')]
```

**Advanced Sandboxing (v3):**
```python
# Resource limits
resource.setrlimit(resource.RLIMIT_AS, (500 * 1024 * 1024, -1))  # 500MB
resource.setrlimit(resource.RLIMIT_CPU, (10, -1))  # 10 CPU seconds

# Restrict dangerous operations
sandbox_globals['__builtins__']['open'] = None  # No file I/O
sandbox_globals['__builtins__']['eval'] = None  # No eval
```

**Other CLI Tools (v3):**
- AWS CLI (boto3)
- Kubernetes (kubectl via Python client)
- Terraform (via subprocess, read-only)

## Conclusion

Code execution pattern fundamentally solves the CLI context problem:

**Current state:**
- Meraki agents use 10-tool catalog (good)
- But each tool is 200-300 tokens
- Sent on every ReACT turn (4-8 turns per query)
- Total: 10K-50K tokens per query

**With code execution:**
- Send 1 tool definition (200 tokens)
- LLM writes code once
- Code executes locally (no LLM)
- Total: 2K-4K tokens per query

This is a 10-25x improvement over current best case, and a 250x improvement if we used the full 933-tool catalog.

**Bottom line:** Code execution makes CLI tools strictly superior to MCP for stable, well-documented APIs like Meraki.

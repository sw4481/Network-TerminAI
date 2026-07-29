# Code Execution Pattern for CLI Tools - Inspired by Anthropic's MCP Approach

**Date:** 2026-05-27  
**Reference:** https://www.anthropic.com/engineering/code-execution-with-mcp

## The Paradigm Shift

### Current Approach (ReACT Loop)
```
User: "Show me offline devices in my SF office network"

LLM Turn 1: [Receives 933 tool definitions]
→ Thought: "I need to list organizations"
→ Tool: meraki.organizations.list()
→ Result: 3 organizations (all returned to LLM)

LLM Turn 2: [Receives 933 tool definitions again]
→ Thought: "I need networks for org_123"  
→ Tool: meraki.networks.list(org_123)
→ Result: 50 networks (all returned to LLM)

LLM Turn 3: [Receives 933 tool definitions again]
→ Thought: "SF office is network N_456"
→ Tool: meraki.devices.list(N_456)
→ Result: 100 devices (all returned to LLM)

LLM Turn 4: [Receives 933 tool definitions again]
→ Thought: "Filter for status='offline'"
→ Final: 5 offline devices

Total tokens: 4 turns × (933 tools + results) = ~1M tokens
```

### Code Execution Approach (Anthropic Pattern)
```
User: "Show me offline devices in my SF office network"

LLM Turn 1: [Receives NO tool definitions, just code execution capability]
→ Writes Python code:
   ```python
   # Discover what's available
   tools = search_meraki_tools("devices offline network")
   # tools = ['list_organizations', 'list_networks', 'list_devices']
   
   # Import only what we need
   from meraki_cli import list_organizations, list_networks, list_devices
   
   # Execute logic in code (NO round trips to LLM)
   orgs = list_organizations()
   networks = list_networks(org_id=orgs[0]['id'])
   sf_network = [n for n in networks if 'SF' in n['name']][0]
   devices = list_devices(network_id=sf_network['id'])
   offline = [d for d in devices if d['status'] == 'offline']
   
   # Only final result goes back to LLM
   print(offline)
   ```

LLM Turn 2: [Sees only final result]
→ Final: 5 offline devices

Total tokens: 1 turn + code + result = ~5K tokens (200x reduction!)
```

## Key Architectural Changes

### 1. Replace Tool Catalog with Code API Discovery

**Instead of sending tool definitions:**
```json
// DON'T send this (233K tokens for 933 tools)
[
  {
    "name": "meraki.organizations.list",
    "description": "List all organizations...",
    "parameters": {...}
  },
  // ... 932 more
]
```

**Send code discovery capability:**
```python
# Minimal tool (single tool definition)
{
  "name": "search_meraki_tools",
  "description": "Search Meraki CLI tools by keyword or category",
  "parameters": {
    "query": "string",
    "detail_level": "name_only|with_description|full_schema"
  }
}

# Or filesystem-based discovery
{
  "name": "list_directory", 
  "description": "List available tools",
  "parameters": {"path": "meraki/"}
}
```

### 2. Execution Environment with CLI Integration

**New Component: Code Sandbox**
```
┌─────────────────────────────────────────────────────┐
│                   Frontend (Tauri)                  │
└──────────────────┬──────────────────────────────────┘
                   │
┌──────────────────▼──────────────────────────────────┐
│                 Rust Backend                        │
│  • Handles user message                             │
│  • Calls LLM with single "execute_code" tool        │
│  • Receives Python code back                        │
└──────────────────┬──────────────────────────────────┘
                   │
┌──────────────────▼──────────────────────────────────┐
│            Python Code Sandbox (Sidecar)            │
│  ┌───────────────────────────────────────────────┐  │
│  │  Execution Context                            │  │
│  │  • Import meraki_cli                          │  │
│  │  • Filter/process data in Python              │  │
│  │  • Only print() goes back to LLM              │  │
│  └───────────────────────────────────────────────┘  │
│                                                      │
│  ┌───────────────────────────────────────────────┐  │
│  │  CLI Bridge                                   │  │
│  │  • list_organizations() → meraki CLI          │  │
│  │  • list_networks() → meraki CLI               │  │
│  │  • All 933 endpoints available via import     │  │
│  └───────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────┘
```

### 3. Token Flow Comparison

**Current ReACT:**
```
Turn 1: User message + 933 tools → LLM → Tool call → Result
Turn 2: 933 tools + Result → LLM → Tool call → Result  
Turn 3: 933 tools + Result → LLM → Tool call → Result
Turn 4: 933 tools + Result → LLM → Final answer

Input tokens:  4 × 233K (tools) + results = ~1M tokens
Output tokens: 4 × 500 (reasoning) = 2K tokens
```

**Code Execution:**
```
Turn 1: User message + 1 tool (execute_code) → LLM → Python code
[Code executes locally, 3 CLI calls, filters data]
Turn 2: Only filtered result → LLM → Final answer

Input tokens:  1 × 2K (tool) + 500 (result) = 2.5K tokens
Output tokens: 1 × 1K (code) + 500 (answer) = 1.5K tokens
```

**Savings: 99.7% reduction in input tokens**

## Implementation Architecture

### Phase 1: Minimal Code Execution

**New Sidecar Method:**
```python
# sidecar/src/ccie_sidecar/agents/code_exec.py

async def execute_code_loop(
    agent_def: dict,
    user_msg: str,
    ctx: dict,
    on_event: Callable[[dict], None],
) -> None:
    """
    Execute LLM-generated code with CLI tool access.
    
    Similar to react_loop but:
    - Sends only 1 tool: execute_python_code
    - LLM writes code that imports CLI tools
    - Code executes in sandbox with meraki-cli available
    - Only print() output goes back to LLM
    """
    
    # 1. Load CLI tools for sandbox (NOT for LLM)
    tool_attachment = agent_def["attached_tools"][0]
    catalog = load_catalog(tool_attachment["catalog"])
    meraki_client = initialize_meraki_client(...)
    
    # 2. Define sandbox environment
    sandbox_globals = {
        "meraki": meraki_client,  # Full CLI available to code
        "print": custom_print_fn,  # Capture output
    }
    
    # 3. Send minimal tool to LLM
    execute_code_tool = {
        "name": "execute_python_code",
        "description": "Execute Python code with access to meraki-cli",
        "input_schema": {
            "type": "object",
            "properties": {
                "code": {"type": "string", "description": "Python code to execute"}
            }
        }
    }
    
    # 4. LLM loop
    messages = [{"role": "user", "content": user_msg}]
    
    while True:
        response = call_llm_with_tools(
            provider=provider,
            messages=messages,
            tools=[execute_code_tool],  # Only 1 tool!
            system_prompt=agent_def["system_prompt"] + CODE_EXEC_INSTRUCTIONS
        )
        
        if response["stop_reason"] == "end_turn":
            break
            
        # Execute code in sandbox
        for block in response["content"]:
            if block["type"] == "tool_use":
                code = block["input"]["code"]
                
                on_event({"type": "code_start", "code": code})
                
                try:
                    output = execute_in_sandbox(code, sandbox_globals)
                    on_event({"type": "code_result", "output": output})
                    
                    # Only output goes back to LLM
                    messages.append({
                        "role": "user",
                        "content": f"Code output:\n{output}"
                    })
                except Exception as e:
                    on_event({"type": "code_error", "error": str(e)})
                    messages.append({
                        "role": "user", 
                        "content": f"Error: {e}"
                    })
```

**System Prompt Addition:**
```python
CODE_EXEC_INSTRUCTIONS = """
You have access to the Meraki Dashboard API via the `meraki` Python client.

Available via import (examples):
- meraki.organizations.get_organization(org_id)
- meraki.organizations.list_networks(org_id)  
- meraki.devices.list_devices(network_id)
- meraki.wireless.list_ssids(network_id)
# ... full API available

Write Python code to answer the user's question. Use:
- Standard Python (loops, filters, comprehensions)
- meraki.* methods for API calls
- print() to return results (only printed output is visible)

Example:
```python
# Get all offline devices in SF networks
orgs = meraki.organizations.list_organizations()
org = orgs[0]

networks = meraki.organizations.list_networks(org['id'])
sf_networks = [n for n in networks if 'SF' in n['name']]

for network in sf_networks:
    devices = meraki.devices.list_devices(network['id'])
    offline = [d for d in devices if d['status'] == 'offline']
    if offline:
        print(f"Network {network['name']}: {len(offline)} offline")
        for device in offline:
            print(f"  - {device['name']}: {device['model']}")
```

Be efficient: fetch only what you need, filter in code, print concise results.
"""
```

### Phase 2: Tool Discovery (Optional Enhancement)

**Add search capability:**
```python
def search_meraki_tools(query: str, detail_level: str = "name_only"):
    """
    Search Meraki CLI catalog for relevant tools.
    
    Args:
        query: Keywords like "ssid wireless", "firewall rules", "offline devices"
        detail_level: "name_only" | "with_description" | "full_schema"
    
    Returns:
        Matching tool definitions at requested detail level
    """
    catalog = load_full_catalog()  # 933 tools
    
    # Simple keyword search
    matches = [
        tool for tool in catalog
        if any(word in tool["name"].lower() or word in tool.get("description", "").lower()
               for word in query.lower().split())
    ]
    
    # Format based on detail level
    if detail_level == "name_only":
        return [{"name": t["name"]} for t in matches]
    elif detail_level == "with_description":
        return [{"name": t["name"], "description": t["description"]} for t in matches]
    else:
        return matches  # Full schema
```

Add as second tool:
```python
search_tools = {
    "name": "search_meraki_tools",
    "description": "Search available Meraki API tools by keyword",
    "input_schema": {
        "type": "object",
        "properties": {
            "query": {"type": "string"},
            "detail_level": {"type": "string", "enum": ["name_only", "with_description", "full_schema"]}
        }
    }
}

tools = [execute_code_tool, search_tools]
```

### Phase 3: Stateful Sessions (Advanced)

**Persistent sandbox state:**
```python
# Keep sandbox alive between messages
class CodeExecutionSession:
    def __init__(self, agent_def):
        self.globals = {"meraki": initialize_meraki_client(...)}
        self.conversation_history = []
        
    def execute(self, code: str):
        """Execute code in persistent namespace"""
        exec(code, self.globals)
        # Variables persist between executions
        
    def get_variable(self, name: str):
        """Access variable from previous execution"""
        return self.globals.get(name)
```

User can say: "Now filter those results to show only switches" and code can reference variables from previous execution.

## Benefits

### 1. Massive Token Savings
- **Current**: ~1M tokens per query (4 turns × 250K)
- **Code execution**: ~4K tokens per query (1-2 turns × 2K)
- **Savings**: 99.6% reduction
- **Cost impact**: $30/query → $0.12/query (250x cheaper!)

### 2. Faster Responses
- Current: 4+ LLM calls (30-60 seconds)
- Code execution: 1-2 LLM calls (5-10 seconds)
- Code execution is instant (milliseconds)

### 3. More Powerful Queries
Code can do things ReACT loop can't:
```python
# Complex filtering impossible in ReACT
devices = []
for net in networks:
    devs = meraki.devices.list_devices(net['id'])
    # Aggregate across networks
    devices.extend([d for d in devs if d['model'].startswith('MS') and d['status'] == 'online'])
    
# Group by firmware version
from collections import defaultdict
by_firmware = defaultdict(list)
for d in devices:
    by_firmware[d['firmware']].append(d)
    
# Print summary
for fw, devs in sorted(by_firmware.items()):
    print(f"{fw}: {len(devs)} devices")
```

### 4. Full API Access Without Context Limit
- Can use all 933 endpoints
- Tools discovered/imported on-demand
- No upfront cost for unused tools

### 5. Privacy/Security Benefits
- Sensitive data filtered in code
- Can implement same tokenization as Anthropic
- PII never enters model context

## Migration Path

### Stage 1: Proof of Concept (1-2 days)
1. Add `execute_python_code` tool to existing ReACT loop
2. Test with simple queries
3. Measure token savings

### Stage 2: Code-First Mode (1 week)
1. Create `code_exec_loop` as alternative to `react_loop`
2. Add agent setting: `execution_mode: react|code`
3. Update UI to show code execution vs tool calls

### Stage 3: Enhanced Discovery (2 weeks)
1. Implement `search_meraki_tools`
2. Add filesystem-based discovery (optional)
3. Tool usage analytics to improve search

### Stage 4: Production Hardening (2 weeks)
1. Sandbox security (resource limits, timeout, isolation)
2. Error handling and recovery
3. Persistent sessions
4. Performance optimization

## Risks & Mitigations

| Risk | Mitigation |
|------|-----------|
| **LLM writes buggy code** | - Catch exceptions, show to LLM for fix<br>- Provide good examples in system prompt<br>- Validate code before execution |
| **Infinite loops** | - Execution timeout (30 seconds)<br>- Step limit in sandbox<br>- Rate limiting on API calls |
| **Security: code injection** | - Restricted sandbox (no file I/O, network, subprocess)<br>- Only whitelisted imports<br>- Resource limits (memory, CPU) |
| **Less interpretable than ReACT** | - Stream code to UI before execution<br>- Show execution progress<br>- Option to approve code before run |
| **Model may struggle with code** | - Works best with Opus/GPT-4<br>- Provide good examples<br>- Fallback to ReACT if code fails |

## Comparison: ReACT vs Code Execution

| Aspect | ReACT Loop | Code Execution |
|--------|-----------|----------------|
| **Input tokens/query** | ~1M (933 tools × 4 turns) | ~4K (1 tool × 2 turns) |
| **Cost** | $30 | $0.12 |
| **Speed** | 30-60 sec | 5-10 sec |
| **API coverage** | Limited by catalog | All 933 endpoints |
| **Complex logic** | Hard (multiple turns) | Easy (native code) |
| **Interpretability** | High (see each step) | Medium (see code + output) |
| **Error recovery** | Automatic (retry) | Manual (LLM fixes code) |
| **Security** | Safe (pre-defined tools) | Needs sandbox |
| **Best for** | Simple queries, audit trail | Complex queries, efficiency |

## Recommendation

**Implement Code Execution Pattern:**

1. **Short term** (now): Keep ReACT for simple queries, add code execution as experiment
2. **Medium term** (1-2 months): Make code execution default, ReACT as fallback
3. **Long term** (3-6 months): Full code execution with discovery, deprecate ReACT for CLI tools

**Why:**
- 250x cost reduction is massive
- Enables full API access (933 tools)
- Aligns with Anthropic's best practices
- Makes CLI approach clearly superior to MCP

This is the **correct long-term architecture** for CLI tool integration.

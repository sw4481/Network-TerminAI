# CLI Tool Context Optimization Analysis

**Date:** 2026-05-27  
**Problem:** Meraki agent with 933 CLI tools consumes excessive context, defeating the purpose of using CLI over MCP

## Current Architecture

### How It Works Now

1. **Agent Definition** (`~/.ccie-terminal/agents/meraki/AGENT.md`):
   ```yaml
   attached-tools:
     - id: meraki
       catalog: tools-minimal.json  # Points to tool catalog
       default-blast-radius-allowed: low
       vault-entry: Meraki
   ```

2. **Tool Catalogs** (discovered 3 variants):
   - `tools.json` - **933 tools** (~34K lines) - FULL Meraki Dashboard API
   - `tools-essential.json` - **356 tools** (~13K lines) - Essential operations
   - `tools-minimal.json` - **10 tools** (~479 lines) - Core read-only operations

3. **Current Flow**:
   ```
   User message
   → agent_react_run (Rust)
   → Loads agent definition
   → Reads catalog file (entire JSON)
   → Sends entire catalog to Python sidecar
   → react_loop converts ALL tools for LLM
   → LLM receives 10-933 tools in EVERY message
   ```

4. **Context Impact**:
   - **10 tools (minimal)**: ~2-3K tokens per message
   - **356 tools (essential)**: ~30-50K tokens per message  
   - **933 tools (full)**: ~80-120K tokens per message
   - This is sent with EVERY LLM call in the ReACT loop (8-12 calls per query)

## The Problem

**Why CLI Over MCP?**
- MCP was designed for dynamic tool discovery with large tool sets
- CLI was meant for static, pre-curated tool lists to save context
- **Current implementation defeats this** by sending massive catalogs

**Why This Hurts:**
- Context window waste (tools sent every turn in ReACT loop)
- Higher costs (context tokens are ~50% of cost)
- Slower responses (more tokens to process)
- Can't use full Meraki API without hitting context limits

## Evaluation of Solutions

### Option 1: Dynamic Tool Loading (MCP-Style for CLI)

**Approach:** Load tools on-demand based on user intent

```rust
// Instead of loading entire catalog upfront
let catalog = load_full_catalog();

// Load tools dynamically per message
let relevant_tools = select_tools_for_query(user_message, catalog);
// Send only 5-15 tools to LLM
```

**Pros:**
- Best context efficiency (5-15 tools vs 933)
- Can use full API without context explosion
- Most flexible for complex queries

**Cons:**
- Requires intent classification (another LLM call or embeddings)
- May miss relevant tools if classifier is wrong
- Adds latency (classification step)
- Complex to implement correctly

**Verdict:** ❌ **Too complex** - This is essentially reinventing MCP's tool discovery. If you need dynamic selection, just use MCP.

---

### Option 2: Hierarchical Tool System (5 Meta-Tools)

**Approach:** Expose 5 high-level tools that internally dispatch to specific operations

```json
[
  {
    "name": "meraki.list",
    "description": "List resources (organizations, networks, devices, clients, etc.)",
    "parameters": {
      "resource_type": "organization|network|device|client|...",
      "parent_id": "...",
      "filters": {...}
    }
  },
  {
    "name": "meraki.get",
    "description": "Get details of a specific resource",
    "parameters": {...}
  },
  {
    "name": "meraki.update",
    "description": "Update resource configuration",
    "parameters": {...}
  },
  {
    "name": "meraki.create",
    "description": "Create new resource",
    "parameters": {...}
  },
  {
    "name": "meraki.delete",
    "description": "Delete resource",
    "parameters": {...}
  }
]
```

**Implementation:**
```python
def execute_meraki_list(resource_type, parent_id, filters):
    # Map resource_type to specific CLI command
    if resource_type == "organizations":
        return meraki.organizations.list()
    elif resource_type == "networks":
        return meraki.organizations.list_networks(org_id=parent_id)
    # ... 933 endpoints mapped internally
```

**Pros:**
- Minimal context (5 tools always)
- LLM learns one consistent interface
- Easy to extend (add new endpoints without changing tools)
- Works with any CLI package (not Meraki-specific)

**Cons:**
- Requires LLM to specify resource types correctly
- Generic error messages (harder to debug)
- May need multiple roundtrips for discovery ("list networks" → "get network N_123")
- Loses per-endpoint documentation specificity

**Verdict:** ⚠️ **Workable but suboptimal** - Too generic, loses the value of rich per-endpoint descriptions.

---

### Option 3: Tiered Catalogs with Lazy Loading

**Approach:** Start with minimal catalog, expand on-demand via special "load_more_tools" capability

**Initial Load (10 tools - minimal):**
```json
[
  {
    "name": "meraki.organizations.list",
    "description": "List all organizations...",
    ...
  },
  ...
  {
    "name": "meraki.load_more_tools",
    "description": "Load additional Meraki tools for specific categories",
    "parameters": {
      "category": "ssids|vlans|firewall|switching|wireless|security|..."
    }
  }
]
```

**Flow:**
1. User: "Show me all SSIDs"
2. LLM: Calls `meraki.load_more_tools(category="ssids")`
3. Backend: Returns 10-20 SSID-related tools
4. LLM: Now has SSID tools, calls `meraki.wireless.list_ssids()`

**Pros:**
- Start minimal (10 tools)
- Expand only when needed
- Preserves rich per-endpoint docs
- No upfront classification needed
- LLM discovers what it needs

**Cons:**
- Requires extra roundtrip for tool loading
- LLM must know when to load more tools
- Catalog categories need manual curation
- Tools "disappear" after conversation (unless cached)

**Verdict:** ⚠️ **Interesting but adds complexity** - Extra roundtrip is a UX hit.

---

### Option 4: Curated Catalog Tiers (Recommended)

**Approach:** Maintain hand-curated catalogs for common use cases, agent admin selects tier

**Catalog Tiers:**
```
tools-minimal.json (10 tools):
- List organizations
- List networks  
- List devices
- Get device details
- List clients
→ Use case: Basic monitoring, read-only access

tools-core.json (30-50 tools):
- Minimal +
- Network settings (timezone, name, tags)
- SSID management (list, get, enable/disable)
- Basic device config (name, tags, notes)
- Client details
→ Use case: Common admin tasks

tools-extended.json (100-150 tools):
- Core +
- VLANs, firewall rules
- Switch port config
- Group policies
- Content filtering
→ Use case: Network configuration

tools-full.json (933 tools):
- Everything
→ Use case: Advanced automation, full API access
```

**Agent Config:**
```yaml
attached-tools:
  - id: meraki
    catalog: tools-core.json  # ← Admin picks tier
    default-blast-radius-allowed: low
    vault-entry: Meraki
```

**Pros:**
- ✅ Simple - no runtime complexity
- ✅ Explicit - admin knows what agent can do
- ✅ Flexible - different agents can use different tiers
- ✅ Optimal context - only pay for what you use
- ✅ Preserves rich docs - each tool fully described
- ✅ Easy fallback - if stuck, agent says "I need X catalog"

**Cons:**
- Requires manual catalog maintenance
- Agent can't access tools outside its tier
- User must know which tier they need

**Verdict:** ✅ **RECOMMENDED** - Best balance of simplicity, efficiency, and flexibility.

---

### Option 5: Just Use MCP

**Approach:** Stop using CLI packages entirely, convert to MCP servers

**Why CLI was chosen originally:**
- Pre-packaged tool definitions
- Simpler than MCP server setup
- Direct Python package integration

**Why MCP might be better:**
- Designed for large tool sets
- Dynamic tool discovery built-in
- Tool filtering by capability
- Richer tool metadata

**Verdict:** ⚠️ **Only if CLI approach fails** - CLI has advantages (packaging, simplicity), exhaust those first.

---

## Recommendation: Curated Tiers (Option 4)

### Implementation Plan

**Phase 1: Create Catalog Tiers**

1. **Analyze current usage patterns** (if logs available)
   - Which endpoints are actually called?
   - What does the 80/20 look like?

2. **Create tiered catalogs**:
   ```bash
   # Extract from tools.json
   tools-minimal.json      # 10 tools - basic reads
   tools-core.json         # 30-50 tools - common admin
   tools-extended.json     # 100-150 tools - advanced config
   tools-full.json         # 933 tools - everything
   ```

3. **Categorization guidelines**:
   - **Minimal**: Org/network/device/client listing + basic gets
   - **Core**: Minimal + SSID management + basic device config
   - **Extended**: Core + VLANs + firewall + switching + group policies
   - **Full**: Everything (for automation/advanced use)

**Phase 2: Update Agent System**

No code changes needed! Current architecture already supports this:
- Agent already references `catalog: tools-minimal.json`
- Just create the other tiers
- Users pick tier when creating/editing agents

**Phase 3: Documentation**

Update agent documentation:
- Explain catalog tiers
- Guide users on choosing tiers
- Provide tier comparison table
- Show how to change tier if needed

**Phase 4: Future Optimization (Optional)**

If even core tier is too large:
- Add "recommended tier" hint to agent creation UI
- Tool usage analytics to refine tiers
- Per-conversation tool caching (if provider supports)

---

## Context Math

**Current (tools-minimal.json):**
- 10 tools × ~250 tokens/tool = 2,500 tokens
- ReACT loop: 10 turns × 2,500 = 25,000 tokens just for tools
- ✅ Acceptable

**If using tools-core.json:**
- 50 tools × ~250 tokens/tool = 12,500 tokens  
- ReACT loop: 10 turns × 12,500 = 125,000 tokens
- ⚠️ Getting expensive, but doable with Claude Opus 4

**If using tools-full.json:**
- 933 tools × ~250 tokens/tool = 233,250 tokens
- ReACT loop: 10 turns × 233,250 = 2,332,500 tokens
- ❌ Exceeds most context windows, extremely expensive

**With tool caching (Anthropic):**
- First turn: Pay full context
- Subsequent turns: Cached (95% savings)
- Even full catalog becomes viable: 233K → 11K per turn

**Recommendation:**
1. **Now**: Use minimal (10 tools) for simple agents, core (50 tools) for admin agents
2. **Future**: Implement tool caching to make full catalog viable

---

## Action Items

1. ✅ Keep current `tools-minimal.json` as default (10 tools)
2. 🔄 Create `tools-core.json` (~50 tools) for common admin tasks
3. 🔄 Create `tools-extended.json` (~150 tools) for advanced config
4. 🔄 Keep `tools-full.json` as-is (933 tools) for power users
5. 📝 Document catalog tiers in agent README
6. 📝 Add tier selection guidance to UI
7. 🔮 Future: Implement Anthropic prompt caching for tool catalogs

---

## Comparison to MCP

| Aspect | CLI + Tiered Catalogs | MCP Server |
|--------|----------------------|------------|
| **Setup complexity** | Low (just JSON files) | Medium (server process) |
| **Context efficiency** | Manual tiers | Dynamic filtering |
| **Tool maintenance** | Update JSON files | Update server code |
| **Discoverability** | Static catalog | Dynamic discovery |
| **Best for** | Curated, stable APIs | Large, evolving APIs |

**Verdict:** CLI + Tiered Catalogs is the right choice for Meraki. The API is stable, tool needs are predictable, and manual curation provides better UX than dynamic discovery.

---

## Conclusion

**Recommended approach:** Curated Catalog Tiers (Option 4)

1. Already partially implemented (tools-minimal.json exists and is used)
2. Zero code changes needed (architecture supports it)
3. Just create 2-3 more tier files
4. Document and guide users
5. Consider tool caching for future optimization

This maintains CLI's simplicity advantage over MCP while solving the context explosion problem.

# DeepAgents Cutover Guide

This document describes how to enable DeepAgents for agents and eventually flip the default.

---

## Current Status (Phase 5)

**Default Engine:** `legacy` (hand-rolled ReAct loops)  
**Available Engine:** `deepagents` (LangChain/LangGraph with middleware)

All DeepAgents infrastructure is complete and tested:
- ✅ Provider factory (Seam 1)
- ✅ Streaming bridge (Seam 2)  
- ✅ HITL approval (Seam 3)
- ✅ Planning middleware (TodoList)
- ✅ SubAgent middleware
- ✅ RubricMiddleware (optional, beta)

---

## How to Enable DeepAgents for an Agent

Add `engine: deepagents` to the agent's AGENT.md frontmatter:

```yaml
---
name: meraki
description: Cisco Meraki Dashboard API agent
engine: deepagents  # <-- Add this line
execution_mode: react
default_blast_radius_allowed: low
---
```

### Agent Frontmatter Fields

| Field | Values | Description |
|-------|--------|-------------|
| `engine` | `deepagents` \| `legacy` \| (omit) | Which execution engine to use. Defaults to `legacy` if omitted. |
| `execution_mode` | `react` \| `code-exec` \| `react-code` | Which loop type (unchanged) |
| `default_blast_radius_allowed` | `low` \| `medium` \| `high` \| `destructive` | HITL approval threshold |

---

## Cutover Steps (Gradual Rollout)

### Step 1: Enable for One Agent (Low Risk)
**Target:** Meraki agent  
**Why:** Most heavily used, best tested, most to gain from planning/subagents

```bash
# Edit bundled-agents/meraki/AGENT.md
# Add: engine: deepagents

git commit -m "feat(meraki): enable DeepAgents engine"
```

**Test:**
- Verify planning works (agent calls write_todos)
- Verify Meraki tools execute correctly
- Verify drawio diagrams render
- Monitor for any regressions

**Rollback:** Remove `engine: deepagents` line

---

### Step 2: Enable for All Bundled Agents
**Agents:** meraki, pyats

```bash
# Edit both bundled-agents/meraki/AGENT.md and bundled-agents/pyats/AGENT.md
# Add: engine: deepagents

git commit -m "feat(agents): enable DeepAgents for all bundled agents"
```

**Test:**
- Run full agent test suite
- Manual E2E testing for both agents
- Check for performance regressions

---

### Step 3: Flip Default (Breaking Change)
**When:** After Step 2 soaks for 1-2 weeks with no issues

**Change server.py:**

```python
# Current (Phase 5):
engine = params.get("engine")  # None means legacy
if engine == "deepagents":
    # DeepAgents path
else:
    # Legacy path (DEFAULT)

# After flip:
engine = params.get("engine", "deepagents")  # Default to deepagents
if engine == "legacy":
    # Legacy path (opt-in only)
else:
    # DeepAgents path (DEFAULT)
```

**Migration for Custom Agents:**
User-created agents without `engine:` field will use deepagents.
If users want legacy behavior, they must add `engine: legacy` explicitly.

---

### Step 4: Deprecate Legacy
**When:** 1-2 months after Step 3, zero reported issues

**Mark legacy deprecated:**
```python
if engine == "legacy":
    on_event({
        "type": "warning",
        "message": "Legacy engine is deprecated and will be removed in a future release. "
                   "Please update to engine: deepagents or report issues."
    })
    # Still works, but user is warned
```

---

### Step 5: Delete Legacy Loops
**When:** 3-6 months after Step 4, zero legacy usage

**Files to delete:**
- `sidecar/src/ccie_sidecar/agents/react.py` (legacy react_loop)
- `sidecar/src/ccie_sidecar/agents/react_code.py` (legacy react_code_loop)
- `sidecar/src/ccie_sidecar/agents/code_exec.py` (legacy code_exec_loop)

**Server cleanup:**
- Remove all `else:` branches for legacy routing
- Remove legacy imports
- Simplify to single code path

**Estimated deletion:** ~2000 lines of legacy code

---

## Benefits of DeepAgents (Recap)

### 1. Planning (TodoList Middleware)
**Before:** Agent guesses API endpoints, fabricates device names  
**After:** Agent plans steps explicitly, discovers before acting

**Impact:** Reduces "guessing" bugs (commits a807080, 9101304, 6c57b4b fixed this symptom)

### 2. SubAgents (Isolated Context)
**Before:** 600-tool Meraki catalog poisons reasoning context  
**After:** Discovery and rendering run separately

**Impact:** Cleaner execution, better focus

### 3. RubricMiddleware (Self-Verification)
**Before:** Agent returns first attempt, even if wrong  
**After:** Grader checks output, agent retries with feedback

**Impact:** Higher quality results, fewer retries needed from user

### 4. HITL Approval (Phase 4)
**Before:** Half-built stub, never worked  
**After:** Full interrupt/resume with blast radius gating

**Impact:** Safety for destructive operations

### 5. Provider Tool Calling
**Before:** Google/Ollama streaming-only, no tool calling  
**After:** LangChain handles tool calling for all providers

**Impact:** More provider options

---

## Rollback Strategy

At any step, rollback is simple:

**Before Step 3 (default flip):**
- Remove `engine: deepagents` from agent frontmatter
- Restart application
- No code changes needed

**After Step 3 (default flip):**
- Add `engine: legacy` to agent frontmatter
- Restart application
- Or revert server.py default change

**After Step 5 (legacy deleted):**
- Revert git commits
- Restore legacy loop files
- Redeploy

---

## Monitoring

**Metrics to Watch:**
- Agent success rate (task completion)
- Average tokens per request (planning may increase slightly)
- Latency (SubAgents add overhead)
- Error rate (should decrease with self-verification)
- User feedback (fewer "agent guessed wrong" reports)

**Known Trade-offs:**
- Slightly higher token usage (planning + grading)
- Slightly higher latency (SubAgents + retries)
- More complex stack (LangChain/LangGraph dependencies)

**Expected Wins:**
- Higher accuracy (self-verification)
- Fewer hallucinations (planning before acting)
- Better results (SubAgents isolate context)
- Native HITL (safety for destructive ops)

---

## Current Recommendation (Phase 5)

**Do NOT flip defaults yet.** Wait for:
1. Rust/frontend integration for HITL approval
2. Real-world testing with Meraki agent
3. Performance validation under load
4. User feedback on planning/subagents

**Safe next step:** Enable `engine: deepagents` for Meraki agent only (Step 1), monitor for 1 week.

---

## Phase 5 Completion Criteria

Phase 5 is complete when:
- ✅ RubricMiddleware added to react_loop (optional)
- ✅ Cutover guide documented (this file)
- ✅ All tests passing
- ✅ Decision made on default flip timing

**Actual default flip** can happen post-Phase 5 when conditions are met.

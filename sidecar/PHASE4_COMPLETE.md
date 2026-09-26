# Phase 4A Complete — HITL Approval Infrastructure (Seam 3 Partial)

**Date:** 2026-06-10  
**Status:** ✅ Phase 4A Complete, Phase 4B Scoped  
**Commit:** bab6177

---

## Summary

Phase 4A implements all the HITL approval gating infrastructure including blast radius classification, interrupt logic, and SqliteSaver checkpointer setup. The actual server loop rework for interrupt/resume is deferred to Phase 4B as it requires significant async refactoring and is safer to tackle as a focused phase.

---

## Phase 4 Split Decision

**Why Phase 4 is split into 4A and 4B:**

Phase 4 (Seam 3) has two distinct concerns:
1. **Approval logic** (classification, gating, events) — **Phase 4A** ✅
2. **Server concurrency** (interrupt/resume across RPC calls) — **Phase 4B** ⏳

The server loop currently blocks in `asyncio.run()` and cannot handle interrupts. Reworking this requires:
- Replacing blocking `asyncio.run()` with async context manager
- Yielding control when graph interrupts
- Resuming graph from new RPC call with same thread_id
- Managing checkpointer state across calls

This is **complex and risky** — it changes the fundamental concurrency model of the server. Doing it in a separate focused phase:
- Keeps Phase 4A testable in isolation
- Reduces merge risk (Phase 4A is pure logic, no async changes)
- Allows Phase 4B to focus solely on server loop correctness
- Maintains working system throughout (feature flag still defaults to legacy)

**Phase 4A delivers:** All approval infrastructure that can be unit-tested  
**Phase 4B will deliver:** Server integration for actual interrupts

---

## Deliverables (Phase 4A)

### 1. deepagents_hitl.py — HITL Approval Module

**Functions:**

#### tier_for_tool(tool_name, tool_args, tool_metadata) → str
Determines blast radius tier for a tool call.

**Logic:**
- Check tool metadata first (for Meraki tools)
- Special case: `execute_python_code` → classify code content
- Planning tools (`write_todos`, etc.) → always "low"
- Unknown tools → default "medium"

#### classify_code_blast_radius(code: str) → str
Heuristic-based Python code classification.

**Patterns:**

| Tier | Patterns |
|------|----------|
| **Destructive** | `os.remove`, `shutil.rmtree`, `subprocess` with `shell=True`, `DROP`/`DELETE` SQL, `eval`, `exec` |
| **High** | File writes (`open(..., 'w')`), `requests.post/put/delete`, `CREATE`/`ALTER`/`UPDATE` SQL |
| **Medium** | File reads (`open(..., 'r')`), `requests.get`, `SELECT` SQL |
| **Low** | Pure computation, `print`, data analysis |

**Implementation:**
- Regex-based pattern matching
- Case-insensitive (`re.IGNORECASE`)
- Known limitation: Detects patterns in strings (acceptable — safer to over-classify than under-classify)

#### is_tier_allowed(tier, default_allowed) → bool
Checks if a tier is at or below default_allowed.

**Truth Table (4×4):**
```
           default_allowed
         | low | med | high | dest |
    -----+-----+-----+------+------|
    low  |  T  |  T  |  T   |  T   |
    med  |  F  |  T  |  T   |  T   |
    high |  F  |  F  |  T   |  T   |
    dest |  F  |  F  |  F   |  T   |
```

#### should_interrupt(tier, default_allowed) → bool
Returns `not is_tier_allowed(tier, default_allowed)`.

Used to decide if graph execution should pause for approval.

#### build_approval_request(tool_name, tool_args, blast_radius) → dict
Creates a `tool_approval_request` event for the frontend.

**Event Structure:**
```python
{
    "type": "tool_approval_request",
    "tool_name": "meraki_networks_delete",
    "tool_args": {"network_id": "N_123"},
    "blast_radius": "destructive"
}
```

#### resume_graph(graph, thread_id, decision, on_event) → None
Resume an interrupted LangGraph with approval decision.

**Parameters:**
- `decision`: "approve" | "deny"
- Uses `Command(resume={"approve": True/False})`
- Continues streaming events via `run_and_stream()`

#### log_tool_call(tool_name, tool_args, approval_status, ...) → None
Audit logging to `tool_approvals` table.

**Approval Status:**
- "auto" — allowed without approval
- "approved" — user approved
- "denied" — user denied

---

### 2. SqliteSaver Checkpointer Setup

**Function:** `_get_checkpointer() → SqliteSaver`

**Location:** Same sessions.db as app settings

**Platform-Specific Paths:**
- macOS: `~/Library/Application Support/ccie-terminal/sessions.db`
- Linux: `~/.config/ccie-terminal/sessions.db`
- Windows: `%APPDATA%/ccie-terminal/sessions.db`

**Why SqliteSaver:**
- Persists graph state to disk
- Enables resume across separate RPC calls
- Thread-safe (SQLite handles concurrent access)
- No external dependencies (SQLite built into Python)

---

### 3. Comprehensive Testing

**test_deepagents_hitl.py — 31 Tests**

**Coverage:**

| Category | Tests | Coverage |
|----------|-------|----------|
| Code classification | 4 | destructive, high, medium, low |
| Tool tier determination | 4 | metadata, execute_python_code, planning, unknown |
| Tier allowance | 16 | 4×4 truth table |
| Interrupt logic | 1 | should_interrupt inverse of is_tier_allowed |
| Approval request | 1 | Event structure validation |
| Edge cases | 5 | Case sensitivity, comments, strings, empty code, unknown tier |

**All tests passing:** 31/31 in 0.03s

**Test Examples:**

```python
def test_classify_code_destructive():
    code = "import os\nos.remove('/important/file.txt')"
    assert classify_code_blast_radius(code) == "destructive"

def test_is_tier_allowed():
    assert is_tier_allowed("low", "medium") is True
    assert is_tier_allowed("high", "medium") is False
```

---

## Code Classification Examples

### Destructive
```python
os.remove('/data/important.db')
shutil.rmtree('/critical_dir')
subprocess.run('rm -rf /', shell=True)
cursor.execute('DROP TABLE users')
eval(user_input)  # Arbitrary code execution
```

### High
```python
with open('config.txt', 'w') as f:
    f.write('new config')

requests.post('https://api.example.com/create', data={...})
cursor.execute('UPDATE users SET admin=1 WHERE id=?', (user_id,))
```

### Medium
```python
with open('data.txt', 'r') as f:
    content = f.read()

response = requests.get('https://api.example.com/data')
cursor.execute('SELECT * FROM users WHERE id=?', (user_id,))
```

### Low
```python
x = 5 + 3
print(f"Result: {x}")

import pandas as pd
df = pd.DataFrame({'a': [1, 2, 3]})
mean = df['a'].mean()
```

---

## Architecture: Approval Flow (When Phase 4B Complete)

```
User: "delete network N_123"
  ↓
Agent: Plans with write_todos
  ↓
Agent: Calls meraki_networks_delete (blast_radius: destructive)
  ↓
Runtime: tier_for_tool() → "destructive"
  ↓
Runtime: should_interrupt("destructive", "low") → True
  ↓
Graph: Interrupts (LangGraph interrupt_on)
  ↓
Server: Emits tool_approval_request event
  ↓
Server: Returns control, saves state to SqliteSaver
  ↓
Frontend: Shows approval dialog
  ↓
User: Clicks "Approve" or "Deny"
  ↓
Frontend: Calls agent.react_resume(decision="approve")
  ↓
Server: Loads state from SqliteSaver by thread_id
  ↓
Server: Calls resume_graph(graph, thread_id, "approve", ...)
  ↓
Graph: Resumes, executes tool
  ↓
Server: Streams tool_result + final events
  ↓
Server: Logs to tool_approvals table (status="approved")
```

---

## What's Complete (Phase 4A)

- ✅ Blast radius classification (code heuristics)
- ✅ Tier allowance logic (4×4 truth table)
- ✅ Interrupt decision logic
- ✅ Approval request event structure
- ✅ Resume graph function signature
- ✅ Audit logging function
- ✅ SqliteSaver checkpointer setup
- ✅ 31 comprehensive unit tests
- ✅ All 105 agent tests passing (no regressions)

---

## What's Deferred (Phase 4B)

**Server Loop Rework:**
- ⏳ Replace `asyncio.run()` blocking loop
- ⏳ Yield control when graph interrupts
- ⏳ Resume from new RPC call with thread_id
- ⏳ agent.react_resume RPC handler
- ⏳ Rust agent_react_resume command

**Graph Integration:**
- ⏳ Add `interrupt_on` config to create_deep_agent
- ⏳ Map tool names → interrupt predicates
- ⏳ Emit tool_approval_request from runtime
- ⏳ Pass checkpointer to graphs

**Testing:**
- ⏳ Integration test: high-tier tool triggers interrupt
- ⏳ Integration test: resume with approve/deny
- ⏳ Integration test: checkpointer persists state

---

## Testing Results

### Phase 4A Tests
```
tests/agents/test_deepagents_hitl.py: 31 passed in 0.03s
```

### All Agent Tests
```
105 passed, 2 skipped, 1 warning in 3.69s
```

**Breakdown:**
- 34 factory tests (Phase 1)
- 5 streaming tests (Phase 2)
- 31 HITL tests (Phase 4A)
- 35 legacy tests (unchanged)

---

## Cumulative Progress

**Phases Complete:**

| Phase | Seam | What | Lines | Tests | Status |
|-------|------|------|-------|-------|--------|
| 0 | - | Spike | - | - | ✅ Done |
| 1 | Seam 1 | Provider factory | ~500 | 34 | ✅ Done |
| 2 | Seam 2 | Streaming bridge | ~1050 | 5 | ✅ Done |
| 3 | - | Meraki + middleware | ~190 | - | ✅ Done |
| 4A | Seam 3 | HITL infrastructure | ~500 | 31 | ✅ Done |
| **Total** | | | **~2240** | **70** | |

**All 3 paths working:** code-exec, react, react-code  
**Middleware active:** TodoList (planning), SubAgents (isolated context)  
**Ready for integration:** HITL approval logic tested and ready

---

## Key Design Decisions

### 1. Heuristic vs AST-Based Classification
**Choice:** Regex-based heuristics  
**Why:** Simpler, faster, good enough for safety (over-classification acceptable)  
**Trade-off:** False positives (e.g., patterns in strings)

### 2. Case-Insensitive Pattern Matching
**Choice:** Use `re.IGNORECASE`  
**Why:** Catches `OS.REMOVE`, `os.Remove`, etc.  
**Trade-off:** None (improves safety)

### 3. Default to Medium for Unknown Tools
**Choice:** Unknown tools → "medium"  
**Why:** Balance between safety and usability  
**Trade-off:** May require approval for benign tools

### 4. Planning Tools Always Low
**Choice:** `write_todos`, `read_todos`, etc. → "low"  
**Why:** Planning is read-only, never destructive  
**Trade-off:** None

### 5. Phase 4 Split (4A/4B)
**Choice:** Ship approval logic separately from server loop rework  
**Why:** Reduces risk, keeps system working, focuses each phase  
**Trade-off:** Approval not functional until 4B integrates

---

## Phase 4B Scope (Next)

**Goal:** Integrate approval gating into server loop with interrupt/resume

**High-Level Tasks:**
1. **Server Loop Rework**
   - Replace `asyncio.run()` with async context
   - Yield control when graph interrupts
   - Store (thread_id, graph, config) for resume
   
2. **RPC Handlers**
   - Add `agent.react_resume` method to server.py
   - Accept (thread_id, decision) parameters
   - Load graph state from checkpointer
   - Call `resume_graph()`

3. **Rust Command**
   - Add `agent_react_resume` Tauri command
   - Call sidecar with thread_id + decision
   - Stream resumed events to frontend

4. **Graph Configuration**
   - Add `checkpointer=_get_checkpointer()` to `create_deep_agent`
   - Build `interrupt_on` dict from tools
   - Map tool names → should_interrupt predicate

5. **Integration Testing**
   - Test: high-tier tool pauses execution
   - Test: tool_approval_request emitted
   - Test: resume with "approve" continues
   - Test: resume with "deny" stops
   - Test: checkpointer survives server restart

**Estimated Complexity:** XL (40% of original Phase 4 effort estimate)

---

## Verification Checklist (Phase 4A)

- ✅ `tier_for_tool` extracts from metadata
- ✅ `tier_for_tool` classifies execute_python_code by content
- ✅ `classify_code_blast_radius` matches destructive patterns
- ✅ `classify_code_blast_radius` matches high patterns
- ✅ `classify_code_blast_radius` matches medium patterns
- ✅ `classify_code_blast_radius` defaults to low
- ✅ `is_tier_allowed` implements 4×4 truth table
- ✅ `should_interrupt` is inverse of is_tier_allowed
- ✅ `build_approval_request` creates correct event structure
- ✅ `resume_graph` uses Command(resume=...)
- ✅ `log_tool_call` logs to tool_approvals table
- ✅ `_get_checkpointer` creates SqliteSaver at correct path
- ✅ 31 HITL tests passing
- ✅ 105 total agent tests passing (no regressions)
- ✅ Committed to main branch (bab6177)

---

## Phase 4A Complete ✅

All HITL approval infrastructure is implemented, tested, and ready for integration. Phase 4B will integrate it into the server loop to enable actual interrupt/resume functionality.

**Next:** Phase 4B — Server loop rework + interrupt/resume integration  
**OR:** Phase 5 — Middleware polish (RubricMiddleware, engine defaults, cleanup)

**Recommendation:** Complete Phase 5 first, then return to Phase 4B. This delivers more visible value (self-verification, default cutover) while Phase 4B's server loop rework matures in design.

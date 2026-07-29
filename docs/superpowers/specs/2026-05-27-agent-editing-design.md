# Agent Editing Feature Design

**Date:** 2026-05-27  
**Feature:** Enable editing of agents after creation in Settings → Agents tab

## Overview

Add the ability to edit existing agents through the Settings UI. Currently, users can only create and delete agents. This feature allows modifying all agent properties (name, description, system prompt, model override, attached skills/MCP servers, allowed commands) through the same form UI used for creation.

## User Experience

### Current State
- Settings → Agents tab shows a list of agents
- Each agent card has only a "Delete" button
- No way to modify an agent after creation (must delete and recreate)

### New Behavior
- Each agent card will have an "Edit" button next to "Delete"
- Clicking "Edit" opens the agent form modal with current values pre-populated
- User can modify any field and save changes
- Modal title changes to "Edit Agent: {name}" (vs "Create New Agent")
- Submit button reads "Save Changes" (vs "Create Agent")

## Architecture

### Backend (Rust)

#### AgentsLoader Update Method
Add a new `update()` method to `src-tauri/src/agents/loader.rs`:

```rust
pub fn update(
    &self,
    id: &str,
    name: &str,
    description: &str,
    system_prompt: &str,
    model_override: Option<(String, String)>,
    attached_skills: Vec<String>,
    attached_mcp_servers: Vec<String>,
    attached_tools: Vec<super::types::AttachedTool>,
    allowed_commands: Vec<String>,
    body: &str,
) -> Result<Agent>
```

**Implementation details:**
- Verify agent directory exists (return error if not)
- Serialize updated data using existing `serialize_agent_md()` function
- Write atomically: write to temp file, then rename to `AGENT.md`
- Preserve agent directory and any extra files (only replace `AGENT.md`)
- Call `reload_agent(id)` to refresh in-memory cache
- Return updated `Agent` struct

**Atomic write pattern:**
```rust
let tmp_path = dir.join("AGENT.md.tmp");
fs::write(&tmp_path, md)?;
fs::rename(&tmp_path, dir.join("AGENT.md"))?;
```

#### Tauri Command
Add `agents_update` command to `src-tauri/src/commands/mod.rs`:

```rust
#[tauri::command]
pub fn agents_update(
    state: State<'_, AppState>,
    id: String,
    input: CreateAgentInput,
) -> Result<agents::Agent, String>
```

- Reuse existing `CreateAgentInput` struct for consistency
- Validate agent exists before calling loader
- Extract and transform input fields same as `agents_create`
- Return updated agent or error message

### Frontend (TypeScript/React)

#### Settings.tsx State Updates
Add new state variables:

```typescript
const [editingAgentId, setEditingAgentId] = useState<string | null>(null);
```

Modal behavior becomes mode-aware:
- When `editingAgentId` is set, modal is in edit mode
- When `editingAgentId` is null, modal is in create mode

#### UI Changes

**Agent list cards:**
- Add "Edit" button next to "Delete"
- Button style matches existing delete button
- Click handler: `handleEditAgent(agent)`

**Modal updates:**
- Title: `{editingAgentId ? `Edit Agent: ${currentAgentName}` : "Create New Agent"}`
- Submit button: `{editingAgentId ? "Save Changes" : "Create Agent"}`
- Form pre-population: when `editingAgentId` changes, load agent data into all form fields

**Event handlers:**

```typescript
const handleEditAgent = (agent: Agent) => {
  setEditingAgentId(agent.id);
  setNewAgentName(agent.name);
  setNewAgentDescription(agent.description);
  setNewAgentSystemPrompt(agent.systemPrompt);
  // ... populate all other fields
  setShowCreateAgent(true);
};

const handleSaveAgent = async () => {
  if (editingAgentId) {
    await agentsUpdate(editingAgentId, { /* input */ });
  } else {
    await agentsCreate({ /* input */ });
  }
  // Reset and reload
  setEditingAgentId(null);
  setShowCreateAgent(false);
  await loadAgents();
};

const handleCancelAgent = () => {
  setEditingAgentId(null);
  setShowCreateAgent(false);
  // Reset all form fields
};
```

#### Tauri Binding
Add to `src/lib/tauri.ts`:

```typescript
export async function agentsUpdate(
  id: string,
  input: CreateAgentInput
): Promise<Agent> {
  return invoke("agents_update", { id, input });
}
```

Use the existing `CreateAgentInput` type definition.

## Data Flow

### Edit Flow
1. User clicks "Edit" on agent card
2. `handleEditAgent()` sets `editingAgentId` and populates form
3. Modal opens with current values
4. User modifies fields
5. User clicks "Save Changes"
6. Frontend calls `agentsUpdate(id, updatedData)`
7. Backend validates and writes `AGENT.md` atomically
8. Backend reloads agent from disk
9. Frontend receives updated agent
10. Frontend reloads agents list
11. Modal closes and state resets

### Create Flow (Unchanged)
1. User clicks "Create Agent"
2. Empty form displays
3. User fills fields
4. User clicks "Create Agent"
5. Frontend calls `agentsCreate(data)`
6. Backend creates directory and `AGENT.md`
7. Frontend reloads agents list
8. Modal closes

## Error Handling

### Backend Errors
- **Agent not found:** Return `Err("Agent '{id}' not found")`
- **Write failure:** Return `Err("Failed to write AGENT.md: {error}")`
- **Validation failure:** Return validation error from serialize function

### Frontend Errors
- Display error message in modal using existing `error` state
- Don't close modal on error - allow user to fix and retry
- Show loading state during save operation
- Clear error when user starts typing again

## Edge Cases

### Concurrent Modifications
- **Risk:** User edits agent in two Settings windows simultaneously
- **Behavior:** Last write wins (no conflict detection needed)
- **Justification:** Single-user desktop app, unlikely scenario

### Agent in Active Use
- **Scenario:** User edits an agent that's currently active in terminal tabs
- **Behavior:** Allow edit, changes take effect on next AI message in those tabs
- **Note:** Agent data is loaded per-message, not cached for tab lifetime

### Name Changes
- **Behavior:** Agent ID (directory name) never changes after creation
- **Reasoning:** Keeps references stable, avoids complex rename logic
- **Note:** The `name` field can change, but `id` is immutable

### Invalid Field Values
- **Required fields:** Name and system prompt (validated in UI and backend)
- **Model override:** Only validated if checkbox is enabled
- **Skills/MCP:** Selection from known lists, no custom validation needed
- **Allowed commands:** Free-form regex patterns, no validation

## Testing Approach

### Manual Testing Checklist
- [ ] Click Edit on an agent, verify form populates correctly
- [ ] Modify each field type and save successfully
- [ ] Cancel edit, verify form resets and modal closes
- [ ] Edit agent currently active in a tab, verify next message uses new config
- [ ] Trigger each error condition (agent not found, write failure)
- [ ] Create new agent, verify create flow still works
- [ ] Edit then delete agent, verify no issues

### Unit Tests (Optional)
- Add test for `AgentsLoader::update()` method
- Test atomic write behavior (write succeeds even if file exists)
- Test update with missing agent (should fail)

## Implementation Order

1. **Backend:** Add `update()` method to `AgentsLoader` with tests
2. **Backend:** Add `agents_update` Tauri command
3. **Frontend:** Add `agentsUpdate` binding to tauri.ts
4. **Frontend:** Add `editingAgentId` state to Settings.tsx
5. **Frontend:** Add "Edit" button to agent cards
6. **Frontend:** Add `handleEditAgent` to populate form
7. **Frontend:** Update modal title and button text based on mode
8. **Frontend:** Update submit handler to branch on `editingAgentId`
9. **Frontend:** Update cancel handler to clear `editingAgentId`
10. **Testing:** Manual verification of all flows

## Files Modified

### New Files
None (all changes to existing files)

### Modified Files
- `src-tauri/src/agents/loader.rs` - Add `update()` method
- `src-tauri/src/commands/mod.rs` - Add `agents_update` command
- `src/lib/tauri.ts` - Add `agentsUpdate` binding
- `src/windows/Settings.tsx` - Add edit state and UI

## Success Criteria

- [ ] User can click Edit button on any agent
- [ ] Modal opens with all current values pre-populated
- [ ] User can modify any field and save changes
- [ ] Changes persist after closing and reopening Settings
- [ ] Agent retains same ID after edit
- [ ] Create flow continues to work unchanged
- [ ] Errors display clearly and don't crash the app
- [ ] No data loss if edit operation fails

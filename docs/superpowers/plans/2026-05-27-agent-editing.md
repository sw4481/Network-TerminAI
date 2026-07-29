# Agent Editing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable editing of existing agents in Settings → Agents tab through the same form UI used for creation.

**Architecture:** Add backend `update()` method to AgentsLoader that atomically rewrites AGENT.md files, expose via `agents_update` Tauri command, reuse existing create modal in Settings by adding edit mode state, branch logic based on `editingAgentId` state.

**Tech Stack:** Rust (Tauri backend), TypeScript/React (frontend), existing AgentsLoader infrastructure

---

## File Structure

**Modified Files:**
- `src-tauri/src/agents/loader.rs` - Add `update()` method and test
- `src-tauri/src/commands/mod.rs` - Add `agents_update` Tauri command
- `src/lib/tauri.ts` - Add `agentsUpdate` TypeScript binding
- `src/windows/Settings.tsx` - Add edit mode state and UI

**No new files created** - all changes extend existing infrastructure.

---

### Task 1: Add AgentsLoader::update() method

**Files:**
- Modify: `src-tauri/src/agents/loader.rs` (add method after `create()` at ~line 129)

- [ ] **Step 1: Write the failing test**

Add test after the existing `test_create_and_load_agent_roundtrip` test (around line 454):

```rust
#[test]
fn test_update_agent() {
    let tmp = TempDir::new().unwrap();
    let loader = AgentsLoader::new(tmp.path().to_path_buf());
    
    // Create initial agent
    let agent = loader
        .create(
            "test-agent",
            "Test Agent",
            "A test agent",
            "You are helpful.",
            Some(("anthropic".to_string(), "claude-3".to_string())),
            vec!["skill-a".to_string()],
            vec![],
            vec![],
            vec!["^show ".to_string()],
            "# Notes\n\nOriginal body.",
        )
        .unwrap();
    assert_eq!(agent.name, "Test Agent");
    assert_eq!(agent.description, "A test agent");
    
    // Update agent
    let updated = loader
        .update(
            "test-agent",
            "Updated Name",
            "Updated description",
            "You are very helpful.",
            Some(("openai".to_string(), "gpt-4".to_string())),
            vec!["skill-b".to_string(), "skill-c".to_string()],
            vec!["mcp-server-1".to_string()],
            vec![],
            vec!["^ping ".to_string(), "^traceroute ".to_string()],
            "# Updated\n\nNew body.",
        )
        .unwrap();
    
    assert_eq!(updated.id, "test-agent"); // ID unchanged
    assert_eq!(updated.name, "Updated Name");
    assert_eq!(updated.description, "Updated description");
    assert_eq!(updated.system_prompt, "You are very helpful.");
    assert_eq!(updated.attached_skills, vec!["skill-b", "skill-c"]);
    assert_eq!(updated.attached_mcp_servers, vec!["mcp-server-1"]);
    assert_eq!(updated.allowed_commands, vec!["^ping ", "^traceroute "]);
    assert!(updated.body.contains("New body"));
    
    let model = updated.model_override.unwrap();
    assert_eq!(model.provider, "openai");
    assert_eq!(model.model, "gpt-4");
    
    // Reload and verify persistence
    let all = loader.load_all().unwrap();
    assert_eq!(all.len(), 1);
    assert_eq!(all[0].name, "Updated Name");
}
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd src-tauri
cargo test test_update_agent -- --nocapture
```

Expected output: Compilation error "no method named `update`" or similar.

- [ ] **Step 3: Implement the update() method**

Add the `update()` method in `src-tauri/src/agents/loader.rs` after the `create()` method (around line 129):

```rust
/// Update an existing agent on disk.
/// Returns the updated agent after reloading.
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
) -> Result<Agent> {
    let dir = self.agents_dir.join(id);
    if !dir.exists() {
        anyhow::bail!("Agent '{}' not found", id);
    }

    let md = serialize_agent_md(
        name,
        description,
        system_prompt,
        model_override.as_ref(),
        &attached_skills,
        &attached_mcp_servers,
        &attached_tools,
        &allowed_commands,
        body,
    );

    // Atomic write: temp file + rename
    let tmp_path = dir.join("AGENT.md.tmp");
    fs::write(&tmp_path, &md).context("Failed to write temporary AGENT.md")?;
    fs::rename(&tmp_path, dir.join("AGENT.md"))
        .context("Failed to rename temporary file to AGENT.md")?;

    self.reload_agent(id)?;
    self.get(id)
        .ok_or_else(|| anyhow::anyhow!("Failed to reload updated agent"))
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd src-tauri
cargo test test_update_agent -- --nocapture
```

Expected output: `test test_update_agent ... ok`

- [ ] **Step 5: Add test for update non-existent agent**

Add test after `test_update_agent`:

```rust
#[test]
fn test_update_nonexistent_agent() {
    let tmp = TempDir::new().unwrap();
    let loader = AgentsLoader::new(tmp.path().to_path_buf());
    
    let result = loader.update(
        "nonexistent",
        "Name",
        "Desc",
        "Prompt",
        None,
        vec![],
        vec![],
        vec![],
        vec![],
        "Body",
    );
    
    assert!(result.is_err());
    assert!(result.unwrap_err().to_string().contains("not found"));
}
```

- [ ] **Step 6: Run new test to verify it passes**

```bash
cd src-tauri
cargo test test_update_nonexistent_agent -- --nocapture
```

Expected output: `test test_update_nonexistent_agent ... ok`

- [ ] **Step 7: Commit backend update method**

```bash
git add src-tauri/src/agents/loader.rs
git commit -m "feat(agents): add update() method with atomic write

Add AgentsLoader::update() to modify existing agents. Uses atomic
write pattern (temp file + rename) to prevent corruption. Preserves
agent directory and extra files, only replaces AGENT.md.

Tests cover successful update and error case for non-existent agent.

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"
```

---

### Task 2: Add agents_update Tauri command

**Files:**
- Modify: `src-tauri/src/commands/mod.rs` (add command after `agents_delete` at ~line 2951)

- [ ] **Step 1: Add agents_update command**

Add after the `agents_delete` function (around line 2951):

```rust
#[tauri::command]
pub fn agents_update(
    state: State<'_, AppState>,
    id: String,
    input: CreateAgentInput,
) -> Result<agents::Agent, String> {
    // Validate agent exists
    if state.agents_loader.get(&id).is_none() {
        return Err(format!("Agent '{}' not found", id));
    }

    let model_override = input.model_override.map(|m| (m.provider, m.model));

    state
        .agents_loader
        .update(
            &id,
            &input.name,
            &input.description,
            &input.system_prompt,
            model_override,
            input.attached_skills,
            input.attached_mcp_servers,
            input.attached_tools,
            input.allowed_commands,
            &input.body,
        )
        .map_err(|e| e.to_string())
}
```

- [ ] **Step 2: Register command in Tauri builder**

Find the `.invoke_handler(tauri::generate_handler![` block (around line 355) and add `agents_update` to the list. The block should look like:

```rust
.invoke_handler(tauri::generate_handler![
    // ... existing commands ...
    agents_list,
    agents_get,
    agents_reload,
    agents_create,
    agents_update,  // <-- Add this line
    agents_delete,
    // ... rest of commands ...
])
```

- [ ] **Step 3: Build to verify compilation**

```bash
cd src-tauri
cargo build
```

Expected output: Build succeeds with no errors.

- [ ] **Step 4: Commit Tauri command**

```bash
git add src-tauri/src/commands/mod.rs
git commit -m "feat(agents): add agents_update Tauri command

Expose AgentsLoader::update() via Tauri IPC. Reuses CreateAgentInput
struct for consistency with agents_create. Validates agent exists
before calling update.

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"
```

---

### Task 3: Add TypeScript binding for agentsUpdate

**Files:**
- Modify: `src/lib/tauri.ts` (add after `agentsCreate` function)

- [ ] **Step 1: Find agentsCreate function location**

```bash
grep -n "export async function agentsCreate" src/lib/tauri.ts
```

Expected output: Line number where `agentsCreate` is defined.

- [ ] **Step 2: Add agentsUpdate function after agentsCreate**

Add this function immediately after `agentsCreate` (the function should be around line 180-190 based on Settings.tsx imports):

```typescript
export async function agentsUpdate(
  id: string,
  input: {
    name: string;
    description: string;
    systemPrompt: string;
    modelOverride: { provider: string; model: string } | null;
    attachedSkills: string[];
    attachedMcpServers: string[];
    attachedTools?: AttachedTool[];
    allowedCommands: string[];
    body: string;
  }
): Promise<Agent> {
  return invoke("agents_update", { id, input });
}
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
npm run check
```

Expected output: No TypeScript errors.

- [ ] **Step 4: Commit TypeScript binding**

```bash
git add src/lib/tauri.ts
git commit -m "feat(agents): add agentsUpdate TypeScript binding

Add frontend binding for agents_update Tauri command. Signature
matches agentsCreate for consistency. Returns updated Agent object.

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"
```

---

### Task 4: Add edit mode state to Settings.tsx

**Files:**
- Modify: `src/windows/Settings.tsx` (add state variable around line 90)

- [ ] **Step 1: Add editingAgentId state**

Find the agents tab state variables (around line 86-100, after the line `const [agents, setAgentsList] = useState<Agent[]>([]);`) and add:

```typescript
const [editingAgentId, setEditingAgentId] = useState<string | null>(null);
```

- [ ] **Step 2: Update handleCreateAgent to support edit mode**

Replace the existing `handleCreateAgent` function (around line 145) with this version that branches on `editingAgentId`:

```typescript
const handleCreateAgent = async () => {
  if (!newAgentName.trim() || !newAgentSystemPrompt.trim()) {
    setError("Agent name and system prompt are required");
    return;
  }
  const allowedCommands = newAgentAllowedCommands
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  try {
    if (editingAgentId) {
      // Update existing agent
      await agentsUpdate(editingAgentId, {
        name: newAgentName.trim(),
        description: newAgentDescription.trim() || "No description",
        systemPrompt: newAgentSystemPrompt.trim(),
        modelOverride: newAgentUseOverride
          ? { provider: newAgentProvider, model: newAgentModel.trim() || "" }
          : null,
        attachedSkills: newAgentAttachedSkills,
        attachedMcpServers: newAgentAttachedMcp,
        allowedCommands,
        body: "",
      });
    } else {
      // Create new agent
      await agentsCreate({
        name: newAgentName.trim(),
        description: newAgentDescription.trim() || "No description",
        systemPrompt: newAgentSystemPrompt.trim(),
        modelOverride: newAgentUseOverride
          ? { provider: newAgentProvider, model: newAgentModel.trim() || "" }
          : null,
        attachedSkills: newAgentAttachedSkills,
        attachedMcpServers: newAgentAttachedMcp,
        allowedCommands,
        body: "",
      });
    }
    setShowCreateAgent(false);
    setEditingAgentId(null);
    setNewAgentName("");
    setNewAgentDescription("");
    setNewAgentSystemPrompt("");
    setNewAgentUseOverride(false);
    setNewAgentModel("");
    setNewAgentAttachedSkills([]);
    setNewAgentAttachedMcp([]);
    setNewAgentAllowedCommands("");
    await loadAgents();
  } catch (e) {
    setError(e instanceof Error ? e.message : "Failed to save agent");
  }
};
```

- [ ] **Step 3: Add import for agentsUpdate**

Find the import statement from tauri.ts (around line 7) and add `agentsUpdate` to the imports:

```typescript
import { /* existing imports */, agentsUpdate } from "../lib/tauri";
```

The line should look like:

```typescript
import { mcpListServers, mcpRemoveServer, mcpUpdateServerEnabled, mcpAddServer, type McpServer, skillsList, skillsReload, aiListModels, skillsCreate, aiSaveConfig, aiGetConfig, aiTestConnection, agentsList, agentsCreate, agentsUpdate, agentsDelete, type Agent } from "../lib/tauri";
```

- [ ] **Step 4: Verify TypeScript compiles**

```bash
npm run check
```

Expected output: No TypeScript errors.

- [ ] **Step 5: Commit edit mode state**

```bash
git add src/windows/Settings.tsx
git commit -m "feat(agents): add edit mode state to Settings

Add editingAgentId state to track edit vs create mode. Update
handleCreateAgent to branch on editingAgentId and call agentsUpdate
when editing. Import agentsUpdate from tauri bindings.

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"
```

---

### Task 5: Add Edit button and handleEditAgent

**Files:**
- Modify: `src/windows/Settings.tsx` (add button in agent card around line 782, add handler around line 182)

- [ ] **Step 1: Add handleEditAgent function**

Add this function after `handleCreateAgent` and before `handleDeleteAgent` (around line 182):

```typescript
const handleEditAgent = (agent: Agent) => {
  setEditingAgentId(agent.id);
  setNewAgentName(agent.name);
  setNewAgentDescription(agent.description);
  setNewAgentSystemPrompt(agent.systemPrompt);
  if (agent.modelOverride) {
    setNewAgentUseOverride(true);
    setNewAgentProvider(agent.modelOverride.provider as AIProvider);
    setNewAgentModel(agent.modelOverride.model);
  } else {
    setNewAgentUseOverride(false);
    setNewAgentProvider("anthropic");
    setNewAgentModel("");
  }
  setNewAgentAttachedSkills(agent.attachedSkills);
  setNewAgentAttachedMcp(agent.attachedMcpServers);
  setNewAgentAllowedCommands(agent.allowedCommands.join("\n"));
  setShowCreateAgent(true);
};
```

- [ ] **Step 2: Add Edit button in agent card**

Find the agent card rendering section (around line 775-790, inside the `agents.map((a) =>` block). Find the `server-actions` div that contains the Delete button:

```tsx
<div className="server-actions">
  <button
    className="delete-btn"
    onClick={() => handleDeleteAgent(a.id)}
    title="Delete"
  >
    Delete
  </button>
</div>
```

Replace it with:

```tsx
<div className="server-actions">
  <button
    className="secondary"
    onClick={() => handleEditAgent(a)}
    title="Edit"
    style={{ marginRight: "8px" }}
  >
    Edit
  </button>
  <button
    className="delete-btn"
    onClick={() => handleDeleteAgent(a.id)}
    title="Delete"
  >
    Delete
  </button>
</div>
```

- [ ] **Step 3: Test in browser**

```bash
npm run tauri dev
```

Manual test:
1. Open Settings → Agents tab
2. Verify Edit button appears next to Delete
3. Click Edit on an agent
4. Verify modal opens with pre-populated fields
5. Don't save yet (we'll update modal title next)

- [ ] **Step 4: Commit Edit button and handler**

```bash
git add src/windows/Settings.tsx
git commit -m "feat(agents): add Edit button and handleEditAgent

Add handleEditAgent to populate form with agent data and set edit
mode. Add Edit button to each agent card. Pre-populate all form
fields including model override, skills, MCP servers, and allowed
commands.

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"
```

---

### Task 6: Update modal title and button text for edit mode

**Files:**
- Modify: `src/windows/Settings.tsx` (update modal around line 979 and button around line 1140)

- [ ] **Step 1: Update modal title**

Find the create agent modal header (around line 979):

```tsx
<div className="settings-header">
  <h2>Create New Agent</h2>
  <button className="close-btn" onClick={() => setShowCreateAgent(false)}>
    ✕
  </button>
</div>
```

Replace with:

```tsx
<div className="settings-header">
  <h2>{editingAgentId ? `Edit Agent: ${newAgentName}` : "Create New Agent"}</h2>
  <button className="close-btn" onClick={() => {
    setShowCreateAgent(false);
    setEditingAgentId(null);
  }}>
    ✕
  </button>
</div>
```

- [ ] **Step 2: Update submit button text**

Find the form actions buttons in the create agent modal (around line 1139):

```tsx
<div className="form-actions">
  <button className="primary" onClick={handleCreateAgent}>
    Create Agent
  </button>
  <button
    className="secondary"
    onClick={() => setShowCreateAgent(false)}
  >
    Cancel
  </button>
</div>
```

Replace with:

```tsx
<div className="form-actions">
  <button className="primary" onClick={handleCreateAgent}>
    {editingAgentId ? "Save Changes" : "Create Agent"}
  </button>
  <button
    className="secondary"
    onClick={() => {
      setShowCreateAgent(false);
      setEditingAgentId(null);
    }}
  >
    Cancel
  </button>
</div>
```

- [ ] **Step 3: Test modal behavior in browser**

```bash
npm run tauri dev
```

Manual test:
1. Open Settings → Agents
2. Click "Create Agent" → verify title says "Create New Agent" and button says "Create Agent"
3. Cancel and click Edit on an agent
4. Verify title shows "Edit Agent: {name}" and button says "Save Changes"
5. Click X or Cancel, verify modal closes
6. Click Edit again, verify form still pre-populates

- [ ] **Step 4: Commit modal updates**

```bash
git add src/windows/Settings.tsx
git commit -m "feat(agents): update modal title and button for edit mode

Modal title shows 'Edit Agent: {name}' when editing, 'Create New
Agent' when creating. Submit button shows 'Save Changes' vs 'Create
Agent'. Close/Cancel buttons now clear editingAgentId state.

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"
```

---

### Task 7: Manual end-to-end testing

**No files modified** - verification only.

- [ ] **Step 1: Create a test agent**

```bash
npm run tauri dev
```

Manual steps:
1. Open Settings → Agents
2. Click "Create Agent"
3. Fill in:
   - Name: "Test Editor Agent"
   - Description: "For testing edit functionality"
   - System prompt: "You are a test agent."
   - Leave model override unchecked
   - Don't select any skills or MCP servers
   - Add allowed command: `^show `
4. Click "Create Agent"
5. Verify agent appears in list

- [ ] **Step 2: Edit the test agent**

Manual steps:
1. Click "Edit" on "Test Editor Agent"
2. Verify all fields pre-populate correctly
3. Modify:
   - Name: "Updated Test Agent"
   - Description: "Updated description"
   - System prompt: "You are an updated test agent."
   - Check "Override global AI model"
   - Select provider: OpenAI
   - Model: "gpt-4"
   - Add allowed command: `^ping ` (so now has 2 commands)
4. Click "Save Changes"
5. Verify agent card updates with new values

- [ ] **Step 3: Verify persistence**

Manual steps:
1. Close Settings window
2. Reopen Settings → Agents
3. Verify "Updated Test Agent" still shows updated values
4. Click Edit again
5. Verify all modified fields still correct
6. Cancel without changes

- [ ] **Step 4: Test create flow still works**

Manual steps:
1. Click "Create Agent"
2. Verify modal shows "Create New Agent" title
3. Verify all fields are empty (not pre-filled from previous edit)
4. Fill in a different agent name: "Second Test Agent"
5. Add simple description and prompt
6. Click "Create Agent"
7. Verify both agents appear in list

- [ ] **Step 5: Test error handling**

Manual steps:
1. Click Edit on any agent
2. Clear the name field
3. Click "Save Changes"
4. Verify error message displays
5. Modal should stay open
6. Enter a name and save successfully

- [ ] **Step 6: Test cancel behavior**

Manual steps:
1. Click Edit on an agent
2. Make some changes but don't save
3. Click Cancel
4. Click Edit on same agent again
5. Verify original values are shown (changes were discarded)

- [ ] **Step 7: Clean up test agents**

Manual steps:
1. Delete "Updated Test Agent"
2. Delete "Second Test Agent"
3. Verify no errors
4. Verify Settings → Agents shows your original agents only

- [ ] **Step 8: Document testing completion**

Create a simple test report:

```bash
echo "# Agent Editing Manual Test Report - $(date)" > /tmp/agent-edit-test-report.txt
echo "" >> /tmp/agent-edit-test-report.txt
echo "✅ Create flow works" >> /tmp/agent-edit-test-report.txt
echo "✅ Edit button opens modal with pre-populated fields" >> /tmp/agent-edit-test-report.txt
echo "✅ Edit saves and persists changes" >> /tmp/agent-edit-test-report.txt
echo "✅ Modal title and button text update correctly" >> /tmp/agent-edit-test-report.txt
echo "✅ Cancel discards changes" >> /tmp/agent-edit-test-report.txt
echo "✅ Error validation works" >> /tmp/agent-edit-test-report.txt
echo "✅ Agent ID remains stable after edit" >> /tmp/agent-edit-test-report.txt
cat /tmp/agent-edit-test-report.txt
```

---

## Self-Review Checklist

### Spec Coverage

✅ **Backend update method** - Task 1  
✅ **Tauri command** - Task 2  
✅ **TypeScript binding** - Task 3  
✅ **Edit mode state** - Task 4  
✅ **Edit button UI** - Task 5  
✅ **Modal title/button updates** - Task 6  
✅ **Manual testing** - Task 7

### Placeholder Scan

✅ No "TBD", "TODO", or "implement later"  
✅ No "add appropriate error handling" without specifics  
✅ No "write tests for the above" without test code  
✅ All code blocks contain actual implementation  
✅ All commands show expected output

### Type Consistency

✅ `editingAgentId: string | null` used consistently  
✅ `agentsUpdate` function signatures match between TypeScript/Rust  
✅ `CreateAgentInput` struct reused (not duplicated)  
✅ `Agent` type used consistently across frontend/backend  
✅ Model override structure consistent with existing code

### Implementation Order

✅ Backend before frontend (can't call non-existent commands)  
✅ TypeScript binding before UI usage  
✅ State before UI that depends on it  
✅ Tests verify each component in isolation  
✅ Manual E2E testing at end to verify integration

---

## Notes

- The `body` field in CreateAgentInput is always passed as empty string "" because the Settings UI doesn't expose it. This matches existing `agentsCreate` behavior.
- Agent ID (directory name) never changes after creation. Only the `name` field in frontmatter can change.
- The existing validation in `handleCreateAgent` checks for name and system prompt. This same validation applies to both create and edit modes.
- Atomic write pattern (temp file + rename) prevents corruption if write fails partway through.

# Infrastructure as Code Integration Design

**Date:** 2026-05-28  
**Status:** Draft  
**Target Release:** v1.1 (4-phase rollout)

## Executive Summary

This design adds comprehensive Terraform and Ansible integration to TerminAI, enabling intelligent execution, state management, drift detection, and natural language IaC generation. The integration follows a **hybrid architecture** (command interception + lightweight UI overlays) that preserves terminal workflow while adding intelligence where human judgment is required.

**Core value proposition:** Network engineers can execute IaC commands naturally in the terminal while TerminAI automatically tracks changes, gates risky operations, detects drift, and generates code from natural language - all without leaving their workflow.

## Background & Motivation

### User Context

- **Primary user:** CCIE-track network engineer building hybrid on-prem/cloud infrastructure
- **Workflow pattern:** Per-environment Git repositories with shared module registries
- **Use cases:** Network device configuration (Ansible), cloud infrastructure (Terraform), hybrid deployments
- **Pain points:**
  - Manual change tracking is error-prone
  - Risky operations (destroy, production deploys) lack safety gates
  - Infrastructure drift goes unnoticed until outages
  - Context switching between terminal, state files, and documentation
  - Repetitive IaC code generation for similar patterns

### Why This Matters

1. **Risk mitigation:** Network changes in production are high-stakes; approval gates prevent accidents
2. **Auditability:** Every IaC execution is tracked with git commit, blast radius, and structured metadata
3. **Efficiency:** Natural language generation eliminates boilerplate; state browser eliminates context switching
4. **Proactive monitoring:** Manual drift detection catches configuration drift before it causes outages
5. **Integration leverage:** Reuses existing TerminAI infrastructure (command blocks, agent system, topology view, change verification)

## Goals & Non-Goals

### Goals

1. **Zero-friction execution:** Users type normal terraform/ansible commands; intelligence is automatic
2. **Safety gates:** High-risk operations require explicit approval with blast-radius preview
3. **Complete auditability:** Every execution tracked with metadata (resources changed, git commit, duration)
4. **Drift visibility:** Manual drift detection with AI-powered remediation recommendations
5. **Natural language IaC:** ReACT agent generates validated Terraform/Ansible code from user intent
6. **State exploration:** Visual browser for Terraform state with search and cross-reference capabilities

### Non-Goals

1. **Automatic drift remediation:** User must explicitly approve import or revert actions
2. **Background polling for drift:** Only manual drift checks (user preference from brainstorming)
3. **Git auto-commit:** Optional feature, not default behavior (decided against in brainstorming)
4. **Automatic pre-change snapshots:** User must explicitly request (decided in brainstorming design decisions)
5. **Support for every IaC tool:** Focus on Terraform and Ansible only (not Pulumi, CDK, CloudFormation)
6. **Remote state backends:** Initial version uses local state files only (S3/Terraform Cloud support deferred)

## Architecture Overview

### High-Level Approach

**Hybrid pattern:** Command interception for zero friction + UI overlays (modals, drawers) for decision points.

```
User types command → Detector intercepts → Risk analysis → Approval modal (if needed)
  → Execute with wrappers → Parse output → Store metadata → Display enriched block
```

### Layer Integration

#### Frontend Layer (React + TypeScript)

**New Components:**
- `IaCApprovalModal.tsx` - Pre-execution approval gate with blast-radius preview
- `IaCCommandBlock.tsx` - Enriched command block with structured resource sections
- `StateDrawer.tsx` - Terraform state browser (slides in from right, ⌘⇧T)
- `DriftDetailModal.tsx` - Drift analysis with AI recommendations and remediation actions
- `IaCAgentTools.tsx` - Agent tool definitions for IaC operations

**Modified Components:**
- `CommandBlock.tsx` - Render `IaCCommandBlock` for terraform/ansible commands
- `AgentPanel.tsx` - Load IaCAgentTools when in IaC project context

#### Core Layer (Rust + Tauri)

**New Modules:**
- `src-tauri/src/iac/detector.rs` - Pattern matching for terraform/ansible commands
- `src-tauri/src/iac/parser.rs` - Structured output parsing (JSON + regex fallback)
- `src-tauri/src/iac/wrapper.rs` - Pre/post execution hooks
- `src-tauri/src/iac/blast_radius.rs` - Risk classification logic
- `src-tauri/src/iac/state_manager.rs` - Terraform state queries and caching
- `src-tauri/src/iac/drift_checker.rs` - Manual drift detection orchestration

**Database Schema Extensions:**

```sql
-- Track every IaC execution with metadata
CREATE TABLE iac_executions (
  id TEXT PRIMARY KEY,
  command_block_id TEXT NOT NULL REFERENCES command_blocks(id) ON DELETE CASCADE,
  tool TEXT NOT NULL CHECK(tool IN ('terraform', 'ansible')),
  subcommand TEXT NOT NULL,  -- apply, plan, destroy, playbook, etc.
  project_path TEXT NOT NULL,
  git_commit TEXT,
  git_branch TEXT,
  had_uncommitted_changes INTEGER NOT NULL DEFAULT 0,
  blast_radius TEXT CHECK(blast_radius IN ('low', 'medium', 'high', 'critical')),
  resources_changed INTEGER,
  resources_failed INTEGER,
  metadata_json TEXT,  -- Parsed resource events, task results, etc.
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_iac_executions_tool ON iac_executions(tool, created_at DESC);
CREATE INDEX idx_iac_executions_project ON iac_executions(project_path, created_at DESC);

-- Cache Terraform state for fast queries
CREATE TABLE terraform_state_cache (
  id TEXT PRIMARY KEY,
  project_path TEXT NOT NULL UNIQUE,
  state_json TEXT NOT NULL,
  serial INTEGER NOT NULL,
  last_updated INTEGER NOT NULL
);

CREATE INDEX idx_terraform_state_project ON terraform_state_cache(project_path);

-- Track manual drift checks
CREATE TABLE drift_checks (
  id TEXT PRIMARY KEY,
  project_path TEXT NOT NULL,
  checked_at INTEGER NOT NULL,
  has_drift INTEGER NOT NULL,
  drift_summary_json TEXT,  -- Resources with drift, AI analysis
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_drift_checks_project ON drift_checks(project_path, checked_at DESC);
```

#### Sidecar Layer (Python 3.12)

**New Modules:**
- `sidecar/src/ccie_sidecar/iac_agent.py` - ReACT agent for IaC operations
- `sidecar/src/ccie_sidecar/terraform_tools.py` - Agent tool implementations
  - `query_terraform_state()` - Search state for resources
  - `generate_terraform_code()` - Generate HCL from intent
  - `search_module_registry()` - Find reusable modules
- `sidecar/src/ccie_sidecar/ansible_tools.py` - Agent tool implementations
  - `query_ansible_inventory()` - Search inventory for hosts/groups
  - `generate_ansible_playbook()` - Generate playbooks from intent
- `sidecar/src/ccie_sidecar/blast_radius_analyzer.py` - Risk scoring logic
- `sidecar/src/ccie_sidecar/iac_failure_explainer.py` - AI error analysis

## Detailed Component Design

### 1. Command Interception & Detection

#### Detector Logic (`iac/detector.rs`)

**Terraform patterns:**
```rust
static TERRAFORM_PATTERNS: &[&str] = &[
    r"^terraform\s+",
    r"^tf\s+",  // common alias
];

static MUTATING_SUBCOMMANDS: &[&str] = &[
    "apply", "destroy", "import", "taint", "untaint"
];
```

**Ansible patterns:**
```rust
static ANSIBLE_PATTERNS: &[&str] = &[
    r"^ansible-playbook\s+",
    r"^ansible\s+.+\s+-m\s+",  // ad-hoc commands with modules
];
```

**Detection flow:**
1. PTY parser emits command text before execution
2. Detector matches against patterns → extract tool, subcommand, flags
3. Check if mutating operation (requires approval logic)
4. Return `IaCCommand` struct to wrapper

```rust
pub struct IaCCommand {
    pub tool: IaCTool,  // Terraform | Ansible
    pub subcommand: String,
    pub flags: Vec<String>,
    pub args: Vec<String>,
    pub working_dir: PathBuf,
    pub is_mutating: bool,
}
```

### 2. Blast Radius Classification

#### Risk Scoring (`iac/blast_radius.rs`)

**Classification logic:**

```rust
pub enum BlastRadius {
    Low,      // < 5 resources, no destroys, dev environment
    Medium,   // 5-20 resources, updates only, staging environment
    High,     // > 20 resources or any destroys, production environment
    Critical, // terraform destroy, or production + > 50 resources
}

pub fn classify_terraform_plan(
    plan_output: &str,
    working_dir: &Path,
    git_branch: &str,
) -> BlastRadius {
    let resources_to_create = count_resource_action(plan_output, "create");
    let resources_to_update = count_resource_action(plan_output, "update");
    let resources_to_destroy = count_resource_action(plan_output, "destroy");
    
    let total = resources_to_create + resources_to_update + resources_to_destroy;
    let is_production = detect_production_environment(working_dir, git_branch);
    
    if resources_to_destroy > 0 && is_production {
        return BlastRadius::Critical;
    }
    
    if total > 50 || (resources_to_destroy > 10) {
        return BlastRadius::Critical;
    }
    
    if total > 20 || (resources_to_destroy > 0 && is_production) {
        return BlastRadius::High;
    }
    
    if total > 5 || is_production {
        return BlastRadius::Medium;
    }
    
    BlastRadius::Low
}

fn detect_production_environment(working_dir: &Path, git_branch: &str) -> bool {
    // Check directory name for "prod" keyword
    let dir_name = working_dir.file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("");
    
    if dir_name.contains("prod") || dir_name.contains("production") {
        return true;
    }
    
    // Check git branch (main/master are production by default)
    if git_branch == "main" || git_branch == "master" {
        return true;
    }
    
    // Check for .terraform/environment file
    let env_file = working_dir.join(".terraform/environment");
    if let Ok(contents) = std::fs::read_to_string(env_file) {
        if contents.trim().contains("prod") {
            return true;
        }
    }
    
    false
}
```

**Ansible risk scoring:**
```rust
pub fn classify_ansible_playbook(
    playbook_path: &Path,
    inventory: &str,
) -> BlastRadius {
    let is_production = inventory.contains("prod") || inventory.contains("production");
    
    // Parse playbook YAML for dangerous tags
    if let Ok(playbook_content) = std::fs::read_to_string(playbook_path) {
        if playbook_content.contains("tags: [dangerous]") || 
           playbook_content.contains("tags: [destructive]") {
            return if is_production {
                BlastRadius::Critical
            } else {
                BlastRadius::High
            };
        }
    }
    
    if is_production {
        BlastRadius::High
    } else {
        BlastRadius::Medium
    }
}
```

### 3. Approval Modal UI

#### Design Specifications

**Trigger conditions:**
- `BlastRadius::High` or `BlastRadius::Critical`
- User setting: `iac.always_approve` = false (default)
- Can be overridden per-session with "Remember this approval" checkbox

**Modal content:**
1. **Header:** Warning icon + "Terraform Apply Requires Approval"
2. **Alert banner:** Blast radius badge (color-coded: yellow=high, red=critical)
3. **Context section:**
   - Working directory
   - Git branch (with warning if main/master)
   - Full command
4. **Planned changes panel:**
   - Collapsible list of resources with actions (create/update/destroy)
   - Color-coded: green=create, blue=update, red=destroy
   - Resource count summary
5. **Action buttons:**
   - Primary: "Proceed with Apply" (green)
   - Secondary: "Cancel" (gray)
   - Tertiary: "Capture Pre-Change Snapshot" (optional)
   - Tertiary: "Show Full Plan" (expands to show full terraform plan output)
6. **Footer:** "Remember this approval for this session" checkbox

**Implementation:**
```typescript
// src/components/IaCApprovalModal.tsx
interface IaCApprovalModalProps {
  command: string;
  workingDir: string;
  gitBranch: string;
  blastRadius: 'low' | 'medium' | 'high' | 'critical';
  plannedChanges: {
    toCreate: ResourceChange[];
    toUpdate: ResourceChange[];
    toDestroy: ResourceChange[];
  };
  onApprove: () => void;
  onCancel: () => void;
  onShowPlan: () => void;
  onCaptureSnapshot?: () => void;
}

interface ResourceChange {
  resourceType: string;
  resourceName: string;
  resourceId?: string;
  actions: string[];
}
```

### 4. Output Parsing

#### Terraform Output Parsing (`iac/parser.rs`)

**Strategy:** Prefer JSON output, fallback to regex parsing.

```rust
pub fn parse_terraform_output(
    raw_output: &str,
    subcommand: &str,
) -> Result<IaCMetadata> {
    // Try JSON parsing first (terraform apply -json)
    if let Ok(metadata) = parse_terraform_json(raw_output) {
        return Ok(metadata);
    }
    
    // Fallback to regex parsing
    parse_terraform_human_readable(raw_output, subcommand)
}

pub struct IaCMetadata {
    pub resources_changed: u32,
    pub resources_failed: u32,
    pub resource_events: Vec<ResourceEvent>,
    pub summary: String,
}

pub struct ResourceEvent {
    pub resource_type: String,
    pub resource_name: String,
    pub resource_id: Option<String>,
    pub action: ResourceAction,  // Create, Update, Destroy
    pub timestamp: u64,
    pub duration_ms: Option<u64>,
    pub error: Option<String>,
}

fn parse_terraform_json(json_output: &str) -> Result<IaCMetadata> {
    let mut events = Vec::new();
    
    for line in json_output.lines() {
        if let Ok(event) = serde_json::from_str::<TerraformJsonEvent>(line) {
            if event.type_field == "apply_progress" || event.type_field == "change_summary" {
                events.push(ResourceEvent {
                    resource_type: event.resource.type_field.clone(),
                    resource_name: event.resource.name.clone(),
                    resource_id: event.resource.id.clone(),
                    action: parse_action(&event.action),
                    timestamp: event.timestamp,
                    duration_ms: None,
                    error: None,
                });
            }
        }
    }
    
    // Extract summary from final change_summary event
    let resources_changed = events.iter()
        .filter(|e| matches!(e.action, ResourceAction::Create | ResourceAction::Update))
        .count() as u32;
    
    Ok(IaCMetadata {
        resources_changed,
        resources_failed: 0,
        resource_events: events,
        summary: format!("{} resources changed", resources_changed),
    })
}

fn parse_terraform_human_readable(output: &str, subcommand: &str) -> Result<IaCMetadata> {
    let create_regex = Regex::new(r"(?m)^([a-z_]+\.[a-z0-9_\[\]]+): Creating\.\.\.$").unwrap();
    let update_regex = Regex::new(r"(?m)^([a-z_]+\.[a-z0-9_\[\]]+): Modifying\.\.\.$").unwrap();
    let destroy_regex = Regex::new(r"(?m)^([a-z_]+\.[a-z0-9_\[\]]+): Destroying\.\.\.$").unwrap();
    
    let mut events = Vec::new();
    
    for cap in create_regex.captures_iter(output) {
        let full_name = cap.get(1).unwrap().as_str();
        let (resource_type, resource_name) = split_resource_name(full_name);
        
        events.push(ResourceEvent {
            resource_type,
            resource_name,
            resource_id: None,
            action: ResourceAction::Create,
            timestamp: current_timestamp(),
            duration_ms: None,
            error: None,
        });
    }
    
    // ... repeat for update and destroy patterns
    
    Ok(IaCMetadata {
        resources_changed: events.len() as u32,
        resources_failed: 0,
        resource_events: events,
        summary: format!("{} resources changed", events.len()),
    })
}
```

#### Ansible Output Parsing

**Strategy:** Inject `ANSIBLE_STDOUT_CALLBACK=json` environment variable to get structured output.

```rust
pub fn parse_ansible_output(
    raw_output: &str,
) -> Result<IaCMetadata> {
    let json: AnsibleJsonOutput = serde_json::from_str(raw_output)?;
    
    let mut events = Vec::new();
    let mut failed_count = 0;
    
    for (host, play_results) in json.plays.iter() {
        for task_result in play_results.tasks.iter() {
            let action = if task_result.changed {
                ResourceAction::Update
            } else if task_result.failed {
                failed_count += 1;
                ResourceAction::Failed
            } else {
                ResourceAction::Ok
            };
            
            events.push(ResourceEvent {
                resource_type: "ansible_task".to_string(),
                resource_name: task_result.task_name.clone(),
                resource_id: Some(host.clone()),
                action,
                timestamp: task_result.start_timestamp,
                duration_ms: Some(task_result.duration_ms),
                error: task_result.msg.clone(),
            });
        }
    }
    
    Ok(IaCMetadata {
        resources_changed: events.iter().filter(|e| e.action == ResourceAction::Update).count() as u32,
        resources_failed: failed_count,
        resource_events: events,
        summary: format!("{} tasks executed on {} hosts", events.len(), json.plays.len()),
    })
}
```

### 5. Enriched Command Block UI

#### Design Specifications

**Header section:**
- Command text with monospace font
- Exit code badge (green for 0, red for non-zero)
- Resources changed badge (blue, shows count)
- Duration badge (gray)
- Action buttons: Copy, Rerun, View State (for terraform), AI Explain (on failure)

**Metadata row:**
- Working directory
- Git branch + commit (clickable links)
- Timestamp

**Structured output body:**
- Collapsible sections grouped by action:
  - ▼ Created (N resources) - green header
  - ▼ Modified (N resources) - blue header
  - ▼ Destroyed (N resources) - red header
  - ▼ Failed (N resources) - red header
- Each resource shows:
  - Resource type + name (monospace)
  - Resource ID (if available, in gray)
  - Action-specific badges (e.g., "⚠️ restarted" for EC2 instances)
- Raw output section: collapsed by default, expandable

**Ansible-specific:**
- Group by host instead of action
- Show task status with icons: ✓ (ok), ⚡ (changed), ❌ (failed)
- Failed hosts section at top (if any failures)

**Implementation:**
```typescript
// src/components/IaCCommandBlock.tsx
interface IaCCommandBlockProps {
  block: Block;
  iacExecution: IaCExecution;
}

interface IaCExecution {
  id: string;
  tool: 'terraform' | 'ansible';
  subcommand: string;
  projectPath: string;
  gitCommit?: string;
  gitBranch?: string;
  hadUncommittedChanges: boolean;
  blastRadius: 'low' | 'medium' | 'high' | 'critical';
  resourcesChanged: number;
  resourcesFailed: number;
  metadata: IaCMetadata;
}

interface IaCMetadata {
  resourceEvents: ResourceEvent[];
  summary: string;
}
```

### 6. State Browser Drawer

#### Design Specifications

**Activation:** ⌘⇧T (Cmd+Shift+T) - mirrors pattern of ⌘⇧D (Drift), ⌘⇧G (Guard rules), etc.

**Layout:**
- Slides in from right side (420px width)
- Overlays terminal (dims background)
- Header: "Terraform State" + project name + close button
- Search bar: filters resources by name/type
- Resource tree: grouped by resource type, collapsible sections
- Selected resource detail panel at bottom

**Resource tree display:**
- Group header: resource type + count (e.g., "aws_security_group (4)")
- Each resource card shows:
  - Resource name (monospace)
  - Resource ID + region (gray text)
  - Key attributes (e.g., "Ingress rules: 2, Egress rules: 1")
  - Drift badge (orange "DRIFT" label if detected)
- Click to select → shows detail panel

**Detail panel:**
- Resource name + full address (e.g., "aws_security_group.alb_https")
- Resource ID (copyable)
- Action buttons:
  - "Copy ID" - copy resource ID to clipboard
  - "AWS Console" - open resource in AWS console (deep link)
  - "Show Dependencies" - highlight dependent resources in tree

**State loading:**
```rust
// src-tauri/src/iac/state_manager.rs
pub fn load_terraform_state(project_path: &Path) -> Result<TerraformState> {
    let state_file = project_path.join(".terraform/terraform.tfstate");
    
    // Check cache first
    if let Some(cached) = get_cached_state(project_path)? {
        if !state_file_modified_since(&state_file, cached.last_updated)? {
            return Ok(serde_json::from_str(&cached.state_json)?);
        }
    }
    
    // Read fresh state
    let state_json = std::fs::read_to_string(&state_file)?;
    let state: TerraformState = serde_json::from_str(&state_json)?;
    
    // Update cache
    cache_state(project_path, &state_json, state.serial)?;
    
    Ok(state)
}

pub fn query_state_resources(
    state: &TerraformState,
    search_query: Option<&str>,
) -> Vec<StateResource> {
    state.resources
        .iter()
        .filter(|r| {
            if let Some(query) = search_query {
                r.type_field.contains(query) || 
                r.name.contains(query) ||
                r.instances.iter().any(|i| {
                    i.attributes.get("id")
                        .and_then(|v| v.as_str())
                        .map(|id| id.contains(query))
                        .unwrap_or(false)
                })
            } else {
                true
            }
        })
        .flat_map(|r| {
            r.instances.iter().map(move |inst| StateResource {
                resource_type: r.type_field.clone(),
                resource_name: r.name.clone(),
                resource_id: inst.attributes.get("id")
                    .and_then(|v| v.as_str())
                    .map(String::from),
                attributes: inst.attributes.clone(),
            })
        })
        .collect()
}
```

### 7. Drift Detection

#### Manual Drift Check Flow

**Trigger:** User runs "Check for Drift" command or clicks button in UI

**Implementation:**
```rust
// src-tauri/src/iac/drift_checker.rs
pub async fn check_drift(
    project_path: PathBuf,
    db: Arc<Database>,
    agent_bridge: Arc<AgentBridge>,
) -> Result<DriftCheckResult> {
    // 1. Run terraform plan with detailed exit code
    let plan_output = run_command_with_timeout(
        "terraform",
        &["plan", "-detailed-exitcode", "-no-color"],
        &project_path,
        Duration::from_secs(300),
    ).await?;
    
    // Exit code 2 = changes present (drift detected)
    let has_drift = plan_output.exit_code == 2;
    
    if !has_drift {
        return Ok(DriftCheckResult {
            has_drift: false,
            drifted_resources: vec![],
            ai_analysis: None,
        });
    }
    
    // 2. Parse plan output to extract drifted resources
    let drifted_resources = parse_drift_from_plan(&plan_output.stdout)?;
    
    // 3. Get AI analysis for each drifted resource
    let ai_analysis = agent_bridge.request(
        "analyze_drift",
        json!({
            "project_path": project_path,
            "drifted_resources": drifted_resources,
            "plan_output": plan_output.stdout,
        }),
    ).await?;
    
    // 4. Store drift check result
    db.insert_drift_check(&DriftCheck {
        id: Uuid::new_v4().to_string(),
        project_path: project_path.to_string_lossy().to_string(),
        checked_at: current_timestamp(),
        has_drift: true,
        drift_summary_json: serde_json::to_string(&DriftSummary {
            drifted_resources: drifted_resources.clone(),
            ai_analysis: ai_analysis.clone(),
        })?,
        created_at: current_timestamp(),
    })?;
    
    Ok(DriftCheckResult {
        has_drift: true,
        drifted_resources,
        ai_analysis: Some(ai_analysis),
    })
}

fn parse_drift_from_plan(plan_output: &str) -> Result<Vec<DriftedResource>> {
    let mut drifted = Vec::new();
    let drift_regex = Regex::new(
        r"(?m)^\s*~\s+([a-z_]+\.[a-z0-9_\[\]]+)"
    ).unwrap();
    
    for cap in drift_regex.captures_iter(plan_output) {
        let full_name = cap.get(1).unwrap().as_str();
        let (resource_type, resource_name) = split_resource_name(full_name);
        
        // Extract the diff section for this resource
        let diff = extract_resource_diff(plan_output, full_name);
        
        drifted.push(DriftedResource {
            resource_type,
            resource_name,
            detected_changes: diff,
        });
    }
    
    Ok(drifted)
}
```

**AI Analysis (Python sidecar):**
```python
# sidecar/src/ccie_sidecar/iac_agent.py
async def analyze_drift(
    drifted_resources: list[dict],
    plan_output: str,
    project_path: str,
) -> dict:
    """
    Use LLM to analyze drift and recommend actions.
    
    Context provided to LLM:
    - Drifted resource details
    - Full terraform plan output
    - Recent git history (to correlate with code changes)
    - Recent IaC executions (to see if related to recent apply)
    """
    
    # Load additional context
    git_log = await get_git_log(project_path, limit=10)
    recent_executions = await db.get_recent_iac_executions(project_path, limit=5)
    
    prompt = f"""Analyze the following Terraform drift and provide recommendations.

Project: {project_path}

Drifted Resources:
{json.dumps(drifted_resources, indent=2)}

Recent Git History:
{git_log}

Recent Terraform Executions:
{format_executions(recent_executions)}

For each drifted resource, explain:
1. What changed (in plain English)
2. Likely cause (manual change, related to recent work, external automation)
3. Recommended action (import, revert, or mark as exception)
4. Impact if left unaddressed

Format as JSON: {{"analyses": [{{"resource": "...", "explanation": "...", "cause": "...", "recommendation": "...", "impact": "..."}}]}}
"""
    
    response = await llm_client.generate(
        prompt=prompt,
        model=get_profile("smart").model,
        response_format="json",
    )
    
    return json.loads(response.content)
```

#### Drift Detail Modal UI

**Content sections:**
1. **Header:** Project name + "Drift Analysis" + close button
2. **Summary banner:**
   - Project path
   - Last check timestamp
   - Drift status: "3 resources modified outside Terraform"
3. **Per-resource analysis:** (scrollable list)
   - Resource name (header)
   - AI analysis section (blue background, explains what/why/impact)
   - Detected changes section (diff view, similar to git diff)
   - Action buttons:
     - "Import to Terraform" (green) - generates terraform import command
     - "Revert Manual Change" (red) - shows terraform apply to revert
     - "Mark as Exception" (gray) - adds to ignore list
     - "Generate Import Command" - copies import command to clipboard

**Implementation:**
```typescript
// src/components/DriftDetailModal.tsx
interface DriftDetailModalProps {
  driftCheck: DriftCheck;
  onClose: () => void;
  onImport: (resource: DriftedResource) => void;
  onRevert: (resource: DriftedResource) => void;
  onMarkException: (resource: DriftedResource) => void;
}

interface DriftCheck {
  id: string;
  projectPath: string;
  checkedAt: number;
  hasDrift: boolean;
  driftSummary: {
    driftedResources: DriftedResource[];
    aiAnalysis: {
      analyses: ResourceAnalysis[];
    };
  };
}

interface DriftedResource {
  resourceType: string;
  resourceName: string;
  detectedChanges: string;  // Diff output
}

interface ResourceAnalysis {
  resource: string;
  explanation: string;
  cause: string;
  recommendation: 'import' | 'revert' | 'exception';
  impact: string;
}
```

### 8. ReACT Agent Integration

#### Agent Tools

**Tool: `query_terraform_state`**
```python
async def query_terraform_state(
    query: str,
    project_path: str | None = None,
) -> dict:
    """
    Search Terraform state for resources matching query.
    
    Args:
        query: Search term (resource type, name, or attribute value)
        project_path: Optional project path (defaults to current working directory)
    
    Returns:
        List of matching resources with attributes
    """
    if project_path is None:
        project_path = os.getcwd()
    
    # Call Rust function to load and query state
    result = await tauri_invoke(
        "query_terraform_state",
        {"projectPath": project_path, "query": query},
    )
    
    return {
        "resources": result["resources"],
        "project_path": project_path,
        "state_version": result["serial"],
    }
```

**Tool: `generate_terraform_code`**
```python
async def generate_terraform_code(
    intent: str,
    context: dict,
) -> dict:
    """
    Generate Terraform HCL code from natural language intent.
    
    Args:
        intent: User's desired outcome (e.g., "add HTTPS rule from office to ALB")
        context: Dict with project_path, existing_resources, git_branch
    
    Returns:
        Generated HCL code, suggested filename, blast radius estimate
    """
    # Load project conventions (existing .tf files to learn style)
    conventions = await analyze_project_conventions(context["project_path"])
    
    # Build prompt with context
    prompt = f"""Generate Terraform code for the following requirement:

Intent: {intent}

Context:
- Project: {context["project_path"]}
- Git Branch: {context.get("git_branch", "unknown")}
- Existing Resources: {json.dumps(context.get("existing_resources", []), indent=2)}

Project Conventions:
- Provider versions: {conventions["provider_versions"]}
- Naming pattern: {conventions["naming_pattern"]}
- Variable style: {conventions["variable_style"]}

Generate valid HCL that:
1. Follows the project's naming and style conventions
2. References existing resources where appropriate
3. Uses variables for configurable values
4. Includes descriptive comments

Format response as JSON:
{{
  "code": "resource \\"aws_...\\n...",
  "filename": "suggested-file.tf",
  "explanation": "Brief explanation of what this code does",
  "blast_radius": "low|medium|high|critical",
  "estimated_apply_time_seconds": 10
}}
"""
    
    response = await llm_client.generate(
        prompt=prompt,
        model=get_profile("smart").model,
        response_format="json",
    )
    
    result = json.loads(response.content)
    
    # Validate syntax before returning
    validation = await validate_terraform_syntax(result["code"])
    if not validation["valid"]:
        # Retry with error feedback
        result = await retry_with_error_feedback(prompt, validation["error"])
    
    return result
```

**Tool: `query_ansible_inventory`**
```python
async def query_ansible_inventory(
    query: str,
    inventory_path: str | None = None,
) -> dict:
    """
    Query Ansible inventory for hosts, groups, and variables.
    
    Args:
        query: Group name, host pattern, or variable name
        inventory_path: Optional inventory file path
    
    Returns:
        Matching hosts with their groups, variables, and connection info
    """
    if inventory_path is None:
        # Auto-detect inventory file in current directory
        inventory_path = find_inventory_file(os.getcwd())
    
    # Run ansible-inventory command with JSON output
    result = await run_command(
        ["ansible-inventory", "-i", inventory_path, "--list"],
        cwd=os.getcwd(),
    )
    
    inventory = json.loads(result.stdout)
    
    # Filter based on query
    matching_hosts = []
    for group_name, group_data in inventory.items():
        if query.lower() in group_name.lower():
            for host in group_data.get("hosts", []):
                matching_hosts.append({
                    "host": host,
                    "groups": [group_name],
                    "vars": inventory.get("_meta", {}).get("hostvars", {}).get(host, {}),
                })
    
    return {
        "hosts": matching_hosts,
        "inventory_path": inventory_path,
        "total_hosts": len(matching_hosts),
    }
```

**Tool: `generate_ansible_playbook`**
```python
async def generate_ansible_playbook(
    intent: str,
    context: dict,
) -> dict:
    """
    Generate Ansible playbook from natural language intent.
    
    Args:
        intent: Desired state (e.g., "deploy nginx to web servers on port 8080")
        context: Dict with inventory_path, target_hosts, existing_roles
    
    Returns:
        Generated playbook YAML, suggested filename, target hosts
    """
    # Load existing roles from project
    available_roles = await list_available_roles(context.get("roles_path"))
    
    prompt = f"""Generate an Ansible playbook for the following requirement:

Intent: {intent}

Context:
- Target Hosts: {context.get("target_hosts", [])}
- Available Roles: {", ".join(available_roles)}
- Inventory: {context.get("inventory_path")}

Generate a valid YAML playbook that:
1. Uses best practices (handlers, tags, idempotency checks)
2. Reuses existing roles where applicable
3. Includes clear task names and descriptions
4. Uses variables for configurable values

Format response as JSON:
{{
  "playbook": "---\\n- name: ...\\n  ...",
  "filename": "suggested-playbook.yml",
  "explanation": "What this playbook does",
  "target_host_count": 5,
  "estimated_duration_minutes": 2
}}
"""
    
    response = await llm_client.generate(
        prompt=prompt,
        model=get_profile("smart").model,
        response_format="json",
    )
    
    result = json.loads(response.content)
    
    # Validate YAML syntax
    validation = await validate_ansible_syntax(result["playbook"])
    if not validation["valid"]:
        result = await retry_with_error_feedback(prompt, validation["error"])
    
    return result
```

#### Agent Context Loading

**Automatic context gathering:**
```python
async def gather_iac_context(cwd: str) -> dict:
    """
    Gather all relevant context for IaC agent operations.
    Called automatically when user sends message in IaC project directory.
    """
    context = {
        "cwd": cwd,
        "is_terraform_project": os.path.exists(os.path.join(cwd, ".terraform")),
        "is_ansible_project": find_inventory_file(cwd) is not None,
    }
    
    # Git context
    context["git_branch"] = await get_current_git_branch(cwd)
    context["git_commit"] = await get_current_git_commit(cwd)
    context["uncommitted_changes"] = await has_uncommitted_changes(cwd)
    
    # Terraform context
    if context["is_terraform_project"]:
        state = await tauri_invoke("load_terraform_state", {"projectPath": cwd})
        context["terraform_resources"] = state["resources"]
        context["terraform_outputs"] = state["outputs"]
    
    # Ansible context
    if context["is_ansible_project"]:
        inventory_path = find_inventory_file(cwd)
        inventory = await query_ansible_inventory("all", inventory_path)
        context["ansible_inventory"] = inventory["hosts"]
        context["ansible_groups"] = inventory.get("groups", [])
    
    # Topology context (if available from Plan 13)
    topology = await tauri_invoke("get_topology_devices", {})
    if topology:
        context["topology_devices"] = topology
    
    # Recent command history
    recent_commands = await db.get_recent_iac_executions(cwd, limit=10)
    context["recent_iac_executions"] = recent_commands
    
    return context
```

#### Agent Workflow

**User sends message in AgentPanel:**
1. Frontend detects current working directory from active terminal
2. Agent automatically calls `gather_iac_context(cwd)`
3. Agent receives context + user message
4. Agent decides which tools to call (query_state, generate_code, etc.)
5. Agent generates response with code + action buttons
6. User approves → triggers execution with approval modal (if high risk)

**Example conversation flow:**
```
User: "add HTTPS rule from office to ALB"

Agent (internal reasoning):
1. tool_use: query_terraform_state("alb")
   → Found aws_lb.prod_alb with security_groups=[sg-abc123]
2. tool_use: query_ansible_inventory("office")
   → Found office_network variable: 203.0.113.0/24
3. tool_use: generate_terraform_code(
     intent="add HTTPS ingress rule from 203.0.113.0/24 to sg-abc123",
     context={project_path, existing_resources, git_branch}
   )
   → Generated HCL code

Agent (response to user):
"I found your production ALB (aws_lb.prod_alb) with security group sg-abc123.
I'll create an ingress rule allowing HTTPS from your office network (203.0.113.0/24).

[Code block with generated HCL]

Impact: Low blast radius, 1 resource affected, ~5 second apply time.

[Apply This Change] [Save to File] [Show Plan First] [Cancel]"
```

## Configuration & Settings

### User-Configurable Options

**Settings location:** `~/.config/ccie-terminal/config.toml`

```toml
[iac]
# Approval gate configuration
always_approve = false  # Set to true to skip all approval modals
approval_threshold = "medium"  # low|medium|high|critical - minimum for modal
remember_session_approvals = true  # Honor "remember for session" checkbox

# Drift detection
drift_check_on_demand = true  # Enable manual drift checking
drift_notification_enabled = false  # Disable background polling (user preference)

# Output parsing
prefer_json_output = true  # Inject -json flag when available
store_raw_output = true  # Keep raw ANSI output in addition to parsed

# Git integration
warn_on_main_branch = true  # Show warning when running on main/master
detect_production_keywords = ["prod", "production"]  # Custom keywords

# Agent features
enable_iac_agent_tools = true  # Load IaC tools in agent context
auto_load_state = true  # Automatically load Terraform state in agent context
```

## Testing Strategy

### Unit Tests

**Rust modules:**
- `iac/detector.rs`: Command pattern matching, subcommand extraction
- `iac/parser.rs`: Output parsing (both JSON and regex fallback)
- `iac/blast_radius.rs`: Risk classification logic with various scenarios
- `iac/state_manager.rs`: State loading, caching, querying

**Python modules:**
- `terraform_tools.py`: Each tool function with mocked subprocess calls
- `ansible_tools.py`: Inventory parsing, playbook generation
- `blast_radius_analyzer.py`: Risk scoring edge cases

### Integration Tests

**End-to-end flows:**
1. **Terraform apply with approval:**
   - Mock terraform plan output → verify approval modal appears
   - Approve → verify actual terraform apply executes
   - Verify enriched command block renders with parsed metadata
   - Verify iac_executions record created in DB

2. **Ansible playbook execution:**
   - Run playbook with JSON callback → verify parsing
   - Check host grouping in enriched block
   - Verify failed hosts section appears on errors

3. **State browser:**
   - Load project with .terraform/terraform.tfstate
   - Open state drawer → verify resources listed
   - Search for resource → verify filtering
   - Select resource → verify detail panel

4. **Drift detection:**
   - Mock terraform plan with exit code 2
   - Run drift check → verify parsing
   - Verify AI analysis called with correct context
   - Check drift_checks record in DB

5. **Agent code generation:**
   - Send natural language request to agent
   - Verify tool calls (query_state, generate_code)
   - Verify generated code is syntactically valid
   - Click "Apply" → verify approval flow triggers

### Manual QA Checklist

- [ ] Run terraform apply on real project → verify approval modal
- [ ] Approve and execute → verify output parsing and enriched block
- [ ] Open state drawer (⌘⇧T) → verify state loads and search works
- [ ] Run drift check on project with manual changes → verify detection
- [ ] Chat with agent: "create S3 bucket" → verify code generation
- [ ] Test with both Terraform and Ansible projects
- [ ] Test error cases: syntax errors, network failures, auth failures
- [ ] Verify keyboard shortcuts work (⌘⇧T for state drawer)
- [ ] Test on non-IaC project → verify features don't interfere

## Security Considerations

### Approval Gates

**Threat:** User accidentally approves destructive operation
**Mitigation:** 
- Clear warning badges (yellow/red) for high/critical blast radius
- List all resources to be destroyed prominently
- No "Apply All" or "Always Approve" option (must approve each time)

### Command Injection

**Threat:** Malicious input via natural language agent
**Mitigation:**
- Agent-generated code is displayed to user before execution
- User must explicitly approve generated code
- Generated code validated (syntax check) before displaying
- No direct shell execution of unvalidated strings

### State File Access

**Threat:** Unauthorized access to Terraform state (may contain secrets)
**Mitigation:**
- State files accessed only from project directories user has navigated to
- No remote state backend support in v1 (deferred to avoid credential leakage)
- State cache stored in TerminAI DB with same permissions as config files

### Git Commit Attribution

**Threat:** IaC executions attributed to wrong commit/author
**Mitigation:**
- Always capture actual git commit SHA at execution time
- Warn if uncommitted changes detected (can't attribute accurately)
- Store both commit and "had_uncommitted_changes" flag

## Performance Considerations

### State Caching

- Cache Terraform state in DB to avoid repeated file reads
- Invalidate cache on mtime change
- Cache expiry: 5 minutes (configurable)

### Output Parsing

- Stream parsing: Process output line-by-line, not all-at-once
- Regex compilation: Pre-compile all patterns at startup
- JSON parsing: Prefer serde_json for performance

### Database Indexes

- Index on `iac_executions(project_path, created_at DESC)` for history queries
- Index on `terraform_state_cache(project_path)` for fast lookups
- Index on `drift_checks(project_path, checked_at DESC)` for latest drift status

### Agent Context Loading

- Lazy load: Only gather context when agent panel is visible
- Cache context for 60 seconds (avoid re-loading on every message)
- Parallel loading: Fetch git info, state, inventory concurrently

## Migration & Rollout Plan

### Phase 1: Command Interception & Parsing (2-3 weeks)

**Goal:** Basic IaC detection and enriched command blocks

**Deliverables:**
- Rust: `iac/detector.rs`, `iac/parser.rs`, `iac/wrapper.rs`
- Database: `iac_executions` table + migration
- Frontend: `IaCCommandBlock.tsx` component
- Parse Terraform JSON + Ansible JSON output
- Store structured metadata

**Success Criteria:**
- User runs `terraform apply` → enriched block appears with collapsible resource sections
- User runs `ansible-playbook` → enriched block shows per-host results
- Metadata stored in DB and queryable

**Testing:**
- Unit tests for detector patterns
- Integration test: Run terraform apply on test project
- Manual QA: Execute real terraform/ansible commands

### Phase 2: Approval Gates & Risk Analysis (2-3 weeks)

**Goal:** Safety gates for high-risk operations

**Deliverables:**
- Rust: `iac/blast_radius.rs` module
- Frontend: `IaCApprovalModal.tsx` component
- Pre-execution terraform plan parsing
- Git branch/commit detection
- Settings UI for approval thresholds

**Success Criteria:**
- `terraform destroy` always triggers approval modal
- `terraform apply` with >10 resources triggers modal
- Modal shows blast radius, git branch, planned changes
- User can approve, cancel, or show full plan

**Testing:**
- Unit tests for blast radius classification
- Integration test: Run destructive operation → verify modal
- Manual QA: Test various blast radius scenarios

### Phase 3: State Browser & Drift Detection (2-3 weeks)

**Goal:** State exploration and drift visibility

**Deliverables:**
- Rust: `iac/state_manager.rs`, `iac/drift_checker.rs`
- Database: `terraform_state_cache`, `drift_checks` tables
- Frontend: `StateDrawer.tsx`, `DriftDetailModal.tsx`
- Manual drift detection command
- AI drift analysis integration

**Success Criteria:**
- ⌘⇧T opens state drawer with searchable resource tree
- User runs "Check Drift" → detects manual changes
- Drift modal shows AI analysis + remediation options
- Import/revert actions generate correct commands

**Testing:**
- Unit tests for state queries
- Integration test: Load state → query resources
- Manual QA: Manually modify AWS resource → run drift check

### Phase 4: ReACT Agent Integration (2-3 weeks)

**Goal:** Natural language IaC generation

**Deliverables:**
- Python: `iac_agent.py`, `terraform_tools.py`, `ansible_tools.py`
- 8 agent tools implementation
- Context loading (state, inventory, topology, git)
- Generated code approval flow

**Success Criteria:**
- User chats: "add HTTPS rule from office to ALB"
- Agent generates valid Terraform code
- User clicks "Apply" → approval modal (if high risk) → executes
- Generated code follows project conventions

**Testing:**
- Unit tests for each agent tool
- Integration test: Full agent conversation → code generation → execution
- Manual QA: Test various natural language prompts

### Migration Path

**Backwards Compatibility:**
- Existing command blocks unaffected (IaC features additive)
- Database migrations handle schema additions
- Settings fallback to defaults if not configured

**Rollout Strategy:**
- Each phase ships independently
- Users can opt-out via `iac.enable = false` in config
- Phased rollout: internal testing → beta users → general release

## Future Enhancements (Out of Scope)

### Not in v1.1, Consider for v1.2+

1. **Background drift polling:**
   - Run `terraform plan` every N minutes
   - Desktop notification on drift
   - Requires: settings for interval, project selection

2. **Remote state backends:**
   - Support S3, Terraform Cloud, Consul backends
   - Requires: credential management, network access

3. **Git auto-commit:**
   - Optional: commit after successful apply
   - Requires: commit message templates, user consent

4. **Pre/post snapshots integration:**
   - Automatic capture before terraform apply
   - Requires: Plan 06 integration, snapshot command configuration

5. **Module registry browser:**
   - UI for browsing internal Terraform modules
   - Requires: module indexing, documentation parsing

6. **Playbook/plan templates:**
   - Library of common IaC patterns
   - One-click scaffolding
   - Requires: template format, customization UI

7. **Multi-project workspace:**
   - Manage multiple IaC repos in one view
   - Cross-project state queries
   - Requires: workspace concept, project grouping

8. **Cost estimation:**
   - Integrate with Infracost or AWS Pricing API
   - Show estimated cost impact in approval modal
   - Requires: external API integration

## Glossary

- **Blast Radius:** Measure of potential impact/risk of an IaC operation (low/medium/high/critical)
- **Drift:** Divergence between Terraform state and actual infrastructure (manual changes)
- **IaC:** Infrastructure as Code (Terraform, Ansible, etc.)
- **Mutating Operation:** Command that modifies infrastructure (apply, destroy) vs read-only (plan, show)
- **ReACT Agent:** Reasoning + Acting agent pattern (think → tool use → think → respond)
- **State:** Terraform's record of managed infrastructure (terraform.tfstate file)

## References

- **Existing TerminAI Features Referenced:**
  - Plan 01: Command Blocks architecture
  - Plan 06: Change Verification (pre/post snapshots)
  - Plan 08: Drift Detection (scheduled template comparisons)
  - Plan 12: RAG system (for indexing IaC codebase)
  - Plan 13: Topology View (for cross-referencing IaC with live network)
  - Plan 14: Credential Vault (for storing IaC provider credentials)
  - Plan 21: Meraki ReACT Agent (template for IaC agent)

- **External Documentation:**
  - Terraform JSON output format: https://developer.hashicorp.com/terraform/internals/json-format
  - Ansible JSON callback plugin: https://docs.ansible.com/ansible/latest/collections/ansible/builtin/json_callback.html
  - Terraform state file format: https://developer.hashicorp.com/terraform/language/state

## Appendix: Design Decisions Log

### Decision: Hybrid Architecture (Command Interception + UI Overlays)

**Options Considered:**
- A: Pure command interception (no UI)
- B: Dedicated IaC panel (full GUI)
- C: Hybrid approach (terminal + modals/drawers)

**Chosen:** C (Hybrid)

**Rationale:**
- Preserves terminal workflow (no disruption for experienced users)
- UI overlays add value where human judgment required (approvals, drift analysis)
- Matches existing TerminAI patterns (Sources drawer, BlastRadius modals)
- Incremental: can ship interception first, add UI later

### Decision: Manual Drift Detection Only

**Options Considered:**
- A: Background polling every N minutes
- B: Git hook triggered (on pull/checkout)
- C: Manual/on-demand only

**Chosen:** C (Manual)

**Rationale:**
- User preference from brainstorming session
- No background resource usage
- User maintains full control over when checks run
- Avoids notification fatigue

### Decision: No Automatic Pre-Change Snapshots

**Options Considered:**
- Always capture snapshots before apply
- Optional capture (user clicks button)
- Never capture (user must manually use Change Verification)

**Chosen:** Optional capture

**Rationale:**
- Not all IaC changes warrant snapshot overhead
- User decision from brainstorming design review
- Can be added as default-on setting later if users request

### Decision: Store Both Raw and Parsed Output

**Rationale:**
- Raw output preserves ANSI colors, full context
- Parsed output enables querying, structured display
- Disk space cost is minimal (outputs compressed)
- Debugging benefit: can compare parsing results to raw input

### Decision: Rust for Core Logic, Python for AI Analysis

**Rationale:**
- Rust: Performance-critical (output parsing, state queries)
- Python: Rapid iteration for AI prompts, LLM integration
- Follows existing TerminAI architecture
- Clear separation: Rust = deterministic logic, Python = AI/ML

---

**End of Design Document**
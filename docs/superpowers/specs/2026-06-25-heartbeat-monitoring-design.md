# Heartbeat Monitoring System Design

**Date:** 2026-06-25  
**Status:** Approved  
**Architecture:** Dedicated Heartbeat Subsystem (Approach B)

## Overview

The Heartbeat Monitoring System provides scheduled, AI-powered health checks across network infrastructure using CCIE Terminal's existing agent ecosystem (Meraki, pyATS, Stealthwatch, ISE, CML, Catalyst Center, etc.). Users describe monitoring goals in natural language, the system converts them to structured check plans, executes on schedule, and presents results in a hierarchical dashboard with desktop notifications for critical findings.

### Core Capabilities

- **Natural Language → Structured Plans:** Hybrid approach where users input monitoring goals ("Check for critical issues on Meraki network Shaun-home every hour"), AI proposes structured check plan, user reviews/edits before saving
- **Simple Interval Scheduling:** Every X minutes/hours/days (no complex cron syntax)
- **Hierarchical Results:** Dashboard shows heartbeats → executions → check groups → individual findings
- **Active Notifications:** Desktop notifications + sound alerts for critical findings
- **Adaptive Intelligence:** AI detects environment changes (new devices, networks) and suggests check updates
- **Full Management:** CRUD operations, manual triggers, schedule editing, clone, export/import, configurable retention

## Architecture

### Three-Layer Pattern

Following CCIE Terminal's existing architecture:

```
Frontend (React/TypeScript)
    ↓ Tauri IPC
Tauri Backend (Rust)
    ↓ NDJSON Protocol
Sidecar (Python Agents)
```

### Module Structure

**Backend (Rust):**
- `src-tauri/src/heartbeat/scheduler.rs` — tokio-cron-scheduler wrapper
- `src-tauri/src/heartbeat/runner.rs` — Execution orchestration
- `src-tauri/src/heartbeat/repo.rs` — Database CRUD
- `src-tauri/src/heartbeat/commands.rs` — Tauri IPC handlers
- `src-tauri/migrations/V0063__heartbeat.sql` — Schema

**Frontend (React):**
- `src/components/HeartbeatTab.tsx` — Dashboard UI
- `src/components/CreateHeartbeatModal.tsx` — Two-stage wizard (NL → Plan)
- `src/components/ExecutionDetailDrawer.tsx` — Hierarchical drill-down
- `src/components/SuggestionReviewModal.tsx` — AI suggestion review
- `src/state/heartbeatStore.ts` — Zustand state management
- `src/lib/types.ts` — Add `heartbeat` to `TabType` union

**Sidecar (Python):**
- `sidecar/src/ccie_sidecar/agents/heartbeat_planner.py` — NL → structured plan
- `sidecar/src/ccie_sidecar/agents/heartbeat_drift.py` — Environment change detection (optional phase 2)

## Data Flow

### 1. Creation Flow

```
User types NL goal in Heartbeat tab
    ↓
Frontend → Sidecar heartbeat_planner agent
    ↓
Planner analyzes request, queries available agents, proposes structured plan
    ↓
Frontend shows plan review modal (editable: name, checks, interval, retention)
    ↓
User approves → Frontend → Tauri heartbeat_create command
    ↓
Tauri saves to DB → Scheduler registers cron job
```

### 2. Execution Flow

```
Tokio cron job fires at scheduled interval
    ↓
Heartbeat runner loads check plan from DB
    ↓
For each check group, spawn agent session (parallel via tokio::spawn)
    ↓
Agents return findings with severity
    ↓
Runner aggregates into hierarchical structure
    ↓
Store execution + findings in DB
    ↓
Emit Tauri event: heartbeat://execution_completed
    ↓
Event listener checks for critical findings → Desktop notification if critical
```

### 3. Dashboard Flow

```
Heartbeat tab loads all heartbeats + recent executions
    ↓
Card grid: heartbeat name, status, last/next run, actions
    ↓
Click card → Expand timeline of recent executions
    ↓
Click execution → Drawer shows hierarchical findings (check groups → findings)
```

### 4. Drift Detection Flow

```
During execution, runner detects environment changes (new devices, networks)
    ↓
Store suggestion in heartbeat_suggestions table
    ↓
Dashboard shows yellow badge on affected heartbeat
    ↓
User clicks badge → Review modal with suggested check additions/removals
    ↓
Apply → Updates check plan | Dismiss → Marks suggestion dismissed
```

## Database Schema

### Migration V0063

```sql
CREATE TABLE heartbeats (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  description       TEXT NOT NULL DEFAULT '',
  interval_minutes  INTEGER NOT NULL CHECK (interval_minutes > 0),
  retention_days    INTEGER NOT NULL DEFAULT 30 CHECK (retention_days >= 1),
  enabled           INTEGER NOT NULL DEFAULT 1,
  next_run_at       INTEGER,
  created_at        INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  updated_at        INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE INDEX idx_heartbeats_enabled ON heartbeats(enabled) WHERE enabled = 1;
CREATE INDEX idx_heartbeats_next_run ON heartbeats(next_run_at) WHERE enabled = 1;

CREATE TABLE heartbeat_checks (
  id              TEXT PRIMARY KEY,
  heartbeat_id    TEXT NOT NULL REFERENCES heartbeats(id) ON DELETE CASCADE,
  check_group_name TEXT NOT NULL,
  agent_id        TEXT NOT NULL,
  agent_prompt    TEXT NOT NULL,
  sort_order      INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE INDEX idx_heartbeat_checks_heartbeat ON heartbeat_checks(heartbeat_id, sort_order);

CREATE TABLE heartbeat_executions (
  id                TEXT PRIMARY KEY,
  heartbeat_id      TEXT NOT NULL REFERENCES heartbeats(id) ON DELETE CASCADE,
  status            TEXT NOT NULL CHECK (status IN ('running','completed','completed_with_errors','failed')),
  started_at        INTEGER NOT NULL,
  completed_at      INTEGER,
  duration_ms       INTEGER,
  overall_severity  TEXT NOT NULL DEFAULT 'info' CHECK (overall_severity IN ('ok','info','warning','critical','error'))
);

CREATE INDEX idx_heartbeat_executions_heartbeat_time ON heartbeat_executions(heartbeat_id, started_at DESC);
CREATE INDEX idx_heartbeat_executions_status ON heartbeat_executions(status);

CREATE TABLE heartbeat_findings (
  id              TEXT PRIMARY KEY,
  execution_id    TEXT NOT NULL REFERENCES heartbeat_executions(id) ON DELETE CASCADE,
  check_id        TEXT NOT NULL REFERENCES heartbeat_checks(id) ON DELETE CASCADE,
  severity        TEXT NOT NULL CHECK (severity IN ('ok','info','warning','critical','error')),
  title           TEXT NOT NULL,
  message         TEXT NOT NULL DEFAULT '',
  metadata_json   TEXT NOT NULL DEFAULT '{}',
  created_at      INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE INDEX idx_heartbeat_findings_execution ON heartbeat_findings(execution_id);
CREATE INDEX idx_heartbeat_findings_severity ON heartbeat_findings(severity);

CREATE TABLE heartbeat_suggestions (
  id                    TEXT PRIMARY KEY,
  heartbeat_id          TEXT NOT NULL REFERENCES heartbeats(id) ON DELETE CASCADE,
  suggestion_type       TEXT NOT NULL CHECK (suggestion_type IN ('add_checks','remove_checks','modify_checks')),
  description           TEXT NOT NULL,
  proposed_checks_json  TEXT NOT NULL,
  created_at            INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  dismissed_at          INTEGER
);

CREATE INDEX idx_heartbeat_suggestions_heartbeat ON heartbeat_suggestions(heartbeat_id, dismissed_at);
```

### Foreign Key Relationships

- `heartbeat_checks.heartbeat_id` → `heartbeats.id` (CASCADE)
- `heartbeat_executions.heartbeat_id` → `heartbeats.id` (CASCADE)
- `heartbeat_findings.execution_id` → `heartbeat_executions.id` (CASCADE)
- `heartbeat_findings.check_id` → `heartbeat_checks.id` (CASCADE)
- `heartbeat_suggestions.heartbeat_id` → `heartbeats.id` (CASCADE)

## Component Design

### Backend Components

#### Heartbeat Scheduler (`scheduler.rs`)

Wraps `tokio-cron-scheduler`, converts simple intervals to cron expressions.

**Key Methods:**
- `new(db, agent_bridge, sink)` — Constructor with dependencies
- `start()` — Initialize scheduler, load enabled heartbeats, register jobs
- `add_heartbeat(name, interval_minutes, checks)` → `Result<Heartbeat>`
- `pause(heartbeat_id)` / `resume(heartbeat_id)` — Toggle enabled state
- `update_interval(heartbeat_id, new_interval)` — Re-register cron job
- `delete(heartbeat_id)` — Unregister job, cascade delete from DB
- `trigger_now(heartbeat_id)` — Manual execution outside schedule

**Interval → Cron Conversion:**
- Minutes: `0 */N * * * *` (every N minutes)
- Hours: `0 0 */N * * *` (every N hours on the hour)
- Days: `0 0 0 */N * *` (every N days at midnight)

**Event Sink Trait:**
```rust
pub trait HeartbeatSink: Send + Sync + 'static {
    fn emit_execution_completed(
        &self,
        heartbeat_id: &str,
        execution_id: &str,
        status: &str,
        severity: &str,
        summary: &str
    );
}
```

Emits `heartbeat://execution_completed` event with payload:
```json
{
  "heartbeatId": "uuid",
  "executionId": "uuid",
  "status": "completed",
  "severity": "critical",
  "summary": "3 checks completed, 2 critical findings"
}
```

#### Heartbeat Runner (`runner.rs`)

Orchestrates execution of a single heartbeat's checks.

**Key Method:**
```rust
pub async fn run_heartbeat(
    db: Arc<Mutex<Connection>>,
    agent_bridge: AgentBridge,
    heartbeat_id: &str
) -> Result<ExecutionResult>
```

**Execution Logic:**
1. Load heartbeat definition + checks from DB (sorted by `sort_order`)
2. Create execution record with status `running`
3. Group checks by `check_group_name`
4. For each group, spawn agent session via `agent_bridge` (parallel `tokio::spawn`)
5. Parse agent responses to extract findings with severity
   - Structured JSON if agent supports it
   - Keyword extraction (regex for "critical", "error", "warning", "ok") as fallback
6. Store findings in `heartbeat_findings` with parent `check_id`
7. Compute overall severity (worst of all findings)
8. Check for environment drift (optional): if agent mentions new devices/networks, generate suggestion
9. Update execution record with status, duration, severity
10. Return aggregated result

**Parallel Execution:**
```rust
let handles: Vec<_> = check_groups.iter()
    .map(|group| tokio::spawn(execute_check_group(group)))
    .collect();
let results = futures::future::join_all(handles).await;
```

**Timeout:** 5-minute timeout per check group (configurable):
```rust
tokio::time::timeout(Duration::from_secs(300), execute_check_group(group))
```

On timeout, mark check as `error` severity with finding: "Check timed out after 5 minutes"

**Error Handling:** Individual check failures don't abort execution; other checks continue, failed check marked `error` severity.

#### Heartbeat Repository (`repo.rs`)

Database CRUD operations following existing repo patterns.

**Key Methods:**
- `create_heartbeat(conn, name, description, interval_minutes, retention_days)` → `Result<Heartbeat>`
- `add_check(conn, heartbeat_id, group_name, agent_id, prompt, sort_order)` → `Result<Check>`
- `update_heartbeat(conn, id, name, interval_minutes, retention_days)` → `Result<()>`
- `update_checks(conn, heartbeat_id, checks)` → `Result<()>` (transactional replace)
- `list_heartbeats(conn)` → `Result<Vec<Heartbeat>>`
- `get_heartbeat_with_checks(conn, id)` → `Result<Option<HeartbeatDetail>>`
- `delete_heartbeat(conn, id)` → `Result<()>` (cascade delete via FK)
- `get_execution_history(conn, heartbeat_id, limit)` → `Result<Vec<Execution>>`
- `get_execution_detail(conn, execution_id)` → `Result<Option<ExecutionDetail>>` (hierarchical: execution → checks → findings)
- `prune_old_executions(conn, heartbeat_id, retention_days)` → `Result<usize>` (cleanup job)
- `create_suggestion(conn, heartbeat_id, suggestion_type, description, proposed_checks_json)` → `Result<Suggestion>`
- `get_suggestions(conn, heartbeat_id)` → `Result<Vec<Suggestion>>` (only non-dismissed)
- `dismiss_suggestion(conn, suggestion_id)` → `Result<()>` (sets `dismissed_at`)

#### Heartbeat Commands (`commands.rs`)

Tauri IPC handlers exposing functionality to frontend.

**Command Signatures:**
```rust
#[tauri::command]
async fn heartbeat_create(
    name: String,
    description: String,
    interval_minutes: u32,
    retention_days: u32,
    checks: Vec<CheckInput>,
    state: State<'_, AppState>
) -> Result<Heartbeat, String>

#[tauri::command]
async fn heartbeat_list(
    state: State<'_, AppState>
) -> Result<Vec<Heartbeat>, String>

#[tauri::command]
async fn heartbeat_get(
    id: String,
    state: State<'_, AppState>
) -> Result<HeartbeatDetail, String>

#[tauri::command]
async fn heartbeat_update(
    id: String,
    name: String,
    interval_minutes: u32,
    retention_days: u32,
    state: State<'_, AppState>
) -> Result<Heartbeat, String>

#[tauri::command]
async fn heartbeat_update_checks(
    id: String,
    checks: Vec<CheckInput>,
    state: State<'_, AppState>
) -> Result<(), String>

#[tauri::command]
async fn heartbeat_pause(
    id: String,
    state: State<'_, AppState>
) -> Result<(), String>

#[tauri::command]
async fn heartbeat_resume(
    id: String,
    state: State<'_, AppState>
) -> Result<(), String>

#[tauri::command]
async fn heartbeat_delete(
    id: String,
    state: State<'_, AppState>
) -> Result<(), String>

#[tauri::command]
async fn heartbeat_trigger_now(
    id: String,
    state: State<'_, AppState>
) -> Result<String, String> // Returns execution_id

#[tauri::command]
async fn heartbeat_executions(
    id: String,
    limit: Option<u32>,
    state: State<'_, AppState>
) -> Result<Vec<Execution>, String>

#[tauri::command]
async fn heartbeat_execution_detail(
    execution_id: String,
    state: State<'_, AppState>
) -> Result<ExecutionDetail, String>

#[tauri::command]
async fn heartbeat_suggestions_get(
    id: String,
    state: State<'_, AppState>
) -> Result<Vec<Suggestion>, String>

#[tauri::command]
async fn heartbeat_suggestion_apply(
    suggestion_id: String,
    state: State<'_, AppState>
) -> Result<(), String>

#[tauri::command]
async fn heartbeat_suggestion_dismiss(
    suggestion_id: String,
    state: State<'_, AppState>
) -> Result<(), String>

#[tauri::command]
async fn heartbeat_export(
    id: String,
    state: State<'_, AppState>
) -> Result<String, String> // Returns JSON string

#[tauri::command]
async fn heartbeat_import(
    json: String,
    state: State<'_, AppState>
) -> Result<Heartbeat, String>
```

### Frontend Components

#### Heartbeat Tab (`HeartbeatTab.tsx`)

Main tab view showing all heartbeats in a card grid.

**Layout:**
- Top bar: **+ New Heartbeat** button, Filter dropdown, Sort dropdown
- Card grid (responsive, 2-3 columns): One card per heartbeat
- Empty state (no heartbeats): Large icon + "Create your first heartbeat" CTA

**Card Structure:**
```tsx
<Card>
  <CardHeader>
    <HeartbeatName />
    <StatusBadge severity={overall_severity} />
    {hasSuggestions && <SuggestionBadge count={suggestionCount} />}
  </CardHeader>
  <CardBody>
    <LastRun timestamp={last_run_at} status={last_status} />
    <NextRun timestamp={next_run_at} />
    <Interval value={interval_minutes} />
  </CardBody>
  <CardFooter>
    <Button onClick={handleRunNow}>Run Now</Button>
    <Button onClick={handleEdit}>Edit</Button>
    <Button onClick={handleTogglePause}>{enabled ? 'Pause' : 'Resume'}</Button>
    <Dropdown>
      <MenuItem onClick={handleClone}>Clone</MenuItem>
      <MenuItem onClick={handleExport}>Export</MenuItem>
      <MenuItem onClick={handleDelete}>Delete</MenuItem>
    </Dropdown>
  </CardFooter>
  {expanded && <ExecutionTimeline executions={executions} />}
</Card>
```

**Timeline View (expanded):**
- Horizontal timeline with circles representing executions
- Circle color: green (ok/info), yellow (warning), red (critical), gray (error)
- Tooltip on hover: timestamp, duration, summary
- Click circle → Opens `ExecutionDetailDrawer`

**Actions:**
- **+ New Heartbeat:** Opens `CreateHeartbeatModal`
- **Filter:** All / Running / Paused / Has Issues / Has Suggestions
- **Sort:** Name / Last Run / Next Run / Status

**State Management:**
```tsx
const { heartbeats, loadHeartbeats, loadExecutions } = useHeartbeatStore();
const [expandedCards, setExpandedCards] = useState<Set<string>>(new Set());

useEffect(() => {
  loadHeartbeats();
  const unsubscribe = listen('heartbeat://execution_completed', (event) => {
    loadHeartbeats(); // Refresh to show updated last_run
    if (expandedCards.has(event.payload.heartbeatId)) {
      loadExecutions(event.payload.heartbeatId); // Refresh timeline
    }
  });
  return unsubscribe;
}, []);
```

#### Create/Edit Heartbeat Modal (`CreateHeartbeatModal.tsx`)

Two-stage wizard: Natural Language input → Structured plan review.

**Stage 1: Natural Language Input**
```tsx
<Modal>
  <Header>Create Heartbeat</Header>
  <Body>
    <Label>Describe what you want to monitor and how often</Label>
    <Textarea
      placeholder="Example: Check for critical issues on my Meraki network Shaun-home every hour"
      value={nlInput}
      onChange={setNlInput}
      rows={5}
    />
    <ExamplePrompts>
      <ExampleChip onClick={() => setNlInput("Check for critical Meraki alerts every hour")}>
        Critical Meraki alerts every hour
      </ExampleChip>
      <ExampleChip onClick={() => setNlInput("Verify pyATS devices are reachable every 30 minutes")}>
        pyATS device health every 30 min
      </ExampleChip>
      <ExampleChip onClick={() => setNlInput("Monitor Stealthwatch for security events every 15 minutes")}>
        Stealthwatch security events every 15 min
      </ExampleChip>
    </ExamplePrompts>
  </Body>
  <Footer>
    <Button onClick={handleCancel}>Cancel</Button>
    <Button onClick={handleAnalyze} loading={analyzing}>Analyze</Button>
  </Footer>
</Modal>
```

**Stage 2: Plan Review**
```tsx
<Modal>
  <Header>Review Heartbeat Plan</Header>
  <Body>
    <FormGroup>
      <Label>Name</Label>
      <Input value={plan.name} onChange={setName} />
    </FormGroup>
    <FormGroup>
      <Label>Description</Label>
      <Textarea value={plan.description} onChange={setDescription} />
    </FormGroup>
    <FormGroup>
      <Label>Run Interval</Label>
      <IntervalInput value={plan.interval_minutes} onChange={setInterval} />
    </FormGroup>
    <FormGroup>
      <Label>Checks</Label>
      <ChecksTable
        checks={plan.checks}
        onReorder={handleReorder}
        onAdd={handleAddCheck}
        onRemove={handleRemoveCheck}
        onEdit={handleEditCheck}
      />
    </FormGroup>
    <FormGroup>
      <Label>Retention Policy</Label>
      <Input type="number" min={1} value={plan.retention_days} onChange={setRetention} />
      <HelpText>Keep execution history for this many days</HelpText>
    </FormGroup>
  </Body>
  <Footer>
    <Button onClick={handleBack}>Back</Button>
    <Button onClick={handleCreate} disabled={!isValid}>Create Heartbeat</Button>
  </Footer>
</Modal>
```

**Checks Table:**
```tsx
<Table>
  <Thead>
    <Tr>
      <Th>Group Name</Th>
      <Th>Agent</Th>
      <Th>Prompt</Th>
      <Th>Actions</Th>
    </Tr>
  </Thead>
  <Tbody>
    {checks.map((check, index) => (
      <Tr key={index} draggable onDragStart={...} onDrop={...}>
        <Td>{check.check_group_name}</Td>
        <Td><AgentBadge id={check.agent_id} /></Td>
        <Td><TruncatedText text={check.agent_prompt} /></Td>
        <Td>
          <IconButton icon="edit" onClick={() => handleEdit(index)} />
          <IconButton icon="delete" onClick={() => handleRemove(index)} />
        </Td>
      </Tr>
    ))}
  </Tbody>
</Table>
<Button onClick={handleAddCheck}>+ Add Check</Button>
```

**Interval Input:**
- Number input + Unit dropdown (Minutes / Hours / Days)
- Converts to `interval_minutes` on submit
- Validation: minimum 1 minute, shows warning if < 5 minutes

#### Execution Detail Drawer (`ExecutionDetailDrawer.tsx`)

Slide-in drawer from right showing hierarchical findings.

**Layout:**
```tsx
<Drawer open={!!selectedExecution} onClose={handleClose}>
  <DrawerHeader>
    <Title>Execution Details</Title>
    <CloseButton onClick={handleClose} />
  </DrawerHeader>
  <DrawerBody>
    <ExecutionSummary
      timestamp={execution.started_at}
      duration={execution.duration_ms}
      status={execution.status}
      severity={execution.overall_severity}
    />
    <Divider />
    <FindingsTree>
      {execution.check_groups.map(group => (
        <Collapsible key={group.id} title={group.name} severity={group.severity}>
          {group.findings.map(finding => (
            <Finding key={finding.id}>
              <SeverityIcon severity={finding.severity} />
              <FindingTitle>{finding.title}</FindingTitle>
              <FindingMessage>{finding.message}</FindingMessage>
              {finding.metadata && (
                <Collapsible title="Details">
                  <MetadataTable data={finding.metadata} />
                </Collapsible>
              )}
            </Finding>
          ))}
        </Collapsible>
      ))}
    </FindingsTree>
  </DrawerBody>
  <DrawerFooter>
    <Button onClick={handleExportJson}>Export JSON</Button>
    <Button onClick={handleClose}>Close</Button>
  </DrawerFooter>
</Drawer>
```

**Collapsible Component:**
- Chevron icon (right = collapsed, down = expanded)
- Click header to toggle
- Default: first level expanded, children collapsed

**Severity Icons:**
- `ok`: Green checkmark
- `info`: Blue info circle
- `warning`: Yellow warning triangle
- `critical`: Red alert octagon
- `error`: Red X circle

#### Suggestion Review Modal (`SuggestionReviewModal.tsx`)

Shows AI-proposed changes when user clicks suggestion badge.

**Layout:**
```tsx
<Modal>
  <Header>Suggested Changes</Header>
  <Body>
    <Description>{suggestion.description}</Description>
    <Divider />
    <DiffView>
      <DiffSection title="Current Checks">
        {currentChecks.map(check => (
          <CheckRow key={check.id} removed={isRemoved(check)}>
            {check.check_group_name} - {check.agent_id}
          </CheckRow>
        ))}
      </DiffSection>
      <DiffSection title="Proposed Checks">
        {proposedChecks.map(check => (
          <CheckRow key={check.id} added={isAdded(check)}>
            {check.check_group_name} - {check.agent_id}
          </CheckRow>
        ))}
      </DiffSection>
    </DiffView>
    <Divider />
    <Reasoning>
      <Label>Why this change?</Label>
      <Text>{suggestion.reasoning}</Text>
    </Reasoning>
  </Body>
  <Footer>
    <Button onClick={handleDismiss}>Dismiss</Button>
    <Button onClick={handleApply} variant="primary">Apply Changes</Button>
  </Footer>
</Modal>
```

**Diff View:**
- Removed checks: red background, strikethrough
- Added checks: green background
- Unchanged checks: normal rendering

#### Heartbeat Store (`heartbeatStore.ts`)

Zustand store managing client-side state.

```typescript
import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

type Heartbeat = {
  id: string;
  name: string;
  description: string;
  interval_minutes: number;
  retention_days: number;
  enabled: boolean;
  next_run_at: number | null;
  created_at: number;
  updated_at: number;
};

type Execution = {
  id: string;
  heartbeat_id: string;
  status: 'running' | 'completed' | 'completed_with_errors' | 'failed';
  started_at: number;
  completed_at: number | null;
  duration_ms: number | null;
  overall_severity: 'ok' | 'info' | 'warning' | 'critical' | 'error';
};

type ExecutionDetail = {
  execution: Execution;
  check_groups: Array<{
    id: string;
    name: string;
    severity: string;
    findings: Array<{
      id: string;
      severity: string;
      title: string;
      message: string;
      metadata: Record<string, any> | null;
    }>;
  }>;
};

type Suggestion = {
  id: string;
  heartbeat_id: string;
  suggestion_type: 'add_checks' | 'remove_checks' | 'modify_checks';
  description: string;
  proposed_checks_json: string;
  created_at: number;
};

type Store = {
  heartbeats: Heartbeat[];
  executions: Record<string, Execution[]>;
  suggestions: Record<string, Suggestion[]>;
  selectedExecution: ExecutionDetail | null;
  
  loadHeartbeats: () => Promise<void>;
  loadExecutions: (heartbeatId: string) => Promise<void>;
  loadSuggestions: (heartbeatId: string) => Promise<void>;
  loadExecutionDetail: (executionId: string) => Promise<void>;
  clearExecutionDetail: () => void;
};

export const useHeartbeatStore = create<Store>((set, get) => {
  // Set up event listener on mount
  let unsubscribe: (() => void) | null = null;
  
  (async () => {
    unsubscribe = await listen('heartbeat://execution_completed', (event: any) => {
      const { heartbeatId } = event.payload;
      get().loadHeartbeats();
      if (get().executions[heartbeatId]) {
        get().loadExecutions(heartbeatId);
      }
    });
  })();

  return {
    heartbeats: [],
    executions: {},
    suggestions: {},
    selectedExecution: null,
    
    loadHeartbeats: async () => {
      const heartbeats = await invoke<Heartbeat[]>('heartbeat_list');
      set({ heartbeats });
    },
    
    loadExecutions: async (heartbeatId: string) => {
      const executions = await invoke<Execution[]>('heartbeat_executions', { 
        id: heartbeatId,
        limit: 50
      });
      set(state => ({
        executions: { ...state.executions, [heartbeatId]: executions }
      }));
    },
    
    loadSuggestions: async (heartbeatId: string) => {
      const suggestions = await invoke<Suggestion[]>('heartbeat_suggestions_get', { 
        id: heartbeatId 
      });
      set(state => ({
        suggestions: { ...state.suggestions, [heartbeatId]: suggestions }
      }));
    },
    
    loadExecutionDetail: async (executionId: string) => {
      const detail = await invoke<ExecutionDetail>('heartbeat_execution_detail', { 
        executionId 
      });
      set({ selectedExecution: detail });
    },
    
    clearExecutionDetail: () => {
      set({ selectedExecution: null });
    }
  };
});
```

### Sidecar Components

#### Heartbeat Planner Agent (`heartbeat_planner.py`)

Converts natural language to structured check plan.

**Agent Definition (Markdown):**
```markdown
---
name: Heartbeat Planner
description: Converts natural language monitoring goals to structured check plans
system-prompt: |
  You are a network monitoring expert. Users will describe what they want to monitor.
  Analyze their request, identify which agents can fulfill it, and propose a structured check plan.
  
  Available agents:
  - meraki: Cisco Meraki Dashboard API (networks, devices, alerts, clients, etc.)
  - pyats: PyATS testbed health checks (device reachability, interface status, routing protocols)
  - stealthwatch: Cisco Stealthwatch security events and flow analytics
  - ise: Cisco ISE endpoint tracking and policy compliance
  - cml: Cisco Modeling Labs topology and simulation management
  - catalyst_center: Cisco Catalyst Center device inventory and assurance
  - And others as configured
  
  Your output MUST be valid JSON matching this schema:
  {
    "name": "Short descriptive name",
    "description": "Detailed description of what this heartbeat monitors",
    "interval_minutes": 60,
    "check_groups": [
      {
        "group_name": "Group label (e.g., 'Meraki Health')",
        "agent_id": "meraki",
        "prompt": "Specific query for the agent (e.g., 'List all critical alerts for network Shaun-home')"
      }
    ]
  }
  
  Extract interval from phrases like "every hour" (60), "every 30 minutes" (30), "every day" (1440).
  Default to 60 minutes if not specified.
execution-mode: code
---

Parse the user's natural language input and generate a structured check plan.
Use the available agents (meraki, pyats, stealthwatch, ise, cml, catalyst_center) to fulfill the monitoring goal.
Be specific in agent prompts - include network names, device groups, severity levels, etc. from the user's request.
```

**Python Implementation:**
```python
import json
import re
from typing import Dict, Any

def execute(ctx: Dict[str, Any]) -> Dict[str, Any]:
    """Convert NL monitoring goal to structured check plan."""
    nl_input = ctx.get('user_input', '')
    
    # Extract interval
    interval_minutes = extract_interval(nl_input)
    
    # Extract entities (network names, testbed names, etc.)
    entities = extract_entities(nl_input)
    
    # Identify relevant agents
    agents = identify_agents(nl_input)
    
    # Generate check groups
    check_groups = []
    for agent in agents:
        prompt = generate_agent_prompt(agent, entities, nl_input)
        group_name = f"{agent.title()} Health"
        check_groups.append({
            "group_name": group_name,
            "agent_id": agent,
            "prompt": prompt
        })
    
    # Generate name and description
    name = generate_name(nl_input, agents)
    description = generate_description(nl_input, agents, interval_minutes)
    
    plan = {
        "name": name,
        "description": description,
        "interval_minutes": interval_minutes,
        "check_groups": check_groups
    }
    
    return {"status": "success", "plan": plan}

def extract_interval(text: str) -> int:
    """Extract interval from NL text."""
    # Match patterns like "every X minutes/hours/days"
    patterns = [
        (r'every (\d+) minute', 1),
        (r'every (\d+) hour', 60),
        (r'every (\d+) day', 1440),
        (r'every hour', 60),
        (r'every day', 1440),
    ]
    
    text_lower = text.lower()
    for pattern, multiplier in patterns:
        match = re.search(pattern, text_lower)
        if match:
            if match.groups():
                return int(match.group(1)) * multiplier
            return multiplier
    
    return 60  # Default: every hour

def extract_entities(text: str) -> Dict[str, Any]:
    """Extract network names, testbed names, device groups, etc."""
    entities = {}
    
    # Meraki network names (look for "network <name>")
    meraki_match = re.search(r'(?:meraki\s+)?network\s+(\S+)', text, re.IGNORECASE)
    if meraki_match:
        entities['meraki_network'] = meraki_match.group(1)
    
    # pyATS testbed names (look for "testbed <name>" or "pyats <name>")
    pyats_match = re.search(r'(?:pyats|testbed)\s+(\S+)', text, re.IGNORECASE)
    if pyats_match:
        entities['pyats_testbed'] = pyats_match.group(1)
    
    return entities

def identify_agents(text: str) -> list[str]:
    """Identify which agents to use based on keywords."""
    text_lower = text.lower()
    agents = []
    
    keywords = {
        'meraki': ['meraki', 'dashboard', 'wireless', 'access point'],
        'pyats': ['pyats', 'testbed', 'device', 'router', 'switch', 'reachability'],
        'stealthwatch': ['stealthwatch', 'security', 'flow', 'threat'],
        'ise': ['ise', 'endpoint', 'policy', 'authentication'],
        'cml': ['cml', 'modeling', 'simulation', 'lab'],
        'catalyst_center': ['catalyst', 'dnac', 'assurance', 'inventory'],
    }
    
    for agent, words in keywords.items():
        if any(word in text_lower for word in words):
            agents.append(agent)
    
    # Default to meraki if nothing matched
    if not agents:
        agents.append('meraki')
    
    return agents

def generate_agent_prompt(agent: str, entities: Dict[str, Any], nl_input: str) -> str:
    """Generate specific prompt for an agent."""
    prompts = {
        'meraki': f"List all critical and warning alerts for network {entities.get('meraki_network', 'all networks')}",
        'pyats': f"Run health checks on all devices in testbed {entities.get('pyats_testbed', 'default')}. Check device reachability and interface status.",
        'stealthwatch': "Check for high-severity security events in the last hour",
        'ise': "List endpoints with policy compliance issues",
        'cml': "Check status of all running simulations",
        'catalyst_center': "List devices with health score below 7",
    }
    
    # Customize based on keywords in NL input
    if 'critical' in nl_input.lower():
        if agent == 'meraki':
            return f"List all critical alerts for network {entities.get('meraki_network', 'all networks')}"
    
    return prompts.get(agent, f"Perform health check for {agent}")

def generate_name(nl_input: str, agents: list[str]) -> str:
    """Generate short descriptive name."""
    agent_names = ", ".join(a.title() for a in agents)
    return f"{agent_names} Health Monitor"

def generate_description(nl_input: str, agents: list[str], interval: int) -> str:
    """Generate detailed description."""
    unit = "minute" if interval == 1 else "minutes"
    if interval >= 1440:
        interval = interval // 1440
        unit = "day" if interval == 1 else "days"
    elif interval >= 60:
        interval = interval // 60
        unit = "hour" if interval == 1 else "hours"
    
    return f"Monitors {', '.join(agents)} every {interval} {unit}. {nl_input}"
```

#### Heartbeat Drift Detector (Optional Phase 2)

Environment change detection - can be integrated into runner initially, extracted to dedicated agent later.

**Logic:**
1. During execution, check if agent response contains new entities (devices, networks)
2. Compare against last execution's metadata
3. If changes detected, generate suggestion
4. Store in `heartbeat_suggestions` table

**Example:**
```python
def detect_drift(last_execution_metadata: dict, current_execution_metadata: dict) -> Optional[Suggestion]:
    """Detect environment changes and generate suggestion."""
    last_devices = set(last_execution_metadata.get('devices', []))
    current_devices = set(current_execution_metadata.get('devices', []))
    
    new_devices = current_devices - last_devices
    removed_devices = last_devices - current_devices
    
    if new_devices or removed_devices:
        description = f"Environment changed: {len(new_devices)} new devices, {len(removed_devices)} removed"
        proposed_checks = generate_checks_for_new_devices(new_devices)
        
        return Suggestion(
            suggestion_type='add_checks' if new_devices else 'remove_checks',
            description=description,
            proposed_checks_json=json.dumps(proposed_checks)
        )
    
    return None
```

## Error Handling

### Scheduler Failures

**Invalid interval / DB locked / Scheduler shutdown during registration:**
- `add_heartbeat()` returns `Result`, surface error to frontend with specific message
- Heartbeat saved to DB but marked `enabled: false`, requires manual resume
- Scheduler restart attempts to re-register all enabled heartbeats, logs failures without crashing

**Scheduler crash mid-execution:**
- Cron callback wrapped in `catch_unwind` to prevent panic propagation
- Execution record marked `failed` with error message
- Event emitted with `status: "error"`
- Next scheduled run proceeds normally

### Agent Execution Failures

**Agent timeout (hangs, doesn't respond):**
- 5-minute timeout per check group (configurable)
- `tokio::time::timeout()` wraps agent bridge call
- On timeout, mark check as `error` severity: "Check timed out after 5 minutes"
- Other checks continue executing
- Overall execution status: `completed_with_errors`

**Agent returns unparseable response:**
- Fallback parsing: treat entire response as plain text
- Keyword extraction: regex for "critical", "error", "warning", "ok" → severity
- If no keywords, default to `info` severity
- Finding message: full agent response text
- Log warning for debugging

**Agent not found (deleted agent):**
- Pre-execution validation: check all `agent_id` references exist
- If missing, mark check as `error`: "Agent 'xyz' not found. Was it deleted?"
- Suggestion system proposes removing invalid check
- User prompted to edit heartbeat or dismiss

### Database Failures

**Database locked during write:**
- Retry logic: 3 attempts with exponential backoff (100ms, 500ms, 2s)
- If all fail, execution marked `failed`, error logged
- Scheduler continues, next execution attempts normally
- User sees "Database error" with retry advice

**Foreign key violation (heartbeat deleted while executing):**
- Runner checks heartbeat still exists before writing results
- If deleted, abort result write, log warning, clean up in-memory state
- No error surfaced (heartbeat already gone from UI)

### Notification Failures

**Desktop notification permission denied / API unavailable:**
- Notification call wrapped in `catch_unwind`, never fails execution
- Log warning: "Desktop notifications disabled"
- Settings tab includes permission check + request button
- Fallback: in-app badge on Heartbeat tab icon (red dot) for critical findings

**Sound file missing / audio API fails:**
- Sound is optional enhancement, failure is silent (log warning only)
- Settings allow disabling sound independently

### Retention Policy Edge Cases

**User sets retention to 0 days:**
- Validation: minimum retention is 1 day
- Frontend input enforces `min="1"`
- Backend validates: `if retention_days < 1 { return Err(...) }`

**Retention cleanup while user viewing detail:**
- Cleanup only deletes execution records, not currently-open detail
- Detail view loaded into memory, survives DB deletion
- Refresh/re-open shows "Execution not found" if cleaned up

### Concurrent Modifications

**User edits heartbeat while executing:**
- Execution uses snapshot of check plan from DB at start time
- Edits don't affect in-flight execution
- Next scheduled run uses updated plan
- No locking needed (eventual consistency is fine)

**Two "Run Now" clicks in quick succession:**
- Debounce button: 2-second cooldown
- Backend check: if execution with status `running` exists, return existing execution ID (idempotent)
- Frontend toast: "Execution already running, see results in history"

### Interval Edge Cases

**Very short interval (e.g., every 1 minute) with slow checks:**
- Validation warning: if interval < estimated execution time, show alert: "Checks may overlap. Recommended: at least 5 minutes"
- Allow override (user knows their workload)
- Scheduler: if previous execution still running when next tick fires, skip tick and log warning
- Dashboard shows "Overlapping executions" warning badge

**Very long interval (e.g., every 365 days):**
- No upper limit enforcement (valid use case: annual audits)
- Next run timestamp displayed as date, not countdown
- "Run Now" button always available

### Export/Import Edge Cases

**Import references agents that don't exist:**
- Validation on import: check all `agent_id` values exist
- If missing, show modal: "Missing agents: [list]. Continue anyway?" (creates disabled heartbeat)
- User can enable after installing missing agents

**Import references missing vault credentials:**
- Vault credentials bound to agents, not heartbeats
- Agent execution fails if credentials missing (standard agent error)
- Heartbeat execution marked `error`, finding explains missing credentials

## Testing Strategy

### Unit Tests (Rust)

**Heartbeat Repository (`heartbeat/repo.rs`):**
- `test_create_heartbeat` — Insert, verify fields persisted
- `test_add_checks` — Add multiple checks, verify sort order
- `test_update_heartbeat` — Modify interval/retention, verify changes
- `test_delete_heartbeat_cascades` — Delete, verify checks/executions/findings deleted
- `test_prune_old_executions` — Create old executions, verify cleanup
- `test_get_execution_hierarchy` — Create nested findings, verify tree structure

**Heartbeat Scheduler (`heartbeat/scheduler.rs`):**
- `test_interval_to_cron_conversion` — Verify minutes/hours/days → cron
- `test_add_and_register` — Add heartbeat, verify job registered
- `test_pause_unregisters_job` — Pause, verify job removed
- `test_resume_reregisters_job` — Resume, verify job re-added
- `test_delete_unregisters_and_removes` — Delete, verify job + DB gone
- `test_trigger_now_executes_immediately` — Manual trigger bypasses schedule
- `test_scheduler_restart_loads_enabled` — Shutdown/restart, verify only enabled loaded

**Heartbeat Runner (`heartbeat/runner.rs`):**
- `test_run_single_check` — Execute with one check, verify record created
- `test_run_multiple_checks_parallel` — Execute 3 checks, verify concurrent (timing test)
- `test_timeout_handling` — Mock hanging agent, verify timeout after 5 min
- `test_agent_error_doesnt_abort` — One check fails, others continue
- `test_severity_aggregation` — Mixed severities, verify worst-case overall
- `test_suggestion_generation` — Mock "new device" response, verify suggestion created
- `test_execution_failure_marked` — DB write failure, verify marked `failed`

### Integration Tests (Rust)

**End-to-End Execution (`tests/heartbeat_e2e_test.rs`):**
- `test_create_schedule_execute_cycle` — Create → wait for execution → verify results
- `test_manual_trigger` — Create, trigger now, verify immediate execution
- `test_multiple_heartbeats_independent` — Create 2 with different intervals, verify both execute
- `test_agent_bridge_integration` — Real agent call (test agent), verify findings parsed
- `test_notification_sink` — Mock sink receives event on critical finding

**Database Migration (`tests/heartbeat_migration_test.rs`):**
- `test_v0063_migration` — Apply migration, verify tables/indexes created
- `test_foreign_key_cascade` — Delete heartbeat, verify cascade

### Unit Tests (TypeScript)

**Heartbeat Store (`state/heartbeatStore.test.ts`):**
- `test_load_heartbeats` — Mock Tauri call, verify store populates
- `test_event_listener_updates` — Emit event, verify store refreshes
- `test_load_executions` — Mock history call, verify store populates
- `test_load_suggestions` — Mock suggestions call, verify store populates

**Create Modal (`components/CreateHeartbeatModal.test.tsx`):**
- `test_nl_input_dispatch` — Type NL query, click Analyze, verify sidecar call
- `test_plan_review_editable` — Mock planner response, verify fields editable
- `test_validation_errors` — Empty name/invalid interval, verify error messages
- `test_create_dispatch` — Submit valid plan, verify Tauri create call

**Heartbeat Tab (`components/HeartbeatTab.test.tsx`):**
- `test_renders_heartbeat_cards` — Mock heartbeats, verify cards render
- `test_expand_shows_timeline` — Click card, verify timeline rendered
- `test_run_now_button` — Click Run Now, verify Tauri trigger call
- `test_suggestion_badge_shown` — Heartbeat with suggestions, verify badge displayed
- `test_filter_by_status` — Select "Has Issues", verify only failed shown

**Execution Detail Drawer (`components/ExecutionDetailDrawer.test.tsx`):**
- `test_hierarchical_rendering` — Mock nested findings, verify tree structure
- `test_collapse_expand_groups` — Click group header, verify children toggle
- `test_export_json` — Click Export, verify JSON download

### Integration Tests (Playwright)

**E2E Heartbeat Flow (`e2e/heartbeat.spec.ts`):**
- `test_create_and_execute_heartbeat` — Create via UI → wait → verify results displayed
- `test_edit_heartbeat` — Create → Edit interval → verify next run updated
- `test_pause_resume` — Create → Pause → verify no execution → Resume → verify resumes
- `test_suggestion_workflow` — Mock drift → verify badge → review → apply → verify updated
- `test_desktop_notification` — Mock critical finding → verify notification (may need manual check)

### Python Tests (Sidecar)

**Heartbeat Planner (`tests/test_heartbeat_planner.py`):**
- `test_parse_meraki_request` — Input "Check Meraki network Foo", verify plan includes meraki agent
- `test_parse_pyats_request` — Input "Check pyATS testbed Bar", verify plan includes pyats agent
- `test_parse_multi_agent_request` — Input "Check Meraki and Stealthwatch", verify both in plan
- `test_interval_extraction` — Input "every 2 hours", verify `interval_minutes: 120`
- `test_invalid_input` — Input gibberish, verify error response or fallback plan

**Heartbeat Drift Detector (`tests/test_heartbeat_drift.py`):**
- `test_detect_new_device` — Last state: 3 devices, current: 4 → verify suggestion generated
- `test_detect_removed_device` — Last state: 4 devices, current: 3 → verify suggestion generated
- `test_no_changes` — Last state == current → verify no suggestion
- `test_first_execution` — No last state → verify no suggestion (baseline established)

### Manual Test Scenarios

**Desktop Notifications (macOS/Windows):**
1. Create heartbeat that will find critical issue
2. Wait for scheduled execution
3. Verify desktop notification appears with sound
4. Click notification, verify app focuses and navigates to Heartbeat tab

**Long-Running Execution:**
1. Create heartbeat with 10+ checks (large pyATS testbed)
2. Trigger manually
3. Verify UI shows "Running..." spinner
4. Verify execution completes after expected duration
5. Verify no timeout false positives

**Retention Policy:**
1. Create heartbeat with 1-day retention
2. Manually create old execution records (SQL insert with past timestamp)
3. Wait 24 hours or manually trigger cleanup
4. Verify old executions deleted, recent ones retained

**Scheduler Resilience:**
1. Create heartbeat scheduled every 5 minutes
2. Force-quit app during execution
3. Restart app
4. Verify scheduler recovers, next execution fires on schedule

## Implementation Phases

### Phase 1: Backend Core (Rust)
- Migration V0063 (schema)
- Heartbeat repository (CRUD)
- Heartbeat scheduler (tokio-cron wrapper, interval → cron conversion)
- Heartbeat runner (basic execution, no drift detection yet)
- Tauri commands (all 17 commands)
- Unit tests for repo, scheduler, runner

**Deliverable:** Backend can create heartbeats, schedule executions, store results

### Phase 2: Frontend Dashboard (React)
- Add `heartbeat` to `TabType` union
- Heartbeat store (Zustand)
- HeartbeatTab component (card grid, timeline)
- ExecutionDetailDrawer component
- Unit tests for store, tab, drawer
- Integration: Wire up Tauri commands

**Deliverable:** Dashboard shows heartbeats, executions, findings (read-only)

### Phase 3: Creation Flow (React + Python)
- Heartbeat planner agent (Python)
- CreateHeartbeatModal component (two-stage wizard)
- Integration: NL input → planner → plan review → create
- Unit tests for modal
- Python tests for planner

**Deliverable:** Users can create heartbeats via natural language

### Phase 4: Management & Notifications
- Edit/pause/resume/delete functionality in HeartbeatTab
- Export/import functionality
- Desktop notifications via Tauri API
- Suggestion review modal (UI only, no AI yet)
- Settings tab entry for notification preferences
- Manual trigger ("Run Now" button)

**Deliverable:** Full CRUD, notifications, manual execution

### Phase 5: Drift Detection & Suggestions (Optional)
- Heartbeat drift detector logic in runner
- Suggestion generation during execution
- AI-powered suggestion reasoning
- Suggestion review workflow (apply/dismiss)
- Unit tests for drift detection

**Deliverable:** Adaptive heartbeats that suggest check updates

### Phase 6: Polish & Optimization
- Retention policy cleanup job (scheduled task)
- Performance optimization (parallel execution tuning)
- Error handling polish (retry logic, better error messages)
- Playwright E2E tests
- Documentation (user guide section)

**Deliverable:** Production-ready feature

## Success Criteria

### Functional Requirements
- ✅ User can create heartbeat via natural language input
- ✅ User can review/edit proposed check plan before saving
- ✅ Heartbeat executes on schedule (every X minutes/hours/days)
- ✅ Dashboard shows all heartbeats with status indicators
- ✅ Execution history visible in timeline view
- ✅ Hierarchical drill-down: heartbeat → executions → check groups → findings
- ✅ Desktop notifications for critical findings
- ✅ Manual "Run Now" trigger
- ✅ Edit heartbeat (name, interval, checks, retention)
- ✅ Pause/resume heartbeat
- ✅ Delete heartbeat (cascade)
- ✅ Clone heartbeat
- ✅ Export/import heartbeat definition
- ✅ Configurable retention policy (per-heartbeat)
- ✅ AI suggests check updates when environment changes

### Non-Functional Requirements
- ✅ Execution timeout: 5 minutes per check group
- ✅ Parallel execution: Multiple check groups run concurrently
- ✅ Individual check failures don't abort execution
- ✅ Scheduler survives app restart (loads enabled heartbeats)
- ✅ Database operations use transactions (check updates, cascade deletes)
- ✅ Frontend updates in real-time via Tauri events
- ✅ No blocking UI operations (all Tauri calls async)

### User Experience Requirements
- ✅ Creation flow completes in < 30 seconds (including AI analysis)
- ✅ Dashboard loads < 1 second for 100 heartbeats
- ✅ Execution detail renders < 500ms for 1000 findings
- ✅ Notifications appear within 5 seconds of critical finding
- ✅ Clear error messages for all failure modes
- ✅ No data loss on app crash (execution state persisted)

## Open Questions & Future Enhancements

### Deferred to Future Iterations
- **Escalation policies:** Email/Slack notifications for critical findings (requires external integrations)
- **SLA tracking:** Measure time-to-resolution for issues detected by heartbeats
- **Trend analysis:** Graph finding frequency over time, detect patterns
- **Custom severity rules:** User-defined keywords/regex to override severity classification
- **Heartbeat dependencies:** "Run heartbeat B only if heartbeat A finds issues"
- **Multi-tenancy:** Separate heartbeats per user/team (requires auth system)
- **Webhook integrations:** POST execution results to external services

### Technical Debt Considerations
- **Scheduler abstraction:** If more scheduled task types added (backups, audits), consider extracting generic `scheduled_tasks` framework (Approach C from earlier)
- **Agent response parsing:** Currently relies on keyword extraction; could be improved with structured output format from agents
- **Execution concurrency limits:** No cap on parallel check groups yet; may need throttling for large heartbeats (e.g., 100+ checks)

## Appendix

### Example Heartbeat Definitions

**Example 1: Meraki Critical Alerts**
```json
{
  "name": "Meraki Critical Alerts",
  "description": "Monitor Meraki network Shaun-home for critical and warning alerts every hour",
  "interval_minutes": 60,
  "retention_days": 30,
  "checks": [
    {
      "check_group_name": "Meraki Alerts",
      "agent_id": "meraki",
      "prompt": "List all critical and warning alerts for network Shaun-home",
      "sort_order": 0
    }
  ]
}
```

**Example 2: pyATS Device Health**
```json
{
  "name": "Lab Devices Health Check",
  "description": "Verify all devices in pyATS testbed lab-core are reachable and healthy every 30 minutes",
  "interval_minutes": 30,
  "retention_days": 7,
  "checks": [
    {
      "check_group_name": "Device Reachability",
      "agent_id": "pyats",
      "prompt": "Check if all devices in testbed lab-core are reachable",
      "sort_order": 0
    },
    {
      "check_group_name": "Interface Status",
      "agent_id": "pyats",
      "prompt": "Check interface status for all devices in testbed lab-core",
      "sort_order": 1
    }
  ]
}
```

**Example 3: Multi-Agent Security Monitoring**
```json
{
  "name": "Security Monitoring",
  "description": "Monitor Stealthwatch and ISE for security events every 15 minutes",
  "interval_minutes": 15,
  "retention_days": 90,
  "checks": [
    {
      "check_group_name": "Stealthwatch Security Events",
      "agent_id": "stealthwatch",
      "prompt": "Check for high-severity security events in the last 15 minutes",
      "sort_order": 0
    },
    {
      "check_group_name": "ISE Policy Compliance",
      "agent_id": "ise",
      "prompt": "List endpoints with policy compliance issues",
      "sort_order": 1
    }
  ]
}
```

### Interval Conversion Reference

| User Input | interval_minutes | Cron Expression |
|------------|------------------|-----------------|
| Every 1 minute | 1 | `0 */1 * * * *` |
| Every 5 minutes | 5 | `0 */5 * * * *` |
| Every 30 minutes | 30 | `0 */30 * * * *` |
| Every 1 hour | 60 | `0 0 */1 * * *` |
| Every 2 hours | 120 | `0 0 */2 * * *` |
| Every 12 hours | 720 | `0 0 */12 * * *` |
| Every 1 day | 1440 | `0 0 0 */1 * *` |
| Every 7 days | 10080 | `0 0 0 */7 * *` |

### Severity Classification

**ok:** Check completed successfully, no issues found  
**info:** Informational findings, no action required  
**warning:** Potential issues detected, should investigate  
**critical:** Severe issues requiring immediate attention  
**error:** Check failed to execute (timeout, agent error, etc.)

**Overall severity:** Worst severity across all findings in an execution

### Desktop Notification Format

**Title:** "Heartbeat Alert: {heartbeat_name}"  
**Body:** "{summary_line} - Click to view details"  
**Sound:** System default alert sound (configurable)  
**Action:** Click notification → Focus app → Navigate to Heartbeat tab → Auto-expand affected heartbeat → Auto-open latest execution detail

Example:
```
Title: Heartbeat Alert: Meraki Critical Alerts
Body: 3 critical alerts found on network Shaun-home - Click to view details
```

### Export/Import Format

Heartbeat exports as JSON with metadata:

```json
{
  "version": "1.0",
  "exported_at": 1719360000,
  "heartbeat": {
    "name": "Meraki Critical Alerts",
    "description": "Monitor Meraki network Shaun-home for critical and warning alerts every hour",
    "interval_minutes": 60,
    "retention_days": 30,
    "checks": [
      {
        "check_group_name": "Meraki Alerts",
        "agent_id": "meraki",
        "prompt": "List all critical and warning alerts for network Shaun-home",
        "sort_order": 0
      }
    ]
  }
}
```

Import validates:
- Version compatibility (only v1.0 supported currently)
- All referenced agents exist
- Interval > 0
- Retention >= 1

---

**End of Design Document**

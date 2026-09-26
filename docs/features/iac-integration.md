# IaC Integration (Phase 1)

## Overview

Automatic detection and enriched display for Terraform and Ansible executions in CCIE Terminal. Infrastructure-as-Code commands are automatically recognized when run in the local zsh terminal, parsed for resource changes, and displayed with enhanced metadata and visual grouping.

## Features

- **Zero-configuration detection**: Just run `terraform apply` or `ansible-playbook` normally in your terminal
- **Parsed output**: Resource changes grouped by action (Created/Modified/Destroyed/Failed)
- **Git context**: Shows branch, commit, and uncommitted changes warning
- **Collapsible sections**: Clean display with expand/collapse for each action type
- **Error tracking**: Failed resources highlighted with error messages
- **Visual indicators**: Color-coded badges for exit status, resource counts, and duration

## Usage

### Terraform

```bash
cd my-infrastructure
terraform apply
```

The command block automatically displays:
- Exit code badge (green for success, red for errors)
- Resources changed count
- Duration
- Git branch and commit SHA
- Project path
- Collapsible sections for created/updated/destroyed resources
- Individual resource details with types, names, and IDs

### Ansible

```bash
cd my-playbooks
ansible-playbook -i inventory deploy.yml
```

Shows:
- Tasks executed count
- Changed/failed tasks by host
- Task names with host mappings
- Error messages for failed tasks
- Playbook execution summary

## Supported Commands

### Terraform
- `terraform apply` - Apply infrastructure changes
- `terraform destroy` - Destroy infrastructure
- `terraform plan` - Show planned changes (with `-out=file`)
- `tf apply` - Short alias support

### Ansible
- `ansible-playbook site.yml` - Run playbook
- `ansible all -m command` - Ad-hoc module execution
- `ansible-playbook -i inventory` - With inventory specification

### Not Detected
Commands that don't modify infrastructure are intentionally excluded:
- `terraform init`, `terraform fmt`, `terraform validate`
- `ansible --version`, `ansible-galaxy`, `ansible-vault`

## Architecture

### Detection Flow

1. User runs IaC command in local terminal (zsh with OSC 133 integration)
2. Command completes → `blocksStore.completeBlock()` triggers
3. Pattern matching detects `terraform|tf|ansible-playbook|ansible ... -m`
4. Backend `iac_process_block` Tauri command invoked with `block_id`

### Backend Processing

```rust
// src-tauri/src/commands/mod.rs
pub async fn iac_process_block(block_id: String) -> Result<Option<String>>
```

1. Reads command, output, and cwd from `command_blocks` table
2. Detector identifies tool (Terraform vs Ansible) and subcommand
3. Parser extracts resource events from output (JSON mode for TF, YAML for Ansible)
4. Git helpers query branch/commit SHA from working directory
5. Stores `iac_executions` row with parsed metadata

### Frontend Rendering

```typescript
// src/components/CommandBlock.tsx
if (block.iacExecutionId && !active) {
  return <IaCCommandBlock block={block} iacExecutionId={block.iacExecutionId} />;
}
```

The `IaCCommandBlock` component:
- Fetches full execution metadata via `get_iac_execution`
- Parses JSON metadata into typed structures
- Renders enriched UI with badges, collapsible sections, and git context

## Database Schema

IaC executions stored in `iac_executions` table (migration V0047):

```sql
CREATE TABLE iac_executions (
  id TEXT PRIMARY KEY,
  command_block_id TEXT NOT NULL REFERENCES command_blocks(id) ON DELETE CASCADE,
  tool TEXT NOT NULL,                    -- 'terraform' | 'ansible'
  subcommand TEXT NOT NULL,               -- 'apply' | 'destroy' | 'playbook'
  project_path TEXT NOT NULL,
  git_commit TEXT,                        -- SHA of HEAD
  git_branch TEXT,                        -- Current branch
  had_uncommitted_changes INTEGER NOT NULL DEFAULT 0,
  blast_radius TEXT,                      -- 'low' | 'medium' | 'high' (Phase 2)
  resources_changed INTEGER,              -- Total count
  resources_failed INTEGER,               -- Failed count
  metadata_json TEXT NOT NULL,            -- Parsed ResourceEvent[] array
  created_at INTEGER NOT NULL
);
```

### Metadata JSON Structure

```typescript
interface IaCMetadata {
  resources_changed: number;
  resources_failed: number;
  resource_events: ResourceEvent[];
  summary: string;
}

interface ResourceEvent {
  resource_type: string;     // 'aws_security_group', 'docker_container'
  resource_name: string;      // Terraform name or Ansible task
  resource_id?: string;       // Provider-assigned ID
  action: ResourceAction;     // Create | Update | Delete | NoOp | Fail
  timestamp: number;
  duration_ms?: number;
  error?: string;
}
```

## API Reference

### Tauri Commands

```rust
// Query execution metadata for enriched rendering
get_iac_execution(execution_id: String) -> Option<IaCExecution>

// Process completed block and store execution (auto-invoked by blocksStore)
iac_process_block(block_id: String) -> Option<String>
```

### Frontend Types

```typescript
// src/types/iac.ts
interface IaCExecution { ... }
interface IaCMetadata { ... }
interface ParsedIaCMetadata { ... }

// Parse raw execution into frontend-friendly structure
parseIaCExecution(exec: IaCExecution): ParsedIaCMetadata | null
```

### Block Store

```typescript
// src/state/blocksStore.ts
interface Block {
  // ... existing fields ...
  iacExecutionId?: string;  // NEW: Links to iac_executions table
}
```

## Testing

### Unit Tests

```bash
cd src-tauri
cargo test iac
```

Tests detector patterns, parsers, and database CRUD operations.

### Integration Tests

Requires `terraform` and `ansible-playbook` binaries installed:

```bash
cargo test integration_tests -- --ignored
```

- `test_terraform_apply_end_to_end`: Creates temp dir, runs `terraform apply`, validates detection + parsing
- `test_ansible_playbook_end_to_end`: Runs local playbook with `connection: local`, validates output

### Frontend Tests

```bash
bun test IaCCommandBlock
```

## Phase 2 Features (Planned)

- **Blast radius calculation**: Analyze resource types and counts to classify as low/medium/high risk
- **Pre-execution approval gates**: Require user confirmation before destructive operations
- **Terraform state browser**: Interactive viewer for `.tfstate` with resource graph visualization
- **Ansible inventory navigator**: Drill into hosts/groups from execution results
- **ReACT agent with IaC tools**: Natural language → generate → apply workflow with guardrails (✅ delivered — see Phase 4 below)

## Phase 4: Natural-Language Code Generation

The IaC agent (cli_package `iac`) can generate Terraform HCL and Ansible YAML
from natural-language intent, then apply it through the existing approval gate.

### Workflow

1. In the Agent panel, ask: *"add an HTTPS ingress rule from the office network to the prod ALB"*.
2. The agent calls `generate_terraform_code` and shows the HCL in a fenced code block with an explanation and blast-radius summary.
3. If you approve the direction, the agent writes the code to a `.tf` file in the working directory and calls `iac_apply`.
4. `iac_apply` pauses the graph and surfaces the **IaCApprovalModal** (same as Phase 2) with the computed blast radius. Approve to apply; cancel to abort.

### Tools

| Tool | Module | Purpose |
|------|--------|---------|
| `generate_terraform_code` | `agents/iac_codegen.py` | NL → HCL, with `terraform fmt` validation |
| `generate_ansible_playbook` | `agents/iac_codegen.py` | NL → YAML, with `--syntax-check` validation |
| `iac_apply` | `agents/iac_tools.py` | Gated apply (Phase 2; unchanged) |

The codegen tools are wired into the IaC agent in `agents/deepagents_runtime.py`
(`_iac_extra_tools`), alongside the gated `iac_apply`. Only `iac_apply` triggers
the human-approval interrupt — the codegen tools are read-only and return code
as JSON.

### Validation

Generated code is validated when the relevant binary is on `PATH`
(`terraform fmt` for HCL, `ansible-playbook --syntax-check` for YAML). When the
binary is absent, validation is skipped (`validation.skipped = true`) and the
code is returned unvalidated — the agent surfaces this to the user. On a
validation failure the agent retries generation once with the error fed back to
the model. `terraform fmt` checks HCL *syntax* only, not Terraform semantics.

### Notes

- No remote state backends, background drift polling, or cost estimation — out of
  scope per the v1 design.
- Generated code is not persisted to a database table; it lives in the chat
  transcript and the file the agent writes. Applies are recorded in
  `iac_executions` exactly as for any other IaC command.
- `terraform apply`/`destroy` and `ansible-playbook` cannot be run through the
  agent's `execute_python_code` sandbox (blocked by the IaC subprocess guard) —
  applies go only through the gated `iac_apply` path.

## Troubleshooting

### IaC commands not detected

1. Verify you're running in the **local zsh terminal** (not SSH session)
2. Check shell integration is active: `echo $ZDOTDIR/.zshenv` should show CCIE hooks
3. Confirm command matches detection patterns (see "Supported Commands" above)
4. Check browser console for `[IaC] Failed to process block` warnings

### Parse errors

- **Terraform**: Ensure output is NOT piped or redirected (parser needs raw stdout)
- **Ansible**: Use default output format (not JSON callback or custom stdout)
- Check `command_blocks.output` column has complete text (partial truncation breaks parser)

### Missing git context

- Run `git status` in the project directory to verify it's a git repo
- Ensure `git` binary is in PATH when CCIE Terminal launches
- Non-git projects will show `null` for branch/commit (expected behavior)

## Known Limitations

- **Local only**: Remote SSH sessions don't emit OSC 133, so IaC detection won't trigger
- **No streaming**: Large terraform applies buffer output; UI updates on completion only
- **Terraform workspaces**: Not tracked in Phase 1; all workspaces write to same project_path
- **Ansible vault**: Encrypted playbooks work, but sensitive output is stored unencrypted in DB

## Related Documentation

- [Command Blocks](../COMMAND_BLOCKS.md)
- OSC 133 shell integration: covered in Command Blocks setup
- [Structured Output Parsing](../STRUCTURED_OUTPUT.md)

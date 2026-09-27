// src/components/IaCCommandBlock.tsx
import { useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { Block } from '../state/blocksStore';
import type { ParsedIaCMetadata, ResourceEvent } from '../types/iac';
import { parseIaCExecution } from '../types/iac';
import './IaCCommandBlock.css';

interface IaCCommandBlockProps {
  block: Block;
  iacExecutionId: string;
}

export function IaCCommandBlock({ block, iacExecutionId }: IaCCommandBlockProps) {
  const [iacData, setIacData] = useState<ParsedIaCMetadata | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    invoke<any>('get_iac_execution', { executionId: iacExecutionId })
      .then((exec) => {
        if (exec) {
          const parsed = parseIaCExecution(exec);
          setIacData(parsed);
        }
        setLoading(false);
      })
      .catch((err) => {
        console.error('Failed to load IaC execution:', err);
        setLoading(false);
      });
  }, [iacExecutionId]);

  if (loading) {
    return <div className="iac-command-block loading">Loading IaC data...</div>;
  }

  if (!iacData) {
    return null; // Fallback to regular command block
  }

  return (
    <div className="iac-command-block">
      <IaCBlockHeader block={block} iacData={iacData} />
      <IaCBlockMetadata block={block} iacData={iacData} />
      <IaCBlockBody iacData={iacData} />
      <IaCBlockOutput block={block} iacData={iacData} />
    </div>
  );
}

/** Always-available view of the raw (ANSI-stripped) command output, so the
 *  enriched block never hides what the playbook/terraform run actually
 *  printed. Auto-expanded when there are no parsed resource events (e.g. a
 *  0-changed run) so the user still sees the PLAY RECAP / task results. */
function IaCBlockOutput({ block, iacData }: { block: Block; iacData: ParsedIaCMetadata }) {
  const hasEvents = iacData.metadata.resourceEvents.length > 0;
  const [open, setOpen] = useState(!hasEvents);
  const output = block.output ?? '';

  if (!output.trim()) return null;

  return (
    <div className="iac-resource-section iac-output-section">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="iac-section-header"
      >
        <span className="iac-section-toggle">{open ? '▼' : '▶'}</span>
        <span className="iac-section-title">Output</span>
      </button>
      {open && (
        <div className="iac-section-body">
          <pre className="iac-output-pre">{output}</pre>
        </div>
      )}
    </div>
  );
}

function IaCBlockHeader({ block, iacData }: { block: Block; iacData: ParsedIaCMetadata }) {
  const exitCodeClass = block.exitCode === 0 ? 'success' : 'error';

  return (
    <div className="iac-block-header">
      <div className="iac-header-left">
        <code className="iac-command">{block.command}</code>
        <span className={`iac-badge exit-code ${exitCodeClass}`}>
          EXIT {block.exitCode ?? '?'}
        </span>
        <span className="iac-badge resources-changed">
          {iacData.resourcesChanged} resources changed
        </span>
        {iacData.resourcesFailed && iacData.resourcesFailed > 0 && (
          <span className="iac-badge resources-failed">
            {iacData.resourcesFailed} failed
          </span>
        )}
        <span className="iac-badge duration">
          {formatDuration(block.durationMs)}
        </span>
      </div>
      <div className="iac-header-right">
        <button className="iac-action-btn" title="Copy output">📋</button>
        <button className="iac-action-btn" title="Rerun">🔄</button>
        {iacData.tool === 'terraform' && (
          <button className="iac-action-btn" title="View State">📊</button>
        )}
      </div>
    </div>
  );
}

function IaCBlockMetadata({ block, iacData }: { block: Block; iacData: ParsedIaCMetadata }) {
  return (
    <div className="iac-block-metadata">
      <span className="iac-metadata-item">
        📁 {iacData.projectPath}
      </span>
      {iacData.gitBranch && (
        <span className="iac-metadata-item">
          🌿 {iacData.gitBranch}
          {iacData.gitCommit && ` @ ${iacData.gitCommit.slice(0, 7)}`}
        </span>
      )}
      <span className="iac-metadata-item">
        🕐 {new Date(block.timestamp).toLocaleTimeString()}
      </span>
    </div>
  );
}

// Ordered list of action groups. Terraform runs populate Create/Update/Destroy;
// Ansible runs populate Changed/Ok/Skipped/Failed. Each section only renders
// when it has at least one event, so a block shows exactly the groups present.
const ACTION_GROUPS: {
  action: ResourceEvent['action'];
  title: string;
  color: string;
  unit: string;
}[] = [
  { action: 'Create', title: 'Created', color: 'green', unit: 'resources' },
  { action: 'Update', title: 'Modified', color: 'blue', unit: 'resources' },
  { action: 'Destroy', title: 'Destroyed', color: 'red', unit: 'resources' },
  { action: 'Changed', title: 'Changed', color: 'blue', unit: 'tasks' },
  { action: 'Ok', title: 'OK', color: 'green', unit: 'tasks' },
  { action: 'Skipped', title: 'Skipped', color: 'gray', unit: 'tasks' },
  { action: 'Failed', title: 'Failed', color: 'red', unit: 'tasks' },
];

function IaCBlockBody({ iacData }: { iacData: ParsedIaCMetadata }) {
  const events = iacData.metadata.resourceEvents;

  return (
    <div className="iac-block-body">
      {ACTION_GROUPS.map(({ action, title, color, unit }) => {
        const groupEvents = events.filter((e) => e.action === action);
        if (groupEvents.length === 0) return null;
        return (
          <ResourceSection
            key={action}
            title={title}
            count={groupEvents.length}
            unit={unit}
            events={groupEvents}
            color={color}
            // Collapse large "OK" / "Skipped" groups by default to keep the
            // block compact; keep failures and changes expanded.
            defaultCollapsed={action === 'Ok' || action === 'Skipped'}
          />
        );
      })}
    </div>
  );
}

function ResourceSection({
  title,
  count,
  unit,
  events,
  color,
  defaultCollapsed = false,
}: {
  title: string;
  count: number;
  unit: string;
  events: ResourceEvent[];
  color: string;
  defaultCollapsed?: boolean;
}) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed);

  return (
    <details open={!collapsed} className={`iac-resource-section color-${color}`}>
      <summary
        onClick={(e) => { e.preventDefault(); setCollapsed(!collapsed); }}
        className="iac-section-header"
      >
        <span className="iac-section-toggle">{collapsed ? '▶' : '▼'}</span>
        <span className="iac-section-title">{title} ({count} {unit})</span>
      </summary>
      <div className="iac-section-body">
        {events.map((event, idx) => (
          <div key={idx} className="iac-resource-item">
            <span className="iac-resource-icon">{getActionIcon(event.action)}</span>
            <code className="iac-resource-name">{formatResourceName(event)}</code>
            {event.resourceId && (
              <span className="iac-resource-id">{event.resourceId}</span>
            )}
            {event.error && (
              <span className="iac-resource-error">{event.error}</span>
            )}
          </div>
        ))}
      </div>
    </details>
  );
}

/** Terraform events carry a `type.name` address; Ansible events use a synthetic
 *  `ansible_task` type whose meaningful label is just the task name. Render the
 *  dotted address for real resources and the bare name for ansible tasks. */
function formatResourceName(event: ResourceEvent): string {
  if (event.resourceType === 'ansible_task' || event.resourceType === 'ansible_host') {
    return event.resourceName;
  }
  return `${event.resourceType}.${event.resourceName}`;
}

function getActionIcon(action: string): string {
  switch (action) {
    case 'Create': return '+';
    case 'Update': return '~';
    case 'Destroy': return '-';
    case 'Ok': return '✓';
    case 'Changed': return '⚡';
    case 'Skipped': return '⊘';
    case 'Failed': return '❌';
    default: return '•';
  }
}

function formatDuration(durationMs: number | undefined): string {
  if (!durationMs) return 'Running...';
  if (durationMs < 1000) return `${durationMs}ms`;
  return `${Math.floor(durationMs / 1000)}s`;
}

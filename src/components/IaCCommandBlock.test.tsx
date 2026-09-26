import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn<(...args: unknown[]) => unknown>(),
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));

import { IaCCommandBlock } from './IaCCommandBlock';
import type { Block } from '../state/blocksStore';
import type { IaCExecution, IaCMetadata } from '../types/iac';

afterEach(() => {
  invokeMock.mockReset();
});

function makeBlock(overrides: Partial<Block> = {}): Block {
  return {
    id: 'block-1',
    tabId: 'tab-1',
    command: 'ansible-playbook -i inventory.ini push-vlan.yml',
    cwd: '/repo',
    timestamp: 1_700_000_000_000,
    durationMs: 4000,
    exitCode: 0,
    output: 'TASK [Create VLAN 78] ...\nok: [device.example.test]\n',
    iacExecutionId: 'exec-1',
    ...overrides,
  } as Block;
}

/** Build the backend `get_iac_execution` response shape: an IaCExecution whose
 *  metadataJson is the serialized IaCMetadata (camelCase, matching Rust serde). */
function makeExecution(metadata: IaCMetadata, tool: 'terraform' | 'ansible' = 'ansible'): IaCExecution {
  return {
    id: 'exec-1',
    commandBlockId: 'block-1',
    tool,
    subcommand: tool === 'ansible' ? 'playbook' : 'apply',
    projectPath: '/repo',
    gitBranch: 'main',
    gitCommit: 'abc1234def',
    hadUncommittedChanges: false,
    blastRadius: 'low',
    resourcesChanged: metadata.resourcesChanged,
    resourcesFailed: metadata.resourcesFailed,
    metadataJson: JSON.stringify(metadata),
    createdAt: 0,
  };
}

describe('IaCCommandBlock', () => {
  it('renders per-task Ansible sections (Changed / OK / Skipped) for a 0-changed run', async () => {
    // The exact failure the user hit: a run with task results but 0 changed.
    const metadata: IaCMetadata = {
      resourcesChanged: 0,
      resourcesFailed: 0,
      summary: '5 task results, 0 changed, 0 failed',
      resourceEvents: [
        { resourceType: 'ansible_task', resourceName: 'Ensure cisco.ios collection', resourceId: 'device.example.test', action: 'Ok', timestamp: 1 },
        { resourceType: 'ansible_task', resourceName: 'Create VLAN 78', resourceId: 'device.example.test', action: 'Ok', timestamp: 1 },
        { resourceType: 'ansible_task', resourceName: 'Show VLAN creation result', resourceId: 'device.example.test', action: 'Ok', timestamp: 1 },
        { resourceType: 'ansible_task', resourceName: 'Save configuration', resourceId: 'device.example.test', action: 'Skipped', timestamp: 1 },
        { resourceType: 'ansible_task', resourceName: 'Verify VLAN configuration', resourceId: 'device.example.test', action: 'Ok', timestamp: 1 },
      ],
    };
    invokeMock.mockResolvedValue(makeExecution(metadata));

    render(<IaCCommandBlock block={makeBlock()} iacExecutionId="exec-1" />);

    // Section headers must appear with correct counts
    await waitFor(() => {
      expect(screen.getByText('OK (4 tasks)')).toBeTruthy();
    });
    expect(screen.getByText('Skipped (1 tasks)')).toBeTruthy();

    // Individual task names must render (the body was previously empty)
    expect(screen.getByText('Create VLAN 78')).toBeTruthy();
    expect(screen.getByText('Save configuration')).toBeTruthy();

    // Header badges
    expect(screen.getByText('EXIT 0')).toBeTruthy();
    expect(screen.getByText('0 resources changed')).toBeTruthy();
  });

  it('renders a Failed section with the error message', async () => {
    const metadata: IaCMetadata = {
      resourcesChanged: 1,
      resourcesFailed: 1,
      summary: '2 task results, 1 changed, 1 failed',
      resourceEvents: [
        { resourceType: 'ansible_task', resourceName: 'Deploy config', resourceId: 'web-01', action: 'Changed', timestamp: 1 },
        { resourceType: 'ansible_task', resourceName: 'Deploy config', resourceId: 'web-02', action: 'Failed', timestamp: 1, error: 'Connection timeout' },
      ],
    };
    invokeMock.mockResolvedValue(makeExecution(metadata));

    render(<IaCCommandBlock block={makeBlock()} iacExecutionId="exec-1" />);

    await waitFor(() => {
      expect(screen.getByText('Failed (1 tasks)')).toBeTruthy();
    });
    expect(screen.getByText('Changed (1 tasks)')).toBeTruthy();
    expect(screen.getByText('Connection timeout')).toBeTruthy();
    expect(screen.getByText('1 failed')).toBeTruthy();
  });

  it('renders Terraform Created section with dotted resource address', async () => {
    const metadata: IaCMetadata = {
      resourcesChanged: 1,
      resourcesFailed: 0,
      summary: '1 resources changed, 0 failed',
      resourceEvents: [
        { resourceType: 'aws_security_group', resourceName: 'alb', resourceId: 'sg-abc123', action: 'Create', timestamp: 1 },
      ],
    };
    invokeMock.mockResolvedValue(makeExecution(metadata, 'terraform'));

    render(
      <IaCCommandBlock
        block={makeBlock({ command: 'terraform apply' })}
        iacExecutionId="exec-1"
      />
    );

    await waitFor(() => {
      expect(screen.getByText('Created (1 resources)')).toBeTruthy();
    });
    // Terraform keeps the dotted type.name address
    expect(screen.getByText('aws_security_group.alb')).toBeTruthy();
  });
});

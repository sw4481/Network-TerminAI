import { describe, it, expect } from 'vitest';
import { parseIaCExecution, type IaCExecution } from './iac';

describe('parseIaCExecution', () => {
  // This is the EXACT shape the Rust backend now sends after adding
  // #[serde(rename_all = "camelCase")] to IaCExecution / IaCMetadata /
  // ResourceEvent. The `metadataJson` string is itself camelCase because
  // IaCMetadata is now serialized with camelCase keys.
  const ansibleExecution: IaCExecution = {
    id: 'exec-abc-123',
    commandBlockId: 'block-iac-1',
    tool: 'ansible',
    subcommand: 'playbook',
    projectPath: '$HOME/Network-TerminAI/test-iac-integration',
    gitBranch: 'feature/meraki-cli',
    gitCommit: 'b46bdcc1234',
    hadUncommittedChanges: false,
    blastRadius: 'low',
    resourcesChanged: 0,
    resourcesFailed: 0,
    metadataJson: JSON.stringify({
      resourcesChanged: 0,
      resourcesFailed: 0,
      resourceEvents: [],
      summary: '5 tasks executed, 0 changed, 0 failed',
    }),
    createdAt: 1780805999,
  };

  it('parses a camelCase execution into ParsedIaCMetadata', () => {
    const parsed = parseIaCExecution(ansibleExecution);
    expect(parsed).not.toBeNull();
    expect(parsed!.tool).toBe('ansible');
    expect(parsed!.projectPath).toBe('$HOME/Network-TerminAI/test-iac-integration');
    expect(parsed!.gitBranch).toBe('feature/meraki-cli');
  });

  it('exposes metadata.resourceEvents as an array (IaCBlockBody.filter safety)', () => {
    const parsed = parseIaCExecution(ansibleExecution);
    // IaCBlockBody does iacData.metadata.resourceEvents.filter(...) — if this
    // were undefined (snake_case mismatch), the component would crash.
    expect(Array.isArray(parsed!.metadata.resourceEvents)).toBe(true);
    expect(parsed!.metadata.summary).toContain('5 tasks executed');
  });

  it('parses changed/failed resource events with PascalCase actions', () => {
    const withEvents: IaCExecution = {
      ...ansibleExecution,
      resourcesChanged: 1,
      metadataJson: JSON.stringify({
        resourcesChanged: 1,
        resourcesFailed: 1,
        resourceEvents: [
          {
            resourceType: 'ansible_host',
            resourceName: 'device.example.test',
            resourceId: 'device.example.test',
            action: 'Changed',
            timestamp: 1780805999,
            error: null,
          },
          {
            resourceType: 'ansible_host',
            resourceName: 'device2.example.test',
            resourceId: 'device2.example.test',
            action: 'Failed',
            timestamp: 1780805999,
            error: '1 tasks failed',
          },
        ],
        summary: '2 tasks executed, 1 changed, 1 failed',
      }),
    };

    const parsed = parseIaCExecution(withEvents);
    const events = parsed!.metadata.resourceEvents;
    expect(events).toHaveLength(2);

    const changed = events.filter((e) => e.action === 'Changed');
    const failed = events.filter((e) => e.action === 'Failed');
    expect(changed).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect(changed[0].resourceName).toBe('device.example.test');
    expect(failed[0].error).toBe('1 tasks failed');
  });

  it('returns null when metadataJson is missing (falls back to plain block)', () => {
    const noMeta = { ...ansibleExecution, metadataJson: undefined };
    expect(parseIaCExecution(noMeta)).toBeNull();
  });
});

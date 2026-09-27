import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useBlocksStore } from './blocksStore';

// Mock Tauri invoke
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

describe('blocksStore', () => {
  beforeEach(() => {
    useBlocksStore.setState({
      blocksByTab: new Map(),
      activeBlockId: null,
    });
    vi.clearAllMocks();
  });

  it('should add a new block', () => {
    const blockId = useBlocksStore.getState().addBlock('tab-1', 'ls -la', '/home/user');

    const blocks = useBlocksStore.getState().blocksByTab.get('tab-1');
    expect(blocks).toHaveLength(1);
    expect(blocks![0].id).toBe(blockId);
    expect(blocks![0].command).toBe('ls -la');
    expect(blocks![0].cwd).toBe('/home/user');
    expect(blocks![0].exitCode).toBeUndefined();
  });

  it('should complete a block with exit code', () => {
    const blockId = useBlocksStore.getState().addBlock('tab-1', 'echo test', '/tmp');

    useBlocksStore.getState().completeBlock(blockId, 0, 150, 'test\n');

    const blocks = useBlocksStore.getState().blocksByTab.get('tab-1');
    expect(blocks![0].exitCode).toBe(0);
    expect(blocks![0].durationMs).toBe(150);
    expect(blocks![0].output).toBe('test\n');
  });

  it('should toggle bookmark status', () => {
    const blockId = useBlocksStore.getState().addBlock('tab-1', 'important-command', '/');

    useBlocksStore.getState().toggleBookmark(blockId);

    let blocks = useBlocksStore.getState().blocksByTab.get('tab-1');
    expect(blocks![0].bookmarked).toBe(true);

    useBlocksStore.getState().toggleBookmark(blockId);
    blocks = useBlocksStore.getState().blocksByTab.get('tab-1');
    expect(blocks![0].bookmarked).toBe(false);
  });

  it('should toggle collapse status', () => {
    const blockId = useBlocksStore.getState().addBlock('tab-1', 'ls', '/');

    useBlocksStore.getState().toggleCollapse(blockId);

    let blocks = useBlocksStore.getState().blocksByTab.get('tab-1');
    expect(blocks![0].collapsed).toBe(true);

    useBlocksStore.getState().toggleCollapse(blockId);
    blocks = useBlocksStore.getState().blocksByTab.get('tab-1');
    expect(blocks![0].collapsed).toBe(false);
  });

  it('should add AI explanation to block', async () => {
    const { invoke } = await import('@tauri-apps/api/core');
    const mockExplanation = 'This command lists all files including hidden ones in long format.';

    vi.mocked(invoke).mockResolvedValue(mockExplanation);

    const blockId = useBlocksStore.getState().addBlock('tab-1', 'ls -la', '/home/user');

    await useBlocksStore.getState().explainBlock(blockId);

    const blocks = useBlocksStore.getState().blocksByTab.get('tab-1');
    expect(blocks![0].aiExplanation).toBe(mockExplanation);
    expect(invoke).toHaveBeenCalledWith('agent_explain_command', {
      command: 'ls -la',
      cwd: '/home/user',
    });
  });

  it('should handle error when explanation fails', async () => {
    const { invoke } = await import('@tauri-apps/api/core');
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    vi.mocked(invoke).mockRejectedValue(new Error('Sidecar failed'));

    const blockId = useBlocksStore.getState().addBlock('tab-1', 'test-cmd', '/');

    await useBlocksStore.getState().explainBlock(blockId);

    const blocks = useBlocksStore.getState().blocksByTab.get('tab-1');
    expect(blocks![0].aiExplanation).toBeNull();
    expect(consoleSpy).toHaveBeenCalledWith('Failed to explain command:', expect.any(Error));

    consoleSpy.mockRestore();
  });

  it('should handle block deletion during explanation loading (Bug 1 - race condition)', async () => {
    const { invoke } = await import('@tauri-apps/api/core');
    const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // Delay the explanation response to simulate async timing
    vi.mocked(invoke).mockImplementation(() =>
      new Promise((resolve) => setTimeout(() => resolve('Test explanation'), 50))
    );

    const blockId = useBlocksStore.getState().addBlock('tab-1', 'ls -la', '/home');

    // Start explanation but don't await
    const explainPromise = useBlocksStore.getState().explainBlock(blockId);

    // Delete block before explanation completes
    useBlocksStore.getState().deleteBlock(blockId);

    // Wait for explanation to complete
    await explainPromise;

    // Should not crash - block should be deleted
    const blocks = useBlocksStore.getState().blocksByTab.get('tab-1');
    expect(blocks).toHaveLength(0);

    // Should log warning about block being deleted
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining('was deleted before explanation could be saved')
    );

    consoleWarnSpy.mockRestore();
  });

  it('persists collapsed state across reloads via block_set_collapsed', async () => {
    const { invoke } = await import('@tauri-apps/api/core');
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockResolvedValue(undefined);

    const blockId = useBlocksStore.getState().addBlock('tab-1', 'ls', '/');

    // Drain initial blocks_upsert call.
    await Promise.resolve();
    vi.mocked(invoke).mockClear();

    await useBlocksStore.getState().toggleCollapse(blockId);

    expect(invoke).toHaveBeenCalledWith('block_set_collapsed', {
      blockId,
      collapsed: true,
    });

    // Simulate app reload — clear store and rehydrate from DB.
    useBlocksStore.setState({ blocksByTab: new Map(), activeBlockId: null });

    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockResolvedValue([
      {
        id: blockId,
        tab_id: 'tab-1',
        cmd: 'ls',
        cwd: '/',
        output: '',
        exit_code: null,
        started_at: 0,
        ended_at: null,
        output_line_count: 0,
        is_bookmarked: 0,
        collapsed: 1,
        ai_analysis: null,
        ai_explanation: null,
        error_analysis: null,
        duration_ms: null,
      },
    ]);

    await useBlocksStore.getState().loadBlocksForTab('tab-1');

    const blocks = useBlocksStore.getState().blocksByTab.get('tab-1');
    expect(blocks).toHaveLength(1);
    expect(blocks![0].collapsed).toBe(true);
  });

  it('addTag invokes block_tag_add and pushes the tag onto the block', async () => {
    const { invoke } = await import('@tauri-apps/api/core');
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockResolvedValue(undefined);

    const blockId = useBlocksStore.getState().addBlock('tab-1', 'show ip int br', '/');
    await Promise.resolve();
    vi.mocked(invoke).mockClear();

    await useBlocksStore.getState().addTag(blockId, 'site-atl');

    expect(invoke).toHaveBeenCalledWith('block_tag_add', {
      blockId,
      tag: 'site-atl',
    });
    const blocks = useBlocksStore.getState().blocksByTab.get('tab-1');
    expect(blocks![0].tags).toEqual(['site-atl']);
  });

  it('removeTag invokes block_tag_remove and drops the tag', async () => {
    const { invoke } = await import('@tauri-apps/api/core');
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockResolvedValue(undefined);

    const blockId = useBlocksStore.getState().addBlock('tab-1', 'show ver', '/');
    await useBlocksStore.getState().addTag(blockId, 'golden');
    vi.mocked(invoke).mockClear();

    await useBlocksStore.getState().removeTag(blockId, 'golden');

    expect(invoke).toHaveBeenCalledWith('block_tag_remove', {
      blockId,
      tag: 'golden',
    });
    const blocks = useBlocksStore.getState().blocksByTab.get('tab-1');
    expect(blocks![0].tags).toEqual([]);
  });

  it('togglePin invokes block_pin / block_unpin in alternation', async () => {
    const { invoke } = await import('@tauri-apps/api/core');
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockResolvedValue(undefined);

    const blockId = useBlocksStore.getState().addBlock('tab-1', 'show run', '/');
    await Promise.resolve();
    vi.mocked(invoke).mockClear();

    await useBlocksStore.getState().togglePin(blockId);
    expect(invoke).toHaveBeenLastCalledWith('block_pin', { blockId, position: 0 });
    expect(useBlocksStore.getState().blocksByTab.get('tab-1')![0].pinned).toBe(true);

    await useBlocksStore.getState().togglePin(blockId);
    expect(invoke).toHaveBeenLastCalledWith('block_unpin', { blockId });
    expect(useBlocksStore.getState().blocksByTab.get('tab-1')![0].pinned).toBe(false);
  });

  it('createShare returns the share id and stores it on the block', async () => {
    const { invoke } = await import('@tauri-apps/api/core');
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockResolvedValueOnce(undefined); // initial blocks_upsert
    vi.mocked(invoke).mockResolvedValueOnce('share-uuid-123'); // block_share_create

    const blockId = useBlocksStore.getState().addBlock('tab-1', 'show ver', '/');
    await Promise.resolve();

    const shareId = await useBlocksStore.getState().createShare(blockId);

    expect(shareId).toBe('share-uuid-123');
    expect(invoke).toHaveBeenLastCalledWith('block_share_create', { blockId });
    expect(useBlocksStore.getState().blocksByTab.get('tab-1')![0].shareId).toBe('share-uuid-123');
  });

  it('setFilterTags replaces the filter list', () => {
    useBlocksStore.getState().setFilterTags(['a', 'b']);
    expect(useBlocksStore.getState().filterTags).toEqual(['a', 'b']);

    useBlocksStore.getState().setFilterTags([]);
    expect(useBlocksStore.getState().filterTags).toEqual([]);
  });

  it('should set block aiExplanation to null on explanation error (Bug 3 - P1)', async () => {
    const { invoke } = await import('@tauri-apps/api/core');
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    // Mock invoke to throw error - clear and reset
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockRejectedValue(new Error('Network error'));

    const blockId = useBlocksStore.getState().addBlock('tab-1', 'ls -la', '/home');

    await useBlocksStore.getState().explainBlock(blockId);

    // Should set aiExplanation to null (explicitly mark as failed)
    const blocks = useBlocksStore.getState().blocksByTab.get('tab-1');
    expect(blocks).toHaveLength(1);
    expect(blocks![0].aiExplanation).toBeNull();

    // Should log error
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      'Failed to explain command:',
      expect.any(Error)
    );

    consoleErrorSpy.mockRestore();
  });

  describe('loadBlocksForTab', () => {
    // These rows mirror EXACTLY what the Rust `blocks_list` command returns:
    // snake_case columns, except `iacExecutionId` which the backend renames
    // via `#[serde(rename = "iacExecutionId")]`. This guards the snake→camel
    // mapping that the live UI depends on (regression: blocks loaded from the
    // DB rendered blank / crashed on `b.command` because mapping was missing).
    const ansibleRow = {
      id: 'block-iac-1',
      tab_id: 'tab-load',
      cmd: 'ansible-playbook -i inventory.ini push-vlan.yml',
      cwd: '$HOME/Network-TerminAI/test-iac-integration',
      output: 'PLAY RECAP\ndevice.example.test : ok=5 changed=0 failed=0\n',
      exit_code: 0,
      started_at: 1780805999,
      ended_at: 1780806005,
      output_line_count: 3,
      is_bookmarked: 0,
      ai_analysis: null,
      ai_explanation: null,
      error_analysis: null,
      duration_ms: 6000,
      collapsed: 0,
      iacExecutionId: 'exec-abc-123',
    };

    const cdRow = {
      ...ansibleRow,
      id: 'block-cd-1',
      cmd: 'cd "$HOME/Network-TerminAI/test-iac-integration"',
      exit_code: 0,
      iacExecutionId: null,
    };

    it('maps snake_case rows to camelCase store blocks', async () => {
      const { invoke } = await import('@tauri-apps/api/core');
      vi.mocked(invoke).mockResolvedValue([cdRow, ansibleRow]);

      await useBlocksStore.getState().loadBlocksForTab('tab-load');

      const blocks = useBlocksStore.getState().blocksByTab.get('tab-load');
      expect(blocks).toHaveLength(2);

      const cd = blocks![0];
      expect(cd.command).toBe('cd "$HOME/Network-TerminAI/test-iac-integration"');
      expect(cd.tabId).toBe('tab-load');
      expect(cd.exitCode).toBe(0);
      expect(cd.iacExecutionId).toBeUndefined();
    });

    it('preserves iacExecutionId so IaC blocks render enriched', async () => {
      const { invoke } = await import('@tauri-apps/api/core');
      vi.mocked(invoke).mockResolvedValue([ansibleRow]);

      await useBlocksStore.getState().loadBlocksForTab('tab-load');

      const blocks = useBlocksStore.getState().blocksByTab.get('tab-load');
      const ansible = blocks!.find((b) => b.command.includes('ansible-playbook'));
      expect(ansible).toBeDefined();
      // This is the field CommandBlock.tsx checks to render IaCCommandBlock.
      expect(ansible!.iacExecutionId).toBe('exec-abc-123');
      expect(ansible!.command).toBe('ansible-playbook -i inventory.ini push-vlan.yml');
      expect(ansible!.output).toContain('PLAY RECAP');
    });

    it('does not crash on rows accessed via b.command (snake→camel)', async () => {
      const { invoke } = await import('@tauri-apps/api/core');
      vi.mocked(invoke).mockResolvedValue([ansibleRow]);

      // Previously threw: "undefined is not an object (evaluating 'b.command.includes')"
      await expect(
        useBlocksStore.getState().loadBlocksForTab('tab-load'),
      ).resolves.not.toThrow();
    });
  });
});

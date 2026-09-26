import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useBlocksStore } from './blocksStore';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

describe('blocksStore — pipe filter handling', () => {
  beforeEach(() => {
    useBlocksStore.setState({
      blocksByTab: new Map(),
      activeBlockId: null,
    });
    vi.clearAllMocks();
  });

  it('strips the pipe-filter suffix and stores the parsed filter on the block', () => {
    const id = useBlocksStore
      .getState()
      .addBlock('t1', 'show ip route | ↗structured.nexthop=10.0.0.1', '/');
    const block = useBlocksStore.getState().blocksByTab.get('t1')![0];
    expect(block.id).toBe(id);
    expect(block.command).toBe('show ip route');
    expect(block.structuredFilter).toEqual({
      kind: 'eq',
      path: 'nexthop',
      value: '10.0.0.1',
    });
  });

  it('leaves command unchanged + filter null when no pipe is present', () => {
    useBlocksStore.getState().addBlock('t1', 'show version', '/');
    const block = useBlocksStore.getState().blocksByTab.get('t1')![0];
    expect(block.command).toBe('show version');
    expect(block.structuredFilter).toBeNull();
  });

  it('falls back gracefully on a malformed pipe — keeps full command, no filter', () => {
    const orig = console.warn;
    const spy = vi.fn();
    console.warn = spy;
    try {
      useBlocksStore.getState().addBlock(
        't1',
        'show ip route | ↗structured.???',
        '/',
      );
      const block = useBlocksStore.getState().blocksByTab.get('t1')![0];
      // Parse error: the original full command stays, no filter recorded.
      expect(block.command).toBe('show ip route | ↗structured.???');
      expect(block.structuredFilter ?? null).toBeNull();
      expect(spy).toHaveBeenCalled();
    } finally {
      console.warn = orig;
    }
  });
});

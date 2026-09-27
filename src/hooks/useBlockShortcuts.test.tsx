import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useBlockShortcuts } from './useBlockShortcuts';
import { useBlocksStore, type Block } from '../state/blocksStore';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn().mockResolvedValue('share-abc'),
}));

function makeBlocks(): Block[] {
  return [
    {
      id: 'b-1',
      tabId: 'tab-1',
      command: 'cmd-1',
      cwd: '/',
      timestamp: 1,
      output: '',
      outputLineCount: 0,
      collapsed: false,
      bookmarked: false,
      tags: [],
      pinned: false,
    },
    {
      id: 'b-2',
      tabId: 'tab-1',
      command: 'cmd-2',
      cwd: '/',
      timestamp: 2,
      output: '',
      outputLineCount: 0,
      collapsed: false,
      bookmarked: false,
      tags: [],
      pinned: false,
    },
    {
      id: 'b-3',
      tabId: 'tab-1',
      command: 'cmd-3',
      cwd: '/',
      timestamp: 3,
      output: '',
      outputLineCount: 0,
      collapsed: false,
      bookmarked: false,
      tags: [],
      pinned: false,
    },
  ];
}

describe('useBlockShortcuts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useBlocksStore.setState({
      blocksByTab: new Map([['tab-1', makeBlocks()]]),
      activeBlockId: null,
      filterTags: [],
    });
  });

  it('⌘↓ moves focus to the next block; ⌘↑ moves it back', async () => {
    const user = userEvent.setup();
    const { result } = renderHook(() => useBlockShortcuts({ tabId: 'tab-1' }));

    expect(result.current.focusedBlockId).toBeNull();

    // First ⌘↓ from no focus → focus the last block
    await user.keyboard('{Meta>}{ArrowDown}{/Meta}');
    expect(result.current.focusedBlockId).toBe('b-3');

    // ⌘↑ moves backward
    await user.keyboard('{Meta>}{ArrowUp}{/Meta}');
    expect(result.current.focusedBlockId).toBe('b-2');

    await user.keyboard('{Meta>}{ArrowUp}{/Meta}');
    expect(result.current.focusedBlockId).toBe('b-1');

    // Saturates at top
    await user.keyboard('{Meta>}{ArrowUp}{/Meta}');
    expect(result.current.focusedBlockId).toBe('b-1');
  });

  it('⌘K then B toggles collapse on the focused block', async () => {
    const user = userEvent.setup();
    const { result } = renderHook(() => useBlockShortcuts({ tabId: 'tab-1' }));

    act(() => result.current.setFocusedBlockId('b-2'));

    await user.keyboard('{Meta>}k{/Meta}');
    expect(result.current.chordPending).toBe(true);

    await user.keyboard('b');
    // Allow the toggleCollapse promise to resolve
    await Promise.resolve();
    await Promise.resolve();

    const blocks = useBlocksStore.getState().blocksByTab.get('tab-1')!;
    expect(blocks.find((b) => b.id === 'b-2')!.collapsed).toBe(true);
  });

  it('⌘K then P calls togglePin → block_pin', async () => {
    const user = userEvent.setup();
    const { result } = renderHook(() => useBlockShortcuts({ tabId: 'tab-1' }));
    act(() => result.current.setFocusedBlockId('b-1'));

    await user.keyboard('{Meta>}k{/Meta}');
    await user.keyboard('p');
    await Promise.resolve();
    await Promise.resolve();

    const { invoke } = await import('@tauri-apps/api/core');
    expect(vi.mocked(invoke).mock.calls.some((c) => c[0] === 'block_pin')).toBe(true);
  });

  it('⌘K then T fires onRequestAddTag with the focused block id', async () => {
    const user = userEvent.setup();
    const onRequestAddTag = vi.fn();
    const { result } = renderHook(() =>
      useBlockShortcuts({ tabId: 'tab-1', onRequestAddTag }),
    );
    act(() => result.current.setFocusedBlockId('b-3'));

    await user.keyboard('{Meta>}k{/Meta}');
    await user.keyboard('t');

    expect(onRequestAddTag).toHaveBeenCalledWith('b-3');
  });

  it('⌘K then S calls createShare and writes the deep-link to the clipboard', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });

    const onShareCreated = vi.fn();
    const { result } = renderHook(() =>
      useBlockShortcuts({ tabId: 'tab-1', onShareCreated }),
    );
    act(() => result.current.setFocusedBlockId('b-1'));

    await user.keyboard('{Meta>}k{/Meta}');
    await user.keyboard('s');
    // Two ticks for the awaited createShare + clipboard
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(writeText).toHaveBeenCalledWith('ccie-terminal://block/share-abc');
    expect(onShareCreated).toHaveBeenCalledWith('b-1', 'share-abc');
  });

  it('Escape clears a pending chord', async () => {
    const user = userEvent.setup();
    const { result } = renderHook(() => useBlockShortcuts({ tabId: 'tab-1' }));
    act(() => result.current.setFocusedBlockId('b-1'));

    await user.keyboard('{Meta>}k{/Meta}');
    expect(result.current.chordPending).toBe(true);

    await user.keyboard('{Escape}');
    expect(result.current.chordPending).toBe(false);
  });

  it('shortcuts are no-ops when enabled=false', async () => {
    const user = userEvent.setup();
    const { result } = renderHook(() =>
      useBlockShortcuts({ tabId: 'tab-1', enabled: false }),
    );
    await user.keyboard('{Meta>}{ArrowDown}{/Meta}');
    expect(result.current.focusedBlockId).toBeNull();
  });
});

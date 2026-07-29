import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PinnedRow } from './PinnedRow';
import { useBlocksStore, type Block } from '../state/blocksStore';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}));

function makeBlock(overrides: Partial<Block> & { id: string; tabId: string }): Block {
  return {
    command: 'show ip route',
    cwd: '/',
    timestamp: Date.now(),
    output: '',
    outputLineCount: 0,
    collapsed: false,
    bookmarked: false,
    tags: [],
    pinned: false,
    ...overrides,
  };
}

describe('PinnedRow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useBlocksStore.setState({
      blocksByTab: new Map(),
      activeBlockId: null,
      filterTags: [],
    });
  });

  it('renders nothing when there are no pinned blocks', () => {
    useBlocksStore.setState({
      blocksByTab: new Map([
        ['tab-1', [makeBlock({ id: 'b1', tabId: 'tab-1' })]],
      ]),
    });
    const { container } = render(<PinnedRow tabId="tab-1" />);
    expect(container.firstChild).toBeNull();
  });

  it('renders one item per pinned block in pinPosition order', () => {
    useBlocksStore.setState({
      blocksByTab: new Map([
        [
          'tab-1',
          [
            makeBlock({ id: 'b-c', tabId: 'tab-1', pinned: true, pinPosition: 2, command: 'cmd-c' }),
            makeBlock({ id: 'b-a', tabId: 'tab-1', pinned: true, pinPosition: 0, command: 'cmd-a' }),
            makeBlock({ id: 'b-b', tabId: 'tab-1', pinned: true, pinPosition: 1, command: 'cmd-b' }),
            makeBlock({ id: 'b-x', tabId: 'tab-1', command: 'cmd-x' }),
          ],
        ],
      ]),
    });

    const { container } = render(<PinnedRow tabId="tab-1" />);
    const items = container.querySelectorAll('.pinned-row-item');
    expect(items).toHaveLength(3);
    expect(items[0].getAttribute('data-block-id')).toBe('b-a');
    expect(items[1].getAttribute('data-block-id')).toBe('b-b');
    expect(items[2].getAttribute('data-block-id')).toBe('b-c');
  });

  it('shows the count and singular/plural label', () => {
    useBlocksStore.setState({
      blocksByTab: new Map([
        ['tab-1', [makeBlock({ id: 'b1', tabId: 'tab-1', pinned: true, pinPosition: 0 })]],
      ]),
    });
    const { container, rerender } = render(<PinnedRow tabId="tab-1" />);
    const countEl = container.querySelector('.pinned-row-count');
    expect(countEl?.textContent).toBe('1 block');

    useBlocksStore.setState({
      blocksByTab: new Map([
        [
          'tab-1',
          [
            makeBlock({ id: 'b1', tabId: 'tab-1', pinned: true, pinPosition: 0 }),
            makeBlock({ id: 'b2', tabId: 'tab-1', pinned: true, pinPosition: 1 }),
          ],
        ],
      ]),
    });
    rerender(<PinnedRow tabId="tab-1" />);
    expect(container.querySelector('.pinned-row-count')?.textContent).toBe('2 blocks');
  });

  it('clicking an item scrolls the matching block in the main list into view', async () => {
    useBlocksStore.setState({
      blocksByTab: new Map([
        ['tab-1', [makeBlock({ id: 'b1', tabId: 'tab-1', pinned: true, pinPosition: 0, command: 'cmd-1' })]],
      ]),
    });

    // Append a stand-in for the main-list block element
    const mainEl = document.createElement('div');
    mainEl.setAttribute('data-block-id', 'b1');
    document.body.appendChild(mainEl);
    const scrollSpy = vi.fn();
    mainEl.scrollIntoView = scrollSpy;

    render(<PinnedRow tabId="tab-1" />);
    const user = userEvent.setup();
    await user.click(screen.getByText('cmd-1'));

    expect(scrollSpy).toHaveBeenCalledWith({ behavior: 'smooth', block: 'center' });

    document.body.removeChild(mainEl);
  });

  it('drag-and-drop calls setPinPosition for each affected block', async () => {
    useBlocksStore.setState({
      blocksByTab: new Map([
        [
          'tab-1',
          [
            makeBlock({ id: 'b-a', tabId: 'tab-1', pinned: true, pinPosition: 0 }),
            makeBlock({ id: 'b-b', tabId: 'tab-1', pinned: true, pinPosition: 1 }),
            makeBlock({ id: 'b-c', tabId: 'tab-1', pinned: true, pinPosition: 2 }),
          ],
        ],
      ]),
    });

    const { container } = render(<PinnedRow tabId="tab-1" />);
    const items = container.querySelectorAll('.pinned-row-item');

    fireEvent.dragStart(items[0], { dataTransfer: { setData: vi.fn(), effectAllowed: '' } });
    fireEvent.dragOver(items[2], { dataTransfer: { dropEffect: '' } });
    fireEvent.drop(items[2], {
      dataTransfer: {
        getData: () => 'b-a',
      },
    });

    // Wait a tick for the awaited setPinPosition calls to fire.
    await new Promise((r) => setTimeout(r, 0));

    const { invoke } = await import('@tauri-apps/api/core');
    // Verify that block_pin was invoked at least 3 times (one per re-numbered item).
    const pinCalls = vi.mocked(invoke).mock.calls.filter((c) => c[0] === 'block_pin');
    expect(pinCalls.length).toBe(3);
  });
});

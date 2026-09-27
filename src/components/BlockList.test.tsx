import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render } from '@testing-library/react';
import { BlockList } from './BlockList';
import { useBlocksStore, type Block } from '../state/blocksStore';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}));

// Track how many times CommandBlock renders so we can assert virtualization
// keeps the count well below the total block count.
const commandBlockRenderCount = { value: 0 };
vi.mock('./CommandBlock', () => ({
  CommandBlock: ({ block }: { block: Block }) => {
    commandBlockRenderCount.value += 1;
    return (
      <div data-testid="cmd-block" data-block-id={block.id}>
        {block.command}
      </div>
    );
  },
}));

function makeBlocks(n: number, tabId = 'tab-1'): Block[] {
  const out: Block[] = [];
  for (let i = 0; i < n; i++) {
    out.push({
      id: `b-${i}`,
      tabId,
      command: `cmd ${i}`,
      cwd: '/',
      timestamp: i,
      output: '',
      outputLineCount: 0,
      collapsed: true,
      bookmarked: false,
      tags: [],
      pinned: false,
    });
  }
  return out;
}

describe('BlockList', () => {
  beforeEach(() => {
    commandBlockRenderCount.value = 0;
    useBlocksStore.setState({
      blocksByTab: new Map(),
      activeBlockId: null,
      filterTags: [],
    });

    // jsdom doesn't implement layout — give the virtualizer a sane viewport
    // so it can decide what's offscreen.
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
      configurable: true,
      get() {
        return this.classList?.contains('block-list') ? 600 : 44;
      },
    });
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
      configurable: true,
      get() {
        return this.classList?.contains('block-list') ? 600 : 44;
      },
    });
  });

  it('renders only a small fraction of items for a 500-block list (virtualized)', () => {
    const blocks = makeBlocks(500);
    useBlocksStore.setState({
      blocksByTab: new Map([['tab-1', blocks]]),
    });

    render(<BlockList tabId="tab-1" blocks={blocks} />);

    // We don't care about the exact number — only that it's nowhere near 500.
    // With a 600px viewport and ~44px collapsed rows, expect well under 100.
    expect(commandBlockRenderCount.value).toBeGreaterThan(0);
    expect(commandBlockRenderCount.value).toBeLessThan(80);
  });

  it('shows empty state when there are no blocks at all', () => {
    const { container } = render(<BlockList tabId="tab-1" blocks={[]} />);
    expect(container.querySelector('.block-list-empty')).not.toBeNull();
  });

  it('shows the filter empty-state when filter excludes every block', () => {
    const blocks = makeBlocks(3).map((b) => ({ ...b, tags: ['other'] }));
    useBlocksStore.setState({
      blocksByTab: new Map([['tab-1', blocks]]),
      filterTags: ['golden'],
    });
    const { container } = render(<BlockList tabId="tab-1" blocks={blocks} />);
    const empty = container.querySelector('.block-list-empty');
    expect(empty?.textContent).toMatch(/No blocks match/i);
    expect(empty?.textContent).toMatch(/golden/);
  });

  it('AND-filters across multiple selected filter tags', () => {
    const blocks = [
      { ...makeBlocks(1, 'tab-1')[0], id: 'has-both', tags: ['golden', 'bgp'] },
      { ...makeBlocks(1, 'tab-1')[0], id: 'has-one', tags: ['golden'] },
      { ...makeBlocks(1, 'tab-1')[0], id: 'has-none', tags: [] },
    ];
    useBlocksStore.setState({
      blocksByTab: new Map([['tab-1', blocks]]),
      filterTags: ['golden', 'bgp'],
    });
    const { container } = render(<BlockList tabId="tab-1" blocks={blocks} />);
    const ids = Array.from(container.querySelectorAll('[data-testid="cmd-block"]'))
      .map((el) => el.getAttribute('data-block-id'));
    expect(ids).toEqual(['has-both']);
  });

  it('renders the pinned row + filter bar in the header region', () => {
    const blocks = makeBlocks(2).map((b, i) =>
      i === 0 ? { ...b, pinned: true, pinPosition: 0, tags: ['golden'] } : b,
    );
    useBlocksStore.setState({
      blocksByTab: new Map([['tab-1', blocks]]),
    });
    const { container } = render(<BlockList tabId="tab-1" blocks={blocks} />);
    expect(container.querySelector('.block-list-header')).not.toBeNull();
    expect(container.querySelector('.pinned-row')).not.toBeNull();
    expect(container.querySelector('.tag-filter-bar')).not.toBeNull();
  });
});

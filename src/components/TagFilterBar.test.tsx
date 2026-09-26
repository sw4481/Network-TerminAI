import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TagFilterBar } from './TagFilterBar';
import { useBlocksStore, type Block } from '../state/blocksStore';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}));

function makeBlock(o: Partial<Block> & { id: string; tabId: string }): Block {
  return {
    command: 'cmd',
    cwd: '/',
    timestamp: 0,
    output: '',
    outputLineCount: 0,
    collapsed: false,
    bookmarked: false,
    tags: [],
    pinned: false,
    ...o,
  };
}

describe('TagFilterBar', () => {
  beforeEach(() => {
    useBlocksStore.setState({
      blocksByTab: new Map([
        [
          'tab-1',
          [
            makeBlock({ id: 'b1', tabId: 'tab-1', tags: ['golden', 'site-atl'] }),
            makeBlock({ id: 'b2', tabId: 'tab-1', tags: ['golden', 'bgp'] }),
          ],
        ],
      ]),
      activeBlockId: null,
      filterTags: [],
    });
  });

  it('lists the deduped union of all tags from all blocks in tab', () => {
    render(<TagFilterBar tabId="tab-1" />);
    expect(screen.getByText('golden')).toBeInTheDocument();
    expect(screen.getByText('site-atl')).toBeInTheDocument();
    expect(screen.getByText('bgp')).toBeInTheDocument();
  });

  it('clicking a chip toggles the tag in filterTags', async () => {
    const user = userEvent.setup();
    render(<TagFilterBar tabId="tab-1" />);

    await user.click(screen.getByText('golden'));
    expect(useBlocksStore.getState().filterTags).toEqual(['golden']);

    await user.click(screen.getByText('bgp'));
    expect(useBlocksStore.getState().filterTags.sort()).toEqual(['bgp', 'golden']);

    await user.click(screen.getByText('golden'));
    expect(useBlocksStore.getState().filterTags).toEqual(['bgp']);
  });

  it('marks active chips with data-active="true"', () => {
    useBlocksStore.setState({ filterTags: ['golden'] });
    const { container } = render(<TagFilterBar tabId="tab-1" />);
    const chips = container.querySelectorAll('.tag-chip');
    const golden = Array.from(chips).find((c) => c.textContent === 'golden')!;
    const bgp = Array.from(chips).find((c) => c.textContent === 'bgp')!;
    expect(golden.getAttribute('data-active')).toBe('true');
    expect(bgp.getAttribute('data-active')).toBe('false');
  });

  it('Clear button only shows when filterTags has entries; clicking it empties the filter', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<TagFilterBar tabId="tab-1" />);
    expect(screen.queryByText('Clear')).toBeNull();

    useBlocksStore.setState({ filterTags: ['golden'] });
    rerender(<TagFilterBar tabId="tab-1" />);

    const clear = screen.getByText('Clear');
    await user.click(clear);
    expect(useBlocksStore.getState().filterTags).toEqual([]);
  });

  it('+ tag input adds a filter even for tags not present on any block', async () => {
    const user = userEvent.setup();
    render(<TagFilterBar tabId="tab-1" />);

    await user.click(screen.getByLabelText('Add filter tag'));
    const input = screen.getByPlaceholderText('+tag…');
    await user.type(input, 'planned{Enter}');

    expect(useBlocksStore.getState().filterTags).toEqual(['planned']);
  });

  it('Escape cancels the add input', async () => {
    const user = userEvent.setup();
    render(<TagFilterBar tabId="tab-1" />);
    await user.click(screen.getByLabelText('Add filter tag'));
    const input = screen.getByPlaceholderText('+tag…');
    await user.type(input, 'oops{Escape}');
    expect(useBlocksStore.getState().filterTags).toEqual([]);
  });

  it('shows "no tags yet" when no blocks have tags and no filters set', () => {
    useBlocksStore.setState({
      blocksByTab: new Map([['tab-1', [makeBlock({ id: 'b1', tabId: 'tab-1' })]]]),
      filterTags: [],
    });
    render(<TagFilterBar tabId="tab-1" />);
    expect(screen.getByText('no tags yet')).toBeInTheDocument();
  });

  it('availableTags prop overrides the union derivation', () => {
    render(<TagFilterBar tabId="tab-1" availableTags={['planned', 'audit']} />);
    expect(screen.getByText('planned')).toBeInTheDocument();
    expect(screen.getByText('audit')).toBeInTheDocument();
    expect(screen.queryByText('golden')).toBeNull();
  });
});

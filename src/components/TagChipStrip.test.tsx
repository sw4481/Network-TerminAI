import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TagChipStrip } from './TagChipStrip';
import { useBlocksStore } from '../state/blocksStore';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}));

describe('TagChipStrip', () => {
  beforeEach(() => {
    useBlocksStore.setState({
      blocksByTab: new Map([
        [
          'tab-1',
          [
            {
              id: 'b1',
              tabId: 'tab-1',
              command: 'show ip route',
              cwd: '/',
              timestamp: Date.now(),
              output: '',
              outputLineCount: 0,
              collapsed: false,
              bookmarked: false,
              tags: ['golden', 'site-atl'],
              pinned: false,
            },
          ],
        ],
      ]),
      activeBlockId: null,
      filterTags: [],
    });
    vi.clearAllMocks();
  });

  it('renders one chip per tag plus an add affordance', () => {
    render(<TagChipStrip blockId="b1" tags={['golden', 'site-atl']} />);
    expect(screen.getByText('golden')).toBeInTheDocument();
    expect(screen.getByText('site-atl')).toBeInTheDocument();
    expect(screen.getByLabelText('Add tag')).toBeInTheDocument();
  });

  it('clicking a chip toggles that tag in filterTags', async () => {
    const user = userEvent.setup();
    render(<TagChipStrip blockId="b1" tags={['golden', 'site-atl']} />);

    await user.click(screen.getByText('golden'));
    expect(useBlocksStore.getState().filterTags).toEqual(['golden']);

    await user.click(screen.getByText('golden'));
    expect(useBlocksStore.getState().filterTags).toEqual([]);
  });

  it('renders chip with active state when its tag is in filterTags', () => {
    useBlocksStore.setState({ filterTags: ['golden'] });
    const { container } = render(
      <TagChipStrip blockId="b1" tags={['golden', 'site-atl']} />,
    );

    const chips = container.querySelectorAll('.tag-chip');
    expect(chips[0].getAttribute('data-active')).toBe('true');
    expect(chips[1].getAttribute('data-active')).toBe('false');
  });

  it('clicking the inline × removes the tag without toggling filter', async () => {
    const user = userEvent.setup();
    const { container } = render(
      <TagChipStrip blockId="b1" tags={['golden', 'site-atl']} />,
    );

    const removeButtons = container.querySelectorAll('.tag-chip-remove');
    await user.click(removeButtons[0]);

    const { invoke } = await import('@tauri-apps/api/core');
    expect(invoke).toHaveBeenCalledWith('block_tag_remove', {
      blockId: 'b1',
      tag: 'golden',
    });
    // filter wasn't toggled
    expect(useBlocksStore.getState().filterTags).toEqual([]);
  });

  it('clicking + opens an inline input; Enter commits via addTag', async () => {
    const user = userEvent.setup();
    render(<TagChipStrip blockId="b1" tags={['golden']} />);

    await user.click(screen.getByLabelText('Add tag'));
    const input = screen.getByPlaceholderText('tag…');
    expect(input).toBeInTheDocument();

    await user.type(input, 'bgp{Enter}');

    const { invoke } = await import('@tauri-apps/api/core');
    expect(invoke).toHaveBeenCalledWith('block_tag_add', {
      blockId: 'b1',
      tag: 'bgp',
    });
  });

  it('Escape cancels add input without invoking addTag', async () => {
    const user = userEvent.setup();
    render(<TagChipStrip blockId="b1" tags={[]} />);

    await user.click(screen.getByLabelText('Add tag'));
    const input = screen.getByPlaceholderText('tag…');
    await user.type(input, 'oops');
    fireEvent.keyDown(input, { key: 'Escape' });

    const { invoke } = await import('@tauri-apps/api/core');
    expect(invoke).not.toHaveBeenCalledWith(
      'block_tag_add',
      expect.anything(),
    );
  });

  it('alwaysShowAdd flag flips the data attribute', () => {
    const { container, rerender } = render(
      <TagChipStrip blockId="b1" tags={[]} alwaysShowAdd />,
    );
    expect(container.querySelector('.tag-chip-strip')?.getAttribute('data-always-show-add')).toBe('true');

    rerender(<TagChipStrip blockId="b1" tags={[]} />);
    expect(container.querySelector('.tag-chip-strip')?.getAttribute('data-always-show-add')).toBe('false');
  });
});

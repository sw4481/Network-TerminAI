import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createRef } from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SharePopover } from './SharePopover';
import { useBlocksStore, type Block } from '../state/blocksStore';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

vi.mock('@tauri-apps/plugin-dialog', () => ({
  save: vi.fn(),
}));

vi.mock('@tauri-apps/plugin-fs', () => ({
  writeTextFile: vi.fn(),
}));

vi.mock('../lib/notebook', async () => {
  const actual = await vi.importActual<typeof import('../lib/notebook')>(
    '../lib/notebook',
  );
  return {
    ...actual,
    exportBlockToMarkdown: vi.fn(() => 'MD-OUTPUT'),
    exportBlockToJson: vi.fn(() => 'JSON-OUTPUT'),
  };
});

function makeBlock(overrides: Partial<Block> = {}): Block {
  return {
    id: 'b1',
    tabId: 'tab-1',
    command: 'show ip route',
    cwd: '/',
    timestamp: 1700000000000,
    durationMs: 42,
    exitCode: 0,
    output: 'hello world',
    outputLineCount: 1,
    collapsed: false,
    bookmarked: false,
    tags: [],
    pinned: false,
    ...overrides,
  };
}

function seedStoreWithBlock(block: Block) {
  useBlocksStore.setState({
    blocksByTab: new Map([[block.tabId, [block]]]),
    activeBlockId: null,
    filterTags: [],
  });
}

/**
 * `userEvent.setup()` installs its own `navigator.clipboard` stub before
 * each test, so we have to spy on the live object AFTER `setup()` has
 * run. We return the spy so callers can assert on its calls.
 */
function spyClipboard() {
  // Ensure the stub exists; in jsdom navigator.clipboard is undefined unless
  // userEvent.setup() has installed a stub. Falling back here keeps tests
  // that don't call setup() from blowing up.
  if (!navigator.clipboard) {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
  }
  return vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);
}

describe('SharePopover', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    seedStoreWithBlock(makeBlock());
  });

  it('renders all 5 actions, with revoke disabled when shareId is undefined', () => {
    const block = makeBlock();
    seedStoreWithBlock(block);
    const anchorRef = createRef<HTMLButtonElement>();

    render(
      <>
        <button ref={anchorRef}>anchor</button>
        <SharePopover
          block={block}
          anchorRef={anchorRef}
          open
          onClose={vi.fn()}
        />
      </>,
    );

    expect(screen.getByRole('menuitem', { name: /copy link/i })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /copy as markdown/i })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /copy as json/i })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /export markdown/i })).toBeInTheDocument();

    const revoke = screen.getByRole('menuitem', { name: /revoke share/i });
    expect(revoke).toBeDisabled();
    expect(revoke).toHaveAttribute('aria-disabled', 'true');
  });

  it('Copy as Markdown writes exportBlockToMarkdown output to the clipboard', async () => {
    const user = userEvent.setup();
    const writeText = spyClipboard();
    const block = makeBlock();
    seedStoreWithBlock(block);
    const anchorRef = createRef<HTMLButtonElement>();
    const onClose = vi.fn();

    render(
      <>
        <button ref={anchorRef}>a</button>
        <SharePopover block={block} anchorRef={anchorRef} open onClose={onClose} />
      </>,
    );

    await user.click(screen.getByRole('menuitem', { name: /copy as markdown/i }));
    expect(writeText).toHaveBeenCalledWith('MD-OUTPUT');
  });

  it('Copy as JSON writes exportBlockToJson output to the clipboard', async () => {
    const user = userEvent.setup();
    const writeText = spyClipboard();
    const block = makeBlock();
    seedStoreWithBlock(block);
    const anchorRef = createRef<HTMLButtonElement>();

    render(
      <>
        <button ref={anchorRef}>a</button>
        <SharePopover block={block} anchorRef={anchorRef} open onClose={vi.fn()} />
      </>,
    );

    await user.click(screen.getByRole('menuitem', { name: /copy as json/i }));
    expect(writeText).toHaveBeenCalledWith('JSON-OUTPUT');
  });

  it('Copy link without an existing shareId calls createShare and copies the deep-link URL', async () => {
    const user = userEvent.setup();
    const writeText = spyClipboard();
    const { invoke } = await import('@tauri-apps/api/core');
    (invoke as unknown as { mockResolvedValue: (v: string) => void }).mockResolvedValue('share-abc-123');

    const block = makeBlock(); // no shareId
    seedStoreWithBlock(block);
    const anchorRef = createRef<HTMLButtonElement>();

    render(
      <>
        <button ref={anchorRef}>a</button>
        <SharePopover block={block} anchorRef={anchorRef} open onClose={vi.fn()} />
      </>,
    );

    await user.click(screen.getByRole('menuitem', { name: /copy link/i }));

    expect(invoke).toHaveBeenCalledWith('block_share_create', { blockId: 'b1' });
    expect(writeText).toHaveBeenCalledWith('ccie-terminal://block/share-abc-123');
  });

  it('Copy link reuses an existing shareId without calling createShare', async () => {
    const user = userEvent.setup();
    const writeText = spyClipboard();
    const { invoke } = await import('@tauri-apps/api/core');
    (invoke as unknown as { mockClear: () => void }).mockClear();

    const block = makeBlock({ shareId: 'pre-existing-id' });
    seedStoreWithBlock(block);
    const anchorRef = createRef<HTMLButtonElement>();

    render(
      <>
        <button ref={anchorRef}>a</button>
        <SharePopover block={block} anchorRef={anchorRef} open onClose={vi.fn()} />
      </>,
    );

    await user.click(screen.getByRole('menuitem', { name: /copy link/i }));

    expect(invoke).not.toHaveBeenCalledWith('block_share_create', expect.anything());
    expect(writeText).toHaveBeenCalledWith('ccie-terminal://block/pre-existing-id');
  });

  it('Revoke share invokes block_share_revoke and the popover closes after', async () => {
    vi.useFakeTimers();
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      (invoke as unknown as { mockResolvedValue: (v: unknown) => void }).mockResolvedValue(undefined);

      const block = makeBlock({ shareId: 'live-id-1' });
      seedStoreWithBlock(block);
      const anchorRef = createRef<HTMLButtonElement>();
      const onClose = vi.fn();

      render(
        <>
          <button ref={anchorRef}>a</button>
          <SharePopover block={block} anchorRef={anchorRef} open onClose={onClose} />
        </>,
      );

      const revoke = screen.getByRole('menuitem', { name: /revoke share/i });
      expect(revoke).not.toBeDisabled();

      // userEvent isn't fake-timer-friendly; use fireEvent for synchronous click.
      await act(async () => {
        fireEvent.click(revoke);
      });
      // Allow the awaited revokeShare promise to resolve.
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(invoke).toHaveBeenCalledWith('block_share_revoke', { shareId: 'live-id-1' });

      // Auto-close fires after a short feedback delay.
      await act(async () => {
        vi.advanceTimersByTime(700);
      });
      expect(onClose).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('Escape key closes the popover', () => {
    const block = makeBlock();
    seedStoreWithBlock(block);
    const anchorRef = createRef<HTMLButtonElement>();
    const onClose = vi.fn();

    render(
      <>
        <button ref={anchorRef}>a</button>
        <SharePopover block={block} anchorRef={anchorRef} open onClose={onClose} />
      </>,
    );

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('clicking outside the popover and outside the anchor closes the popover', () => {
    const block = makeBlock();
    seedStoreWithBlock(block);
    const anchorRef = createRef<HTMLButtonElement>();
    const onClose = vi.fn();

    render(
      <div>
        <button ref={anchorRef}>anchor</button>
        <div data-testid="outside">outside</div>
        <SharePopover block={block} anchorRef={anchorRef} open onClose={onClose} />
      </div>,
    );

    fireEvent.mouseDown(screen.getByTestId('outside'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('clicking inside the popover does NOT close it', () => {
    const block = makeBlock();
    seedStoreWithBlock(block);
    const anchorRef = createRef<HTMLButtonElement>();
    const onClose = vi.fn();

    render(
      <>
        <button ref={anchorRef}>anchor</button>
        <SharePopover block={block} anchorRef={anchorRef} open onClose={onClose} />
      </>,
    );

    const popover = screen.getByRole('menu', { name: /share block/i });
    fireEvent.mouseDown(popover);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('renders nothing when open=false', () => {
    const block = makeBlock();
    seedStoreWithBlock(block);
    const anchorRef = createRef<HTMLButtonElement>();
    const { container } = render(
      <>
        <button ref={anchorRef}>a</button>
        <SharePopover block={block} anchorRef={anchorRef} open={false} onClose={vi.fn()} />
      </>,
    );
    expect(container.querySelector('.share-popover')).toBeNull();
  });

  it('Export Markdown… writes the markdown payload to the chosen path and shows "Saved"', async () => {
    const user = userEvent.setup();
    const { save } = await import('@tauri-apps/plugin-dialog');
    const { writeTextFile } = await import('@tauri-apps/plugin-fs');
    (save as unknown as { mockResolvedValue: (v: unknown) => void }).mockResolvedValue(
      '/tmp/show_ip_route.md',
    );
    (writeTextFile as unknown as { mockResolvedValue: (v: unknown) => void }).mockResolvedValue(
      undefined,
    );

    const block = makeBlock();
    seedStoreWithBlock(block);
    const anchorRef = createRef<HTMLButtonElement>();
    const onClose = vi.fn();

    render(
      <>
        <button ref={anchorRef}>a</button>
        <SharePopover block={block} anchorRef={anchorRef} open onClose={onClose} />
      </>,
    );

    await user.click(screen.getByRole('menuitem', { name: /export markdown/i }));

    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({
        defaultPath: 'show_ip_route.md',
        filters: [{ name: 'Markdown', extensions: ['md'] }],
      }),
    );
    expect(writeTextFile).toHaveBeenCalledWith('/tmp/show_ip_route.md', 'MD-OUTPUT');
    expect(await screen.findByText('Saved')).toBeInTheDocument();
  });

  it('Export Markdown… does not write a file when the user cancels the save dialog', async () => {
    const user = userEvent.setup();
    const { save } = await import('@tauri-apps/plugin-dialog');
    const { writeTextFile } = await import('@tauri-apps/plugin-fs');
    (save as unknown as { mockResolvedValue: (v: unknown) => void }).mockResolvedValue(null);

    const block = makeBlock();
    seedStoreWithBlock(block);
    const anchorRef = createRef<HTMLButtonElement>();
    const onClose = vi.fn();

    render(
      <>
        <button ref={anchorRef}>a</button>
        <SharePopover block={block} anchorRef={anchorRef} open onClose={onClose} />
      </>,
    );

    await user.click(screen.getByRole('menuitem', { name: /export markdown/i }));

    expect(save).toHaveBeenCalled();
    expect(writeTextFile).not.toHaveBeenCalled();
    // On cancel the implementation closes the popover quietly.
    expect(onClose).toHaveBeenCalled();
  });

  it('Export Markdown… surfaces sticky "Export failed" feedback when writeTextFile rejects', async () => {
    const user = userEvent.setup();
    const { save } = await import('@tauri-apps/plugin-dialog');
    const { writeTextFile } = await import('@tauri-apps/plugin-fs');
    (save as unknown as { mockResolvedValue: (v: unknown) => void }).mockResolvedValue(
      '/tmp/show_ip_route.md',
    );
    (
      writeTextFile as unknown as { mockRejectedValue: (v: unknown) => void }
    ).mockRejectedValue(new Error('disk full'));

    // Silence the expected console.error from the catch branch.
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const block = makeBlock();
    seedStoreWithBlock(block);
    const anchorRef = createRef<HTMLButtonElement>();
    const onClose = vi.fn();

    try {
      render(
        <>
          <button ref={anchorRef}>a</button>
          <SharePopover block={block} anchorRef={anchorRef} open onClose={onClose} />
        </>,
      );

      await user.click(screen.getByRole('menuitem', { name: /export markdown/i }));

      expect(await screen.findByText('Export failed')).toBeInTheDocument();
      // Sticky error must NOT auto-close the popover.
      expect(onClose).not.toHaveBeenCalled();
    } finally {
      errSpy.mockRestore();
    }
  });
});

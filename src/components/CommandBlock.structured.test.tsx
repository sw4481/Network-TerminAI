import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, waitFor, screen } from '@testing-library/react';
import { CommandBlock } from './CommandBlock';
import { useBlocksStore, type Block } from '../state/blocksStore';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

const getStructuredMock = vi.fn();
vi.mock('../lib/structured', async () => {
  const actual = await vi.importActual<typeof import('../lib/structured')>(
    '../lib/structured',
  );
  return {
    ...actual,
    getStructured: (...args: unknown[]) => getStructuredMock(...args),
    listSnapshots: vi.fn(async () => []),
    autoParseBlock: vi.fn(async () => undefined),
  };
});

const baseBlock = (cmd: string): Block => ({
  id: 'b-1',
  tabId: 't1',
  command: cmd,
  cwd: '/',
  timestamp: Date.now(),
  output: 'sample output',
  outputLineCount: 1,
  collapsed: false,
  bookmarked: false,
  tags: [],
  pinned: false,
  exitCode: 0,
  durationMs: 100,
});

describe('CommandBlock — Structured tab integration', () => {
  beforeEach(() => {
    useBlocksStore.setState({
      blocksByTab: new Map(),
      activeBlockId: null,
    });
    getStructuredMock.mockReset();
    getStructuredMock.mockResolvedValue(null);
  });

  it('renders BlockTabStrip for show * commands when not active', () => {
    const block = baseBlock('show ip interface brief');
    render(<CommandBlock block={block} active={false} />);
    expect(screen.getByTestId('block-tab-strip')).toBeInTheDocument();
  });

  it('does NOT render BlockTabStrip for non-show commands', () => {
    const block = baseBlock('ls -la');
    render(<CommandBlock block={block} active={false} />);
    expect(screen.queryByTestId('block-tab-strip')).not.toBeInTheDocument();
  });

  it('keeps BlockTabStrip when a completed block is merely focused (active, no live xterm)', () => {
    // Regression: focusing a history block in the block list marks it active
    // but passes no children. The tab strip (and the block output) must NOT
    // vanish on focus — only a genuinely live block (children present) hides it.
    const block = baseBlock('show version');
    render(<CommandBlock block={block} active={true} />);
    expect(screen.getByTestId('block-tab-strip')).toBeInTheDocument();
  });

  it('does NOT render BlockTabStrip while a live xterm is streaming into the block', () => {
    const block = baseBlock('show version');
    render(
      <CommandBlock block={block} active={true}>
        <div data-testid="live-xterm" />
      </CommandBlock>,
    );
    expect(screen.queryByTestId('block-tab-strip')).not.toBeInTheDocument();
  });

  it('clicking Structured swaps content from Raw to Structured', async () => {
    getStructuredMock.mockResolvedValue({
      blockId: 'b-1',
      parser: 'textfsm',
      command: 'show ip int br',
      vendor: 'cisco',
      platform: 'iosxe',
      data: [{ interface: 'Gi1', status: 'up' }],
      createdAt: 0,
    });
    const block = baseBlock('show ip int br');
    render(<CommandBlock block={block} active={false} />);
    fireEvent.click(screen.getByTestId('block-tab-structured'));
    await waitFor(() => screen.getByTestId('structured-table'));
    expect(screen.getByText('Gi1')).toBeInTheDocument();
  });
});

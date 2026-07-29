import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, waitFor, screen } from '@testing-library/react';
import { CommandBlock } from './CommandBlock';
import { useBlocksStore } from '../state/blocksStore';
import type { Block } from '../state/blocksStore';
import { useTopologyStore } from '../state/topologyStore';
import { useTabs } from '../state/tabsStore';
import { GLOBAL_GRAPH_ID } from '../lib/topology';

// Mock Tauri invoke
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

describe('CommandBlock - Bug 2: Duplicate Request Prevention', () => {
  const mockBlock: Block = {
    id: 'test-block-1',
    tabId: 'tab-1',
    command: 'ls -la',
    cwd: '/home/user',
    timestamp: Date.now(),
    output: 'test output\nline 2\nline 3',
    outputLineCount: 3,
    collapsed: false,
    bookmarked: false,
    tags: [],
    pinned: false,
  };

  beforeEach(() => {
    useBlocksStore.setState({
      blocksByTab: new Map([['tab-1', [mockBlock]]]),
      activeBlockId: null,
    });
    vi.clearAllMocks();
  });

  it('should prevent duplicate explain requests when clicked rapidly (Bug 2 - P1)', async () => {
    const { invoke } = await import('@tauri-apps/api/core');

    // Mock slow API response
    vi.mocked(invoke).mockImplementation(() =>
      new Promise((resolve) => setTimeout(() => resolve('Test explanation'), 100))
    );

    const { container } = render(
      <CommandBlock block={mockBlock} active={false} />
    );

    const explainButton = container.querySelector('[title="Explain command"]');
    expect(explainButton).toBeTruthy();

    // Click twice rapidly
    fireEvent.click(explainButton!);
    fireEvent.click(explainButton!);

    // Wait for async operations
    await waitFor(() => {
      const blocks = useBlocksStore.getState().blocksByTab.get('tab-1');
      return blocks?.[0].aiExplanation !== undefined;
    }, { timeout: 200 });

    // Should only call invoke once despite two clicks
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('should not start new request if explanation already exists', async () => {
    const { invoke } = await import('@tauri-apps/api/core');

    const blockWithExplanation: Block = {
      ...mockBlock,
      aiExplanation: 'Existing explanation',
    };

    useBlocksStore.setState({
      blocksByTab: new Map([['tab-1', [blockWithExplanation]]]),
      activeBlockId: null,
    });

    const { container } = render(
      <CommandBlock block={blockWithExplanation} active={false} />
    );

    const explainButton = container.querySelector('[title="Explain command"]');

    // Click the button
    fireEvent.click(explainButton!);

    // Should NOT call invoke since explanation already exists
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe('CommandBlock - Plan 13 Phase 2.4: InlineTopologyPanel wiring', () => {
  const baseBlock: Block = {
    id: 'block-topology-1',
    tabId: 'tab-topology-1',
    command: 'show cdp neighbors',
    cwd: '/home/user',
    timestamp: Date.now(),
    output: 'cdp neighbor output',
    outputLineCount: 1,
    collapsed: false,
    bookmarked: false,
    tags: [],
    pinned: false,
    exitCode: 0,
    durationMs: 12,
  };

  beforeEach(() => {
    useBlocksStore.setState({
      blocksByTab: new Map([['tab-topology-1', [baseBlock]]]),
      activeBlockId: null,
    });
    useTabs.setState({
      tabs: [
        {
          id: 'tab-topology-1',
          title: 'edge-r1',
        } as unknown as ReturnType<typeof useTabs.getState>['tabs'][number],
      ],
      activeTabId: 'tab-topology-1',
      blocks: {},
    });
    useTopologyStore.setState({
      graphs: [],
      currentGraphId: GLOBAL_GRAPH_ID,
      nodes: [],
      edges: [],
      loading: false,
      error: null,
    });
    vi.clearAllMocks();
  });

  it('renders InlineTopologyPanel for completed `show cdp neighbors` blocks', () => {
    render(<CommandBlock block={baseBlock} active={false} />);
    expect(screen.queryByTestId('topology-inline-panel')).toBeInTheDocument();
  });

  it('renders InlineTopologyPanel for completed `show lldp neighbors` blocks', () => {
    const lldpBlock: Block = { ...baseBlock, command: 'show lldp neighbors' };
    useBlocksStore.setState({
      blocksByTab: new Map([['tab-topology-1', [lldpBlock]]]),
      activeBlockId: null,
    });
    render(<CommandBlock block={lldpBlock} active={false} />);
    expect(screen.queryByTestId('topology-inline-panel')).toBeInTheDocument();
  });

  it('does NOT render InlineTopologyPanel for `show version` blocks', () => {
    const versionBlock: Block = { ...baseBlock, command: 'show version' };
    useBlocksStore.setState({
      blocksByTab: new Map([['tab-topology-1', [versionBlock]]]),
      activeBlockId: null,
    });
    render(<CommandBlock block={versionBlock} active={false} />);
    expect(screen.queryByTestId('topology-inline-panel')).not.toBeInTheDocument();
  });

  it('does NOT render the panel while the block is still running', () => {
    const runningBlock: Block = { ...baseBlock, exitCode: undefined };
    useBlocksStore.setState({
      blocksByTab: new Map([['tab-topology-1', [runningBlock]]]),
      activeBlockId: null,
    });
    render(<CommandBlock block={runningBlock} active={false} />);
    expect(screen.queryByTestId('topology-inline-panel')).not.toBeInTheDocument();
  });

  it('opens SaveNeighborModal when clicking a topology node resolves to an unknown neighbor', async () => {
    const { invoke } = await import('@tauri-apps/api/core');
    // device_lookup_by_ref returns null → openNeighbor falls through to
    // onUnknownNeighbor, which CommandBlock wires to SaveNeighborModal.
    vi.mocked(invoke).mockResolvedValue(null);

    // tab.title is the source device_ref ("edge-r1"). Seed a single
    // neighbor "device:r2" connected to it so the panel renders both
    // the source and one clickable neighbor node.
    useTopologyStore.setState({
      graphs: [],
      currentGraphId: GLOBAL_GRAPH_ID,
      nodes: [
        {
          graph_id: GLOBAL_GRAPH_ID,
          device_ref: 'edge-r1',
          device_kind: 'ssh',
          label: 'edge-r1',
          vendor: 'cisco',
          mgmt_ip: '10.0.0.1',
        },
        {
          graph_id: GLOBAL_GRAPH_ID,
          device_ref: 'device:r2',
          device_kind: 'discovered',
          label: 'R2',
          vendor: 'cisco',
          mgmt_ip: '10.0.0.2',
        },
      ],
      edges: [
        {
          graph_id: GLOBAL_GRAPH_ID,
          a_device_ref: 'edge-r1',
          a_port: 'Gi0/1',
          b_device_ref: 'device:r2',
          b_port: 'Gi0/2',
          protocol: 'cdp',
          captured_at: 0,
        },
      ],
      loading: false,
      error: null,
    });

    render(<CommandBlock block={baseBlock} active={false} />);

    // Two nodes render (source + one neighbor). Click the non-source.
    const nodes = await screen.findAllByTestId('topology-node');
    const neighbor =
      nodes.find((n) => !n.classList.contains('neighbor-node--source')) ??
      nodes[1];
    fireEvent.click(neighbor);

    // Modal surfaces once openNeighbor resolves and onUnknownNeighbor fires.
    await waitFor(() => {
      expect(screen.queryByTestId('save-neighbor-modal')).toBeInTheDocument();
    });
    expect(invoke).toHaveBeenCalledWith(
      'device_lookup_by_ref',
      expect.objectContaining({ ref: expect.any(String) }),
    );
  });
});

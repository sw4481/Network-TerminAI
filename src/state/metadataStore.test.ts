import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the lib wrapper so the store has no real IPC.
vi.mock('../lib/metadata', () => ({
  getPaneMetadata: vi.fn(),
}));
// Mock the stores that the refresh() resolver depends on.
vi.mock('./panesStore', () => ({
  usePanesStore: { getState: vi.fn() },
}));
vi.mock('./tabsStore', () => ({
  useTabs: { getState: vi.fn() },
}));
vi.mock('./iacStateStore', () => ({
  useIacStateStore: { getState: vi.fn() },
}));

import { useMetadataStore } from './metadataStore';
import { getPaneMetadata } from '../lib/metadata';
import { usePanesStore } from './panesStore';
import { useTabs } from './tabsStore';
import { useIacStateStore } from './iacStateStore';

beforeEach(() => {
  useMetadataStore.setState({
    open: false, data: null, loading: false, error: null,
    position: { x: 0, y: 0 },
  });
  vi.clearAllMocks();
});

describe('metadataStore', () => {
  it('toggle flips open', () => {
    // Provide a no-focused-pane state so the refresh-on-open is a no-op.
    (usePanesStore.getState as any).mockReturnValue({ focusedPaneId: null });
    expect(useMetadataStore.getState().open).toBe(false);
    useMetadataStore.getState().toggle();
    expect(useMetadataStore.getState().open).toBe(true);
  });

  it('refresh with no focused pane sets a neutral error and does not call IPC', async () => {
    (usePanesStore.getState as any).mockReturnValue({ focusedPaneId: null });
    await useMetadataStore.getState().refresh();
    expect(getPaneMetadata).not.toHaveBeenCalled();
    expect(useMetadataStore.getState().error).toMatch(/no focused pane/i);
  });

  it('refresh resolves pane context and stores returned data', async () => {
    (usePanesStore.getState as any).mockReturnValue({
      focusedPaneId: 'pane-1',
      resolveRecordingTerminalId: (_: string) => 'term-1',
    });
    (useTabs.getState as any).mockReturnValue({ activeTabId: 'tab-1', tabs: [] });
    (useIacStateStore.getState as any).mockReturnValue({
      cwdByTerminal: { 'term-1': '/repo' },
    });
    (getPaneMetadata as any).mockResolvedValue({
      git: { branch: 'main', dirty: false, changedCount: 0, ahead: 0, behind: 0 },
      ports: [], ssh: null, gatheredAt: 123,
    });
    await useMetadataStore.getState().refresh();
    expect(getPaneMetadata).toHaveBeenCalledWith('term-1', '/repo', 'tab-1');
    expect(useMetadataStore.getState().data?.git?.branch).toBe('main');
    expect(useMetadataStore.getState().loading).toBe(false);
  });
});

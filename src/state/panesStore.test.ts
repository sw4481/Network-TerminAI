import { describe, it, expect, beforeEach } from 'vitest';
import { usePanesStore, shouldReconcileTerminalId } from './panesStore';

describe('panesStore', () => {
  beforeEach(() => {
    usePanesStore.setState({
      layoutsByTab: new Map(),
      focusedPaneId: null,
    });
  });

  it('should initialize with single pane layout', () => {
    const layout = usePanesStore.getState().initializeLayout('tab-1');

    expect(layout.type).toBe('leaf');
    expect(layout.id).toBeDefined();
    expect(layout.terminalId).toBe('tab-1');
  });

  it('should split pane horizontally', () => {
    const store = usePanesStore.getState();
    const layout = store.initializeLayout('tab-1');

    const newLayout = store.splitPane(layout.id, 'horizontal');

    expect(newLayout.type).toBe('split');
    expect(newLayout.direction).toBe('horizontal');
    expect(newLayout.children).toHaveLength(2);
    expect(newLayout.children[0].size).toBe(50);
    expect(newLayout.children[1].size).toBe(50);
  });

  it('should split pane vertically', () => {
    const store = usePanesStore.getState();
    const layout = store.initializeLayout('tab-1');

    const newLayout = store.splitPane(layout.id, 'vertical');

    expect(newLayout.type).toBe('split');
    expect(newLayout.direction).toBe('vertical');
    expect(newLayout.children).toHaveLength(2);
  });

  it('should close pane and rebalance siblings', () => {
    const store = usePanesStore.getState();
    let layout = store.initializeLayout('tab-1');
    layout = store.splitPane(layout.id, 'horizontal');

    const paneToClose = layout.children[0].id;
    const newLayout = store.closePane(paneToClose);

    expect(newLayout.type).toBe('leaf');
    expect(newLayout.id).not.toBe(paneToClose);
  });

  it('should update pane sizes on resize', () => {
    const store = usePanesStore.getState();
    let layout = store.initializeLayout('tab-1');
    layout = store.splitPane(layout.id, 'horizontal');

    const newLayout = store.resizePane(layout.id, [30, 70]);

    expect(newLayout.children[0].size).toBe(30);
    expect(newLayout.children[1].size).toBe(70);
  });

  it('should track focused pane', () => {
    const store = usePanesStore.getState();
    const layout = store.initializeLayout('tab-1');

    store.setFocusedPane(layout.id);

    expect(usePanesStore.getState().focusedPaneId).toBe(layout.id);
  });

  describe('shouldReconcileTerminalId', () => {
    it('reconciles a root pane (terminalId === tabId) to the spawned PTY id', () => {
      // Root pane starts as terminalId = tabId; the spawned PTY has a
      // different id. This is the case that broke recording.
      expect(shouldReconcileTerminalId('tab-1', 'spawned-pty-9')).toBe(true);
    });

    it('reconciles a freshly split pending pane', () => {
      expect(shouldReconcileTerminalId('pending-abc', 'spawned-pty-9')).toBe(true);
    });

    it('reconciles a reloaded pane holding a stale dead id', () => {
      expect(shouldReconcileTerminalId('old-dead-pty', 'spawned-pty-9')).toBe(true);
    });

    it('does not reconcile when the id is already correct', () => {
      expect(shouldReconcileTerminalId('spawned-pty-9', 'spawned-pty-9')).toBe(false);
    });

    it('ignores an empty registered id', () => {
      expect(shouldReconcileTerminalId('tab-1', '')).toBe(false);
    });
  });

  describe('resolveRecordingTerminalId', () => {
    it('returns the tab id itself for a single-pane tab', () => {
      const store = usePanesStore.getState();
      store.initializeLayout('tab-1');
      // Single pane: terminalId === tabId.
      expect(store.resolveRecordingTerminalId('tab-1')).toBe('tab-1');
    });

    it('returns the focused pane terminalId in a split layout', () => {
      const store = usePanesStore.getState();
      const layout = store.initializeLayout('tab-1');
      // Split creates a second pane with its own PTY terminal id.
      const split = store.splitPane(layout.id, 'horizontal', 'pty-second');
      if (split.type !== 'split') throw new Error('expected split');
      const secondLeaf = split.children[1];
      store.setFocusedPane(secondLeaf.id);

      expect(store.resolveRecordingTerminalId('tab-1')).toBe('pty-second');
    });

    it('falls back to the first leaf terminalId when focus is unknown', () => {
      const store = usePanesStore.getState();
      const layout = store.initializeLayout('tab-1');
      store.splitPane(layout.id, 'horizontal', 'pty-second');
      usePanesStore.setState({ focusedPaneId: 'pane-does-not-exist' });

      // First leaf is the original tab terminal.
      expect(store.resolveRecordingTerminalId('tab-1')).toBe('tab-1');
    });

    it('falls back to the tab id when no layout exists', () => {
      const store = usePanesStore.getState();
      expect(store.resolveRecordingTerminalId('tab-unknown')).toBe('tab-unknown');
    });
  });
});

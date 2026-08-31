import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, act, fireEvent } from '@testing-library/react';
import { useState as useStateForMock } from 'react';

// The PTY-backed Terminal and the panes store are heavy / side-effectful;
// stub them so this test isolates ONE thing: which id Pane forwards to the
// activity indicators. Regression guard for the bug where Pane passed the
// layout `paneId` (pane-<uuid>) instead of `terminalId` (the PTY/tab id the
// backend keys pane_activity_updated by), so indicators never matched.
const indicatorPaneIds: string[] = [];
const badgePaneIds: string[] = [];

// Shared mock so tests can assert on calls; also exposed for the
// respawn-loop regression test below.
const updatePaneTerminalIdMock = vi.fn();
const ptyWriteMock = vi.hoisted(() => vi.fn());
const reconnectMock = vi.hoisted(() => vi.fn(async () => true));
const useLocalShellMock = vi.hoisted(() => vi.fn());

// Captures the onRegistered callback the real Pane passes to Terminal, so
// tests can simulate the registry resolving a PTY id (like TerminalSlot does)
// without depending on the real Terminal/PTY machinery.
let capturedOnRegistered: ((id: string) => void) | undefined;

// Mock dependencies FIRST, before any imports
vi.mock('./Terminal', () => ({
  Terminal: (props: { onRegistered?: (id: string) => void }) => {
    capturedOnRegistered = props.onRegistered;
    return <textarea className="xterm-helper-textarea" aria-label="Terminal input" />;
  },
}));
vi.mock('./PaneActivityIndicator', () => ({
  PaneActivityIndicator: ({ paneId }: { paneId: string }) => {
    indicatorPaneIds.push(paneId);
    return null;
  },
}));
vi.mock('./AgentActivityBadge', () => ({
  default: ({ paneId }: { paneId: string }) => {
    badgePaneIds.push(paneId);
    return null;
  },
}));
vi.mock('../state/panesStore', () => ({
  usePanesStore: (selector: (s: unknown) => unknown) =>
    selector({
      focusedPaneId: 'pane-abc',
      setFocusedPane: vi.fn(),
      updatePaneTerminalId: updatePaneTerminalIdMock,
      closePane: vi.fn(),
    }),
  shouldReconcileTerminalId: () => false,
}));
vi.mock('../lib/tauri', () => ({ ptyKill: vi.fn(), ptyWrite: ptyWriteMock }));
vi.mock('../lib/sshReconnect', () => ({
  reconnectSavedSsh: reconnectMock,
  useLocalShell: useLocalShellMock,
}));

// Mock useBlockShortcuts to avoid complex dependencies in tests
vi.mock('../hooks/useBlockShortcuts', () => ({
  useBlockShortcuts: vi.fn(() => ({
    focusedBlockId: null,
    setFocusedBlockId: vi.fn(),
    chordPending: false,
  })),
}));

import { Pane } from './Pane';
import { useTerminalConnectionStore } from '../state/terminalConnectionStore';

describe('Pane activity indicator wiring', () => {
  beforeEach(() => {
    indicatorPaneIds.length = 0;
    badgePaneIds.length = 0;
  });

  it('forwards terminalId (the backend activity key), not the layout paneId', () => {
    render(
      <Pane
        paneId="pane-abc"
        terminalId="tab-xyz-pty"
        shell="/bin/zsh"
        cwd="/home"
      />,
    );

    // Both indicators must receive the terminalId so their store lookup
    // matches the backend-emitted activity (keyed by tab/PTY id).
    expect(indicatorPaneIds).toContain('tab-xyz-pty');
    expect(badgePaneIds).toContain('tab-xyz-pty');
    expect(indicatorPaneIds).not.toContain('pane-abc');
    expect(badgePaneIds).not.toContain('pane-abc');
  });
});

describe('Pane Network Architect terminal action', () => {
  it('dispatches an explicitly attached Network Architect request for this pane', () => {
    const listener = vi.fn();
    window.addEventListener('ccie:invoke-agent', listener);
    const { container, getByRole } = render(
      <Pane paneId="pane-abc" terminalId="tab-xyz-pty" shell="/bin/zsh" cwd="/home" />,
    );

    fireEvent.contextMenu(container.firstElementChild as Element, { clientX: 20, clientY: 20 });
    fireEvent.click(getByRole('button', { name: /Troubleshoot with Network Architect/i }));

    expect(listener).toHaveBeenCalledTimes(1);
    expect((listener.mock.calls[0][0] as CustomEvent).detail).toEqual({
      agentId: 'network-architect',
      message: 'Troubleshoot this terminal session.',
      autoSend: false,
      attachTerminal: true,
    });
    window.removeEventListener('ccie:invoke-agent', listener);
  });
});

describe('Pane saved SSH reconnect UI', () => {
  beforeEach(() => {
    reconnectMock.mockClear();
    useLocalShellMock.mockClear();
    ptyWriteMock.mockClear();
    useTerminalConnectionStore.setState({ byTerminalId: {}, terminalIdByBackendPtyId: {} });
    useTerminalConnectionStore.getState().bind({
      terminalId: 'tab-xyz-pty',
      backendPtyId: 'pty-backend',
      connectionId: 'connection-1',
      displayName: 'Core Router',
      vendor: 'cisco',
      platform: 'iosxe',
      accentColor: 'cyan',
      syntaxHighlightingEnabled: true,
      syntaxProfile: 'auto',
      sshCommand: 'ssh core',
    });
    useTerminalConnectionStore.getState().setLifecycle('tab-xyz-pty', 'disconnected', {
      exitStatus: 255,
    });
  });

  it('shows exit status and routes button actions without changing terminal identity', () => {
    const { getByRole } = render(
      <Pane paneId="pane-abc" terminalId="tab-xyz-pty" shell="/bin/zsh" cwd="/home" />,
    );
    expect(getByRole('status')).toHaveTextContent(/Core Router.*disconnected.*exit 255/);
    fireEvent.click(getByRole('button', { name: 'Reconnect' }));
    expect(reconnectMock).toHaveBeenCalledWith('tab-xyz-pty');
    fireEvent.click(getByRole('button', { name: 'Use local shell' }));
    expect(useLocalShellMock).toHaveBeenCalledWith('tab-xyz-pty');
    expect(updatePaneTerminalIdMock).not.toHaveBeenCalled();
  });

  it('captures unmodified Enter only at the focused disconnected xterm boundary', () => {
    const { getByLabelText } = render(
      <Pane paneId="pane-abc" terminalId="tab-xyz-pty" shell="/bin/zsh" cwd="/home" />,
    );
    const input = getByLabelText('Terminal input');
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(reconnectMock).toHaveBeenCalledTimes(1);
    expect(ptyWriteMock).not.toHaveBeenCalled();

    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
    expect(reconnectMock).toHaveBeenCalledTimes(1);
  });
});

describe('Pane blocks-mode local PTY id tracking', () => {
  beforeEach(() => {
    updatePaneTerminalIdMock.mockClear();
    capturedOnRegistered = undefined;
  });

  it('never reconciles resolvedPtyTabId into the pane terminalId path (respawn-loop guard)', () => {
    // Regression guard for the 2026-06-23 infinite PTY-respawn bug: in
    // ENABLE_TERMINAL_REGISTRY mode, resolvedPtyTabId must be a UI-only side
    // channel (for BlockList/useBlockShortcuts/InputEditor) that never flows
    // into updatePaneTerminalId or the pane's real terminalId prop. Firing
    // Terminal's onRegistered callback with a fake PTY id must NOT trigger
    // updatePaneTerminalId — that reconciliation path is guarded off under
    // ENABLE_TERMINAL_REGISTRY (see handleTerminalRegistered in Pane.tsx).
    render(
      <Pane paneId="pane-abc" terminalId="tab-xyz-pty" shell="/bin/zsh" cwd="/home" />,
    );

    // The mocked Terminal (declared at top of file) captured onRegistered.
    expect(capturedOnRegistered).toBeInstanceOf(Function);

    act(() => {
      capturedOnRegistered?.('resolved-pty-1');
    });

    expect(updatePaneTerminalIdMock).not.toHaveBeenCalled();
  });
});

describe('Pane blocks-mode rendering', () => {
  it('shows the Blocks/Terminal toggle and renders BlockList only when blocksMode is on, without changing Terminal props', async () => {
    // The top of this file already statically imported ./Pane (and its
    // dependencies) using the module-level vi.mock() calls above. Reset the
    // module registry so the vi.doMock() overrides below actually take
    // effect for a fresh evaluation of Pane.tsx's import graph.
    vi.resetModules();

    const terminalRenders: Array<{ terminalId: string }> = [];
    vi.doMock('./Terminal', () => ({
      Terminal: (props: { terminalId: string; onRegistered?: (id: string) => void }) => {
        terminalRenders.push({ terminalId: props.terminalId });
        // Simulate the registry resolving a PTY id once, like TerminalSlot does.
        // Defer via setTimeout to avoid cross-component update warning.
        setTimeout(() => {
          props.onRegistered?.('resolved-pty-2');
        }, 0);
        return null;
      },
    }));
    vi.doMock('./BlockList', () => ({
      BlockList: ({ tabId }: { tabId: string }) => <div data-testid="block-list">{tabId}</div>,
    }));
    vi.doMock('../state/blocksStore', () => ({
      useBlocksStore: (selector: (s: unknown) => unknown) =>
        selector({ blocksByTab: new Map(), loadBlocksForTab: vi.fn() }),
    }));
    vi.doMock('../state/panesStore', () => ({
      usePanesStore: (selector: (s: unknown) => unknown) =>
        selector({
          focusedPaneId: 'pane-abc',
          setFocusedPane: vi.fn(),
          updatePaneTerminalId: vi.fn(),
          closePane: vi.fn(),
        }),
      shouldReconcileTerminalId: () => false,
    }));

    const rtl = await import('@testing-library/react');
    const { Pane } = await import('./Pane');
    const { getByText, queryByTestId } = await act(async () =>
      rtl.render(
        <Pane paneId="pane-abc" terminalId="tab-xyz-pty" shell="/bin/zsh" cwd="/home" />,
      ),
    );

    // BlockList not shown by default (Terminal mode is the default).
    expect(queryByTestId('block-list')).toBeNull();

    // Toggle to Blocks mode.
    await act(async () => {
      rtl.fireEvent.click(getByText('Blocks'));
      // Let deferred callbacks run
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(queryByTestId('block-list')).not.toBeNull();

    // Terminal re-renders as part of normal React updates (onRegistered
    // firing, the mode toggle), but every render must see the SAME
    // terminalId — if a different one ever appeared, Terminal would have
    // been re-keyed, forcing a remount/PTY-respawn. That's the real
    // invariant this test guards, not the exact render count.
    expect(terminalRenders.length).toBeGreaterThan(0);
    expect(new Set(terminalRenders.map((r) => r.terminalId))).toEqual(new Set(['tab-xyz-pty']));
  });
});

describe('Pane blocks-mode does not affect terminal registry lifecycle', () => {
  it('toggling blocksMode on/off repeatedly never remounts Terminal or re-keys it', async () => {
    // Regression guard for the operator's explicit concern: blocks-mode
    // toggling must never disturb the split-pane / no-duplicate-PTY fix from
    // the 2026-06-22 terminal registry work. A remount would show up here as
    // EITHER a new `instanceId` (a fresh component instance — see below) or a
    // different `terminalId` prop (a re-key). Both must stay constant across
    // every render, no matter how many times the mode is toggled.
    //
    // NOTE: this intentionally does NOT assert an exact render/mount COUNT.
    // The mocked Terminal below re-renders on every mode toggle (it's
    // unconditionally mounted in Pane.tsx, just CSS-hidden), so the render
    // count legitimately grows with each click — that is expected, correct
    // behavior, not a bug. Asserting a fixed count (e.g. always 1) would be a
    // tautology that fails for the CORRECT implementation, which is exactly
    // the flaw found in this task's brief's example code during review.
    vi.resetModules();

    let mountCounter = 0;
    const terminalRenders: Array<{ terminalId: string; instanceId: number }> = [];

    vi.doMock('./Terminal', () => ({
      Terminal: (props: { terminalId: string; onRegistered?: (id: string) => void }) => {
        // useState's lazy initializer runs exactly once per component
        // INSTANCE (on first mount) — never again on re-render. If React
        // ever unmounted and remounted this component (e.g. because a
        // toggle changed its key or its position in a conditional branch), a
        // fresh instance would run this initializer again and get a new,
        // higher id. Every render of the SAME live instance keeps the id it
        // got at mount.
        const [instanceId] = useStateForMock(() => ++mountCounter);
        terminalRenders.push({ terminalId: props.terminalId, instanceId });
        // Defer onRegistered like TerminalSlot's real async PTY-ready
        // callback would — calling a parent setState synchronously during
        // this component's render triggers React's "Cannot update a
        // component while rendering a different component" warning.
        setTimeout(() => {
          props.onRegistered?.('resolved-pty-3');
        }, 0);
        return null;
      },
    }));
    vi.doMock('./BlockList', () => ({
      BlockList: () => <div data-testid="block-list" />,
    }));
    vi.doMock('../state/blocksStore', () => ({
      useBlocksStore: (selector: (s: unknown) => unknown) =>
        selector({ blocksByTab: new Map(), loadBlocksForTab: vi.fn() }),
    }));
    vi.doMock('../state/panesStore', () => ({
      usePanesStore: (selector: (s: unknown) => unknown) =>
        selector({
          focusedPaneId: 'pane-abc',
          setFocusedPane: vi.fn(),
          updatePaneTerminalId: vi.fn(),
          closePane: vi.fn(),
        }),
      shouldReconcileTerminalId: () => false,
    }));

    const rtl = await import('@testing-library/react');
    const { Pane } = await import('./Pane');
    const { getByText } = await act(async () =>
      rtl.render(
        <Pane paneId="pane-abc" terminalId="tab-xyz-pty" shell="/bin/zsh" cwd="/home" />,
      ),
    );

    // Toggle blocks mode on and off several times (more than the brief's
    // literal 4 clicks, to make the regression guard harder to satisfy by
    // accident). Each click is followed by a flush of the mocked Terminal's
    // deferred onRegistered callback, mirroring how the real async PTY-ready
    // callback resolves.
    const clickAndFlush = async (label: string) => {
      await act(async () => {
        rtl.fireEvent.click(getByText(label));
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    };
    await clickAndFlush('Blocks');
    await clickAndFlush('Terminal');
    await clickAndFlush('Blocks');
    await clickAndFlush('Terminal');
    await clickAndFlush('Blocks');
    await clickAndFlush('Terminal');

    // Sanity: Terminal actually re-rendered as part of the toggles (else the
    // test below would be vacuous).
    expect(terminalRenders.length).toBeGreaterThan(1);

    // The REAL invariant: every render — across the initial mount and all six
    // toggles — belongs to the SAME component instance (one mount, ever) and
    // saw the SAME terminalId prop (never re-keyed). A remount or re-key
    // would surface as a second distinct instanceId or terminalId here.
    expect(new Set(terminalRenders.map((r) => r.instanceId))).toEqual(new Set([1]));
    expect(new Set(terminalRenders.map((r) => r.terminalId))).toEqual(new Set(['tab-xyz-pty']));
    expect(mountCounter).toBe(1);
  });
});

describe('Pane terminal buffer search', () => {
  it('scopes Ctrl+F to the focused terminal and routes result navigation', async () => {
    vi.resetModules();
    const findNext = vi.fn(() => true);
    const findPrevious = vi.fn(() => true);
    const clearDecorations = vi.fn();
    const focus = vi.fn();
    let resultsListener: ((value: { resultIndex: number; resultCount: number }) => void) | null = null;
    const searchHandle = {
      findNext,
      findPrevious,
      clearDecorations,
      focus,
      onDidChangeResults: vi.fn((listener) => {
        resultsListener = listener;
        return { dispose: vi.fn() };
      }),
    };
    vi.doMock('./Terminal', () => ({
      Terminal: ({ terminalId }: { terminalId: string }) => (
        <textarea className="terminal-registry-surface" data-testid={`surface-${terminalId}`} />
      ),
    }));
    vi.doMock('../lib/terminalRegistry', () => ({
      getSelection: vi.fn(() => ''),
      searchHandleFor: vi.fn(() => searchHandle),
    }));
    vi.doMock('../state/agentsStore', () => ({
      useAgentsStore: (selector: (s: unknown) => unknown) => selector({ agents: [] }),
    }));
    vi.doMock('../state/panesStore', () => ({
      usePanesStore: (selector: (s: unknown) => unknown) =>
        selector({
          focusedPaneId: 'pane-a',
          setFocusedPane: vi.fn(),
          updatePaneTerminalId: vi.fn(),
          closePane: vi.fn(),
        }),
      shouldReconcileTerminalId: () => false,
    }));

    const platform = vi.spyOn(navigator, 'platform', 'get').mockReturnValue('Linux x86_64');
    const rtl = await import('@testing-library/react');
    const { Pane } = await import('./Pane');
    const view = rtl.render(
      <>
        <Pane paneId="pane-a" terminalId="term-a" shell="/bin/zsh" cwd="/home" />
        <Pane paneId="pane-b" terminalId="term-b" shell="/bin/zsh" cwd="/home" />
      </>,
    );

    rtl.fireEvent.keyDown(view.getByTestId('surface-term-b'), { key: 'f', ctrlKey: true });
    expect(view.queryByLabelText('Search terminal scrollback')).toBeNull();

    rtl.fireEvent.keyDown(view.getByTestId('surface-term-a'), { key: 'f', ctrlKey: true });
    const input = view.getByLabelText('Search terminal scrollback');
    rtl.fireEvent.change(input, { target: { value: 'needle' } });
    expect(findNext).toHaveBeenCalledWith(
      'needle',
      expect.objectContaining({ caseSensitive: false, regex: false, wholeWord: false }),
    );

    act(() => resultsListener?.({ resultIndex: 1, resultCount: 4 }));
    expect(view.getByText('2 / 4')).toBeTruthy();
    rtl.fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
    expect(findPrevious).toHaveBeenCalledWith('needle', expect.anything());
    rtl.fireEvent.keyDown(input, { key: 'Escape' });
    await rtl.waitFor(() => expect(view.queryByLabelText('Search terminal scrollback')).toBeNull());
    expect(clearDecorations).toHaveBeenCalled();
    platform.mockRestore();
  });
});

describe('Pane context menu', () => {
  it('opens on right-click, shows Ask AI + Copy only when there is a selection, and closes on outside click', async () => {
    vi.resetModules();
    vi.doMock('./Terminal', () => ({
      Terminal: () => null,
    }));
    vi.doMock('../lib/terminalRegistry', () => ({
      getSelection: vi.fn(() => 'show version output'),
      searchHandleFor: vi.fn(() => null),
    }));
    vi.doMock('../state/agentsStore', () => ({
      useAgentsStore: (selector: (s: unknown) => unknown) => selector({ agents: [] }),
    }));
    vi.doMock('../state/panesStore', () => ({
      usePanesStore: (selector: (s: unknown) => unknown) =>
        selector({
          focusedPaneId: 'pane-abc',
          setFocusedPane: vi.fn(),
          updatePaneTerminalId: vi.fn(),
          closePane: vi.fn(),
        }),
      shouldReconcileTerminalId: () => false,
    }));

    const rtl = await import('@testing-library/react');
    const { Pane } = await import('./Pane');
    const { getByText, queryByText, container } = rtl.render(
      <Pane paneId="pane-abc" terminalId="tab-xyz-pty" shell="/bin/zsh" cwd="/home" />,
    );

    const paneEl = container.querySelector('[data-pane-id="pane-abc"]')!;
    rtl.fireEvent.contextMenu(paneEl, { clientX: 10, clientY: 20 });

    expect(getByText(/Ask AI about selection/)).toBeTruthy();
    expect(getByText(/Copy/)).toBeTruthy();
    expect(getByText(/Paste/)).toBeTruthy();

    // Outside click closes the menu.
    rtl.fireEvent.click(window);
    expect(queryByText(/Ask AI about selection/)).toBeNull();
  });

  it('hides selection-gated items (Ask AI, Copy) when there is no selection', async () => {
    vi.resetModules();
    vi.doMock('./Terminal', () => ({
      Terminal: () => null,
    }));
    vi.doMock('../lib/terminalRegistry', () => ({
      getSelection: vi.fn(() => ''),
      searchHandleFor: vi.fn(() => null),
    }));
    vi.doMock('../state/agentsStore', () => ({
      useAgentsStore: (selector: (s: unknown) => unknown) => selector({ agents: [] }),
    }));
    vi.doMock('../state/panesStore', () => ({
      usePanesStore: (selector: (s: unknown) => unknown) =>
        selector({
          focusedPaneId: 'pane-abc',
          setFocusedPane: vi.fn(),
          updatePaneTerminalId: vi.fn(),
          closePane: vi.fn(),
        }),
      shouldReconcileTerminalId: () => false,
    }));

    const rtl = await import('@testing-library/react');
    const { Pane } = await import('./Pane');
    const { getByText, queryByText, container } = rtl.render(
      <Pane paneId="pane-abc" terminalId="tab-xyz-pty" shell="/bin/zsh" cwd="/home" />,
    );

    const paneEl = container.querySelector('[data-pane-id="pane-abc"]')!;
    rtl.fireEvent.contextMenu(paneEl, { clientX: 10, clientY: 20 });

    expect(queryByText(/Ask AI about selection/)).toBeNull();
    expect(queryByText(/^Copy$/)).toBeNull();
    // Paste is always shown, selection or not.
    expect(queryByText(/Paste/)).toBeTruthy();
    // "Run as Structured..." is NOT selection-gated — unlike Ask AI/Copy
    // above, it must still render on a right-click with no selection. This
    // is the assertion that actually distinguishes correct placement
    // (always-rendered wrapper) from an accidental move into the
    // selection-gated fragment, since both placements would satisfy a
    // with-selection test.
    expect(getByText(/Run as Structured/)).toBeTruthy();
  });
});

describe('Pane redacted scrollback export', () => {
  it('uses the resolved backend PTY id and keeps the menu action available without a selection', async () => {
    vi.resetModules();
    const chooseAndExportTerminalScrollback = vi.fn(async () => 'exported');
    vi.doMock('./Terminal', () => ({
      Terminal: (props: { onRegistered?: (id: string) => void }) => {
        setTimeout(() => props.onRegistered?.('resolved-backend-pty'), 0);
        return null;
      },
    }));
    vi.doMock('../lib/terminalRegistry', () => ({
      getSelection: vi.fn(() => ''),
      searchHandleFor: vi.fn(() => null),
    }));
    vi.doMock('../lib/terminalExport', () => ({ chooseAndExportTerminalScrollback }));
    vi.doMock('../state/agentsStore', () => ({
      useAgentsStore: (selector: (s: unknown) => unknown) => selector({ agents: [] }),
    }));
    vi.doMock('../state/panesStore', () => ({
      usePanesStore: (selector: (s: unknown) => unknown) =>
        selector({
          focusedPaneId: 'pane-abc',
          setFocusedPane: vi.fn(),
          updatePaneTerminalId: vi.fn(),
          closePane: vi.fn(),
        }),
      shouldReconcileTerminalId: () => false,
    }));

    const rtl = await import('@testing-library/react');
    const { Pane } = await import('./Pane');
    const view = rtl.render(
      <Pane paneId="pane-abc" terminalId="stable-layout-id" shell="/bin/zsh" cwd="/home" />,
    );
    await rtl.waitFor(() => {
      const paneEl = view.container.querySelector('[data-pane-id="pane-abc"]')!;
      rtl.fireEvent.contextMenu(paneEl, { clientX: 10, clientY: 20 });
      expect(view.getByText(/Export redacted scrollback/)).not.toBeDisabled();
    });
    rtl.fireEvent.click(view.getByText(/Export redacted scrollback/));
    await rtl.waitFor(() =>
      expect(chooseAndExportTerminalScrollback).toHaveBeenCalledWith('resolved-backend-pty'),
    );
  });
});

describe('Pane "Run as Structured..." menu item', () => {
  it('opens RunStructuredModal pre-filled with the first line of the selection, and closes it on modal close', async () => {
    vi.resetModules();
    vi.doMock('./Terminal', () => ({
      Terminal: () => null,
    }));
    vi.doMock('../lib/terminalRegistry', () => ({
      getSelection: vi.fn(() => 'show ip interface brief\nGigabitEthernet1  up  up'),
      searchHandleFor: vi.fn(() => null),
    }));
    vi.doMock('../state/agentsStore', () => ({
      useAgentsStore: (selector: (s: unknown) => unknown) => selector({ agents: [] }),
    }));
    vi.doMock('../state/panesStore', () => ({
      usePanesStore: (selector: (s: unknown) => unknown) =>
        selector({
          focusedPaneId: 'pane-abc',
          setFocusedPane: vi.fn(),
          updatePaneTerminalId: vi.fn(),
          closePane: vi.fn(),
        }),
      shouldReconcileTerminalId: () => false,
    }));
    let capturedInitialCommand: string | undefined;
    let capturedOnClose: (() => void) | undefined;
    vi.doMock('./RunStructuredModal', () => ({
      RunStructuredModal: (props: { initialCommand: string; onClose: () => void }) => {
        capturedInitialCommand = props.initialCommand;
        capturedOnClose = props.onClose;
        return <div data-testid="run-structured-modal" />;
      },
    }));

    const rtl = await import('@testing-library/react');
    const { Pane } = await import('./Pane');
    const { getByText, queryByTestId, container } = rtl.render(
      <Pane paneId="pane-abc" terminalId="tab-xyz-pty" shell="/bin/zsh" cwd="/home" />,
    );

    const paneEl = container.querySelector('[data-pane-id="pane-abc"]')!;
    rtl.fireEvent.contextMenu(paneEl, { clientX: 10, clientY: 20 });
    rtl.fireEvent.click(getByText(/Run as Structured/));

    expect(queryByTestId('run-structured-modal')).toBeTruthy();
    expect(capturedInitialCommand).toBe('show ip interface brief');

    capturedOnClose?.();
    await rtl.waitFor(() => expect(queryByTestId('run-structured-modal')).toBeNull());
  });
});

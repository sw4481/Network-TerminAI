import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  selection: 'show version output',
  copyTerminalSelection: vi.fn(),
  pasteClipboardToTerminal: vi.fn(),
  ptyWrite: vi.fn(),
  chooseAndExportTerminalScrollback: vi.fn(),
  clearSuggestions: vi.fn(),
}));

const term = {
  getSelection: () => mocks.selection,
  onData: () => ({ dispose: vi.fn() }),
  focus: vi.fn(),
  blur: vi.fn(),
  write: vi.fn(),
};

vi.mock('../hooks/usePty', () => ({
  ENABLE_LOCAL_ECHO: false,
  ENABLE_TERMINAL_REGISTRY: true,
  usePty: () => ({
    term,
    tabId: 'legacy-pty',
    fit: vi.fn(),
    dispose: vi.fn(),
    setRemoteSession: vi.fn(),
    search: null,
  }),
}));
vi.mock('../lib/terminalClipboard', () => ({
  copyTerminalSelection: (...args: unknown[]) => mocks.copyTerminalSelection(...args),
  pasteClipboardToTerminal: (...args: unknown[]) => mocks.pasteClipboardToTerminal(...args),
}));
vi.mock('../lib/tauri', () => ({
  ptyWrite: (...args: unknown[]) => mocks.ptyWrite(...args),
  terminalLaunchSavedSsh: vi.fn(),
}));
vi.mock('../lib/terminalExport', () => ({
  chooseAndExportTerminalScrollback: (...args: unknown[]) =>
    mocks.chooseAndExportTerminalScrollback(...args),
}));
vi.mock('../state/agentsStore', () => ({ useAgentsStore: (selector: any) => selector({ agents: [] }) }));
vi.mock('../state/blocksStore', () => ({
  useBlocksStore: (selector: any) => selector({ blocksByTab: new Map(), loadBlocksForTab: vi.fn() }),
}));
vi.mock('../state/sshPasswordStore', () => ({
  useSshPasswordStore: (selector: any) => selector({ setPasswordContext: vi.fn() }),
}));
vi.mock('../state/tabsStore', () => {
  const useTabs = (selector: any) => selector({ activeTabId: 'tab-1' });
  useTabs.getState = () => ({ tabs: [] });
  return { useTabs };
});
vi.mock('../state/panesStore', () => ({
  usePanesStore: (selector: any) => selector({ focusedPaneId: 'pane-1' }),
}));
vi.mock('../state/iacStateStore', () => ({
  useIacStateStore: { getState: () => ({ cwdByTerminal: {}, openDrawer: vi.fn() }) },
}));
vi.mock('../state/topologyStore', () => ({
  useTopologyStore: { getState: () => ({ ingestFromText: vi.fn() }) },
}));
vi.mock('../hooks/useCommandSuggestions', () => ({
  useCommandSuggestions: () => ({
    suggestions: [],
    loading: false,
    getSuggestions: vi.fn(),
    clearSuggestions: mocks.clearSuggestions,
  }),
}));
vi.mock('../hooks/useParameterDetection', () => ({
  useParameterDetection: () => ({ commandDef: null, shouldShow: false }),
}));
vi.mock('../hooks/useBlockShortcuts', () => ({
  useBlockShortcuts: () => ({ focusedBlockId: null, setFocusedBlockId: vi.fn() }),
}));
vi.mock('./CommandSuggestions', () => ({ CommandSuggestions: () => null }));
vi.mock('./ParameterForm', () => ({ ParameterForm: () => null }));
vi.mock('./NaturalLanguageInput', () => ({ NaturalLanguageInput: () => null }));
vi.mock('./CommandTemplates', () => ({ CommandTemplates: () => null }));
vi.mock('./BlockList', () => ({ BlockList: () => null }));
vi.mock('./InputEditor', () => ({ InputEditor: () => null }));
vi.mock('./TerminalSlot', () => ({ TerminalSlot: () => null }));

import { Terminal } from './Terminal';

describe('legacy terminal clipboard context menu', () => {
  beforeEach(() => {
    mocks.selection = 'show version output';
    mocks.copyTerminalSelection.mockReset().mockResolvedValue(undefined);
    mocks.pasteClipboardToTerminal.mockReset().mockImplementation(async (write) => {
      await write('show clock');
      return 'written';
    });
    mocks.ptyWrite.mockReset().mockResolvedValue(undefined);
    mocks.chooseAndExportTerminalScrollback.mockReset().mockResolvedValue('exported');
    mocks.clearSuggestions.mockReset();
  });

  it('retains selection-gated Copy and always-present Paste using the shared helper', async () => {
    const { container } = render(<Terminal shell="/bin/zsh" cwd="/tmp" />);
    fireEvent.contextMenu(container.querySelector('.xterm-container')!, { clientX: 10, clientY: 10 });
    expect(screen.getByText(/Ask AI about selection/)).toBeTruthy();
    fireEvent.click(screen.getByText(/Copy/));
    await waitFor(() => expect(mocks.copyTerminalSelection).toHaveBeenCalledWith('show version output'));

    fireEvent.contextMenu(container.querySelector('.xterm-container')!, { clientX: 10, clientY: 10 });
    fireEvent.click(screen.getByText(/Paste/));
    await waitFor(() => expect(mocks.ptyWrite).toHaveBeenCalledTimes(1));
    expect(mocks.ptyWrite.mock.calls[0][0]).toBe('legacy-pty');
    expect(new TextDecoder().decode(mocks.ptyWrite.mock.calls[0][1])).toBe('show clock');
  });

  it('keeps Paste visible without a selection and performs no direct write on cancellation', async () => {
    mocks.selection = '';
    mocks.pasteClipboardToTerminal.mockResolvedValue('cancelled');
    const { container } = render(<Terminal shell="/bin/zsh" cwd="/tmp" />);
    fireEvent.contextMenu(container.querySelector('.xterm-container')!, { clientX: 10, clientY: 10 });
    expect(screen.queryByText(/Copy/)).toBeNull();
    fireEvent.click(screen.getByText(/Paste/));
    await waitFor(() => expect(mocks.pasteClipboardToTerminal).toHaveBeenCalledTimes(1));
    expect(mocks.ptyWrite).not.toHaveBeenCalled();
  });

  it('exports redacted scrollback with the fallback PTY id', async () => {
    const { container } = render(<Terminal shell="/bin/zsh" cwd="/tmp" />);
    fireEvent.contextMenu(container.querySelector('.xterm-container')!, { clientX: 10, clientY: 10 });
    fireEvent.click(screen.getByText(/Export redacted scrollback/));
    await waitFor(() =>
      expect(mocks.chooseAndExportTerminalScrollback).toHaveBeenCalledWith('legacy-pty'),
    );
  });
});

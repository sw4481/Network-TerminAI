import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import RichInputModal from './RichInputModal';

const ptyWrite = vi.fn();
vi.mock('../lib/tauri', () => ({
  ptyWrite: (tabId: string, data: Uint8Array) => {
    ptyWrite(tabId, data);
    return Promise.resolve();
  },
}));
vi.mock('../state/panesStore', () => ({
  usePanesStore: Object.assign(() => null, {
    getState: () => ({
      resolveRecordingTerminalId: (tabId: string) => 'terminal-for-' + tabId,
    }),
  }),
}));
vi.mock('../state/tabsStore', () => ({
  useTabs: Object.assign(() => null, {
    getState: () => ({
      activeTabId: 'tab-1',
    }),
  }),
}));
vi.mock('../lib/terminalRegistry', () => ({
  ptyTabIdFor: (terminalId: string) => 'pty-' + terminalId,
}));

function openWith(paneId: string | null) {
  window.dispatchEvent(new CustomEvent('ccie:open-rich-input', { detail: { paneId } }));
}

describe('RichInputModal', () => {
  beforeEach(() => ptyWrite.mockClear());

  it('is hidden until the open event fires', () => {
    render(<RichInputModal />);
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('writes text + newline to the target pane on send', async () => {
    render(<RichInputModal />);
    openWith('pane-A');
    const box = await screen.findByRole('textbox');
    fireEvent.change(box, { target: { value: 'show version' } });
    fireEvent.click(screen.getByText('Send'));
    await waitFor(() => expect(ptyWrite).toHaveBeenCalledTimes(1));
    const [tabId, data] = ptyWrite.mock.calls[0];
    expect(tabId).toBe('pane-A');
    expect(new TextDecoder().decode(data as Uint8Array)).toBe('show version\n');
  });

  it('falls back to the active tab pane when paneId is null', async () => {
    render(<RichInputModal />);
    openWith(null);
    const box = await screen.findByRole('textbox');
    fireEvent.change(box, { target: { value: 'hi' } });
    fireEvent.click(screen.getByText('Send'));
    await waitFor(() => expect(ptyWrite).toHaveBeenCalledTimes(1));
    expect(ptyWrite.mock.calls[0][0]).toBe('pty-terminal-for-tab-1');
  });

  it('cancel closes without writing', async () => {
    render(<RichInputModal />);
    openWith('pane-A');
    await screen.findByRole('textbox');
    fireEvent.click(screen.getByText('Cancel'));
    await waitFor(() => expect(screen.queryByRole('textbox')).toBeNull());
    expect(ptyWrite).not.toHaveBeenCalled();
  });

  it('send with empty text closes without writing', async () => {
    render(<RichInputModal />);
    openWith('pane-A');
    await screen.findByRole('textbox');
    fireEvent.click(screen.getByText('Send'));
    await waitFor(() => expect(screen.queryByRole('textbox')).toBeNull());
    expect(ptyWrite).not.toHaveBeenCalled();
  });
});

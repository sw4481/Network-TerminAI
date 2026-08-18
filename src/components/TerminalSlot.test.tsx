import { act } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  dataListener: null as ((data: string) => void) | null,
  suggestions: [] as Array<{ command: string; description: string; category?: string }>,
  getOrCreate: vi.fn(),
  attach: vi.fn(),
  detach: vi.fn(),
  disposeData: vi.fn(),
  ptyWrite: vi.fn(),
  getSuggestions: vi.fn(),
  clearSuggestions: vi.fn(),
}));

vi.mock('../lib/terminalRegistry', () => ({
  getOrCreate: (id?: unknown, opts?: unknown) => mocks.getOrCreate(id, opts),
  attach: (id?: unknown, slot?: unknown) => mocks.attach(id, slot),
  detach: (id?: unknown) => mocks.detach(id),
  has: () => true,
  ptyTabIdFor: () => 'pty-1',
}));

vi.mock('../lib/tauri', () => ({
  ptyWrite: (tabId: string, bytes: Uint8Array) => mocks.ptyWrite(tabId, bytes),
}));

vi.mock('../hooks/useCommandSuggestions', () => ({
  useCommandSuggestions: () => ({
    suggestions: mocks.suggestions,
    loading: false,
    getSuggestions: mocks.getSuggestions,
    clearSuggestions: mocks.clearSuggestions,
  }),
}));

import { TerminalSlot } from './TerminalSlot';

beforeEach(() => {
  mocks.dataListener = null;
  mocks.suggestions = [];
  mocks.getOrCreate.mockReset().mockReturnValue({
    ptyTabId: 'pty-1',
    xterm: {
      onData: (listener: (data: string) => void) => {
        mocks.dataListener = listener;
        return { dispose: mocks.disposeData };
      },
    },
  });
  mocks.attach.mockReset();
  mocks.detach.mockReset();
  mocks.disposeData.mockReset();
  mocks.ptyWrite.mockReset().mockResolvedValue(undefined);
  mocks.getSuggestions.mockReset();
  mocks.clearSuggestions.mockReset();
});

describe('TerminalSlot', () => {
  it('creates + attaches on mount, detaches (not disposes) on unmount', () => {
    const onRegistered = vi.fn();
    const { unmount } = render(
      <TerminalSlot terminalId="t1" shell="/bin/zsh" cwd="/home" onRegistered={onRegistered} />,
    );
    expect(mocks.getOrCreate).toHaveBeenCalledWith(
      't1',
      expect.objectContaining({ shell: '/bin/zsh', cwd: '/home' }),
    );
    expect(mocks.attach).toHaveBeenCalledWith('t1', expect.any(HTMLElement));
    expect(onRegistered).toHaveBeenCalledWith('pty-1');
    unmount();
    expect(mocks.detach).toHaveBeenCalledWith('t1');
  });

  it('accepts a visible suggestion on capture-phase Tab without sending Tab to the shell', async () => {
    mocks.suggestions = [
      {
        command: 'show ip interface brief',
        description: 'Show interface status',
        category: 'history',
      },
    ];
    const { container } = render(
      <TerminalSlot terminalId="t1" shell="/bin/zsh" cwd="/home" />,
    );

    act(() => {
      mocks.dataListener?.('s');
      mocks.dataListener?.('h');
    });
    expect(await screen.findByText('show ip interface brief')).toBeVisible();
    await waitFor(() => expect(mocks.getSuggestions).toHaveBeenCalledWith('sh'));

    const slot = container.querySelector('.terminal-slot');
    expect(slot).not.toBeNull();
    const allowedDefault = fireEvent.keyDown(slot!, {
      key: 'Tab',
      code: 'Tab',
    });

    expect(allowedDefault).toBe(false);
    expect(mocks.ptyWrite).toHaveBeenCalledTimes(1);
    const [tabId, bytes] = mocks.ptyWrite.mock.calls[0] as [string, Uint8Array];
    expect(tabId).toBe('pty-1');
    expect(new TextDecoder().decode(bytes)).toBe('ow ip interface brief');
    expect(new TextDecoder().decode(bytes)).not.toContain('\t');
  });
});

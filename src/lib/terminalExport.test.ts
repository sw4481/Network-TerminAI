import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  save: vi.fn(),
  message: vi.fn(),
  terminalExportScrollback: vi.fn(),
}));

vi.mock('@tauri-apps/plugin-dialog', () => ({
  save: (...args: unknown[]) => mocks.save(...args),
  message: (...args: unknown[]) => mocks.message(...args),
}));
vi.mock('./tauri', () => ({
  terminalExportScrollback: (...args: unknown[]) => mocks.terminalExportScrollback(...args),
}));

import { chooseAndExportTerminalScrollback } from './terminalExport';

describe('chooseAndExportTerminalScrollback', () => {
  beforeEach(() => {
    mocks.save.mockReset();
    mocks.message.mockReset().mockResolvedValue(undefined);
    mocks.terminalExportScrollback.mockReset().mockResolvedValue(undefined);
  });

  it('treats save-dialog cancellation as a no-op', async () => {
    mocks.save.mockResolvedValue(null);
    await expect(chooseAndExportTerminalScrollback('pty-1')).resolves.toBe('cancelled');
    expect(mocks.terminalExportScrollback).not.toHaveBeenCalled();
    expect(mocks.message).not.toHaveBeenCalled();
  });

  it('exports the resolved backend PTY to the selected text path', async () => {
    mocks.save.mockResolvedValue('/tmp/output.txt');
    await expect(chooseAndExportTerminalScrollback('pty/a')).resolves.toBe('exported');
    expect(mocks.save).toHaveBeenCalledWith({
      defaultPath: 'terminal-scrollback-pty_a.txt',
      filters: [{ name: 'Text', extensions: ['txt'] }],
    });
    expect(mocks.terminalExportScrollback).toHaveBeenCalledWith('pty/a', '/tmp/output.txt');
    expect(mocks.message).not.toHaveBeenCalled();
  });

  it('surfaces backend failures without claiming success', async () => {
    mocks.save.mockResolvedValue('/tmp/output.txt');
    mocks.terminalExportScrollback.mockRejectedValue(new Error('disk full'));
    await expect(chooseAndExportTerminalScrollback('pty-1')).resolves.toBe('failed');
    expect(mocks.message).toHaveBeenCalledWith(
      expect.stringContaining('disk full'),
      { title: 'Scrollback export failed', kind: 'error' },
    );
  });
});

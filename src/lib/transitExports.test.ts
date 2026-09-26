import { beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({
  invoke,
  Channel: class {
    onmessage: ((value: unknown) => void) | null = null;
  },
}));

import { recording } from './recording';
import { terminalExportScrollback } from './tauri';

describe('Transit export Tauri wrappers', () => {
  beforeEach(() => invoke.mockReset().mockResolvedValue(undefined));

  it('invokes terminal_export_scrollback with camelCase arguments', async () => {
    await terminalExportScrollback('pty-1', '/tmp/scrollback.txt');
    expect(invoke).toHaveBeenCalledWith('terminal_export_scrollback', {
      tabId: 'pty-1',
      targetPath: '/tmp/scrollback.txt',
    });
  });

  it('invokes recording_export_text without changing cast export', async () => {
    await recording.exportText('rec-1', '/tmp/recording.txt');
    await recording.export('rec-1', '/tmp/recording.cast');
    expect(invoke.mock.calls).toEqual([
      ['recording_export_text', { recordingId: 'rec-1', targetPath: '/tmp/recording.txt' }],
      ['recording_export', { recordingId: 'rec-1', targetPath: '/tmp/recording.cast' }],
    ]);
  });
});

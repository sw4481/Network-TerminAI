import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RecordingDto } from '../../lib/recording';

const mocks = vi.hoisted(() => ({
  list: [] as RecordingDto[],
  refreshList: vi.fn(),
  remove: vi.fn(),
  addTab: vi.fn(),
  save: vi.fn(),
  message: vi.fn(),
  exportCast: vi.fn(),
  exportText: vi.fn(),
}));

vi.mock('../../state/recordingStore', () => ({
  useRecordings: () => ({
    list: mocks.list,
    refreshList: mocks.refreshList,
    remove: mocks.remove,
  }),
}));
vi.mock('../../state/tabsStore', () => ({ useTabs: () => ({ addTab: mocks.addTab }) }));
vi.mock('@tauri-apps/plugin-dialog', () => ({
  save: (...args: unknown[]) => mocks.save(...args),
  message: (...args: unknown[]) => mocks.message(...args),
}));
vi.mock('../../lib/recording', () => ({
  recording: {
    export: (...args: unknown[]) => mocks.exportCast(...args),
    exportText: (...args: unknown[]) => mocks.exportText(...args),
  },
}));

import { RecordingsTab } from './RecordingsTab';

const complete: RecordingDto = {
  id: 'done',
  tabId: 'tab-1',
  startedAt: 1,
  endedAt: 2,
  path: '/tmp/done.cast',
  sizeBytes: 123,
  durationMs: 1000,
  sessionKind: 'local',
};
const active: RecordingDto = { ...complete, id: 'active', endedAt: null };

describe('RecordingsTab Cast/Text exports', () => {
  beforeEach(() => {
    mocks.list = [complete, active];
    mocks.refreshList.mockReset().mockResolvedValue(undefined);
    mocks.remove.mockReset().mockResolvedValue(undefined);
    mocks.addTab.mockReset();
    mocks.save.mockReset();
    mocks.message.mockReset().mockResolvedValue(undefined);
    mocks.exportCast.mockReset().mockResolvedValue(undefined);
    mocks.exportText.mockReset().mockResolvedValue(undefined);
  });

  it('keeps Cast separate and adds completed-only Text export', async () => {
    render(<RecordingsTab />);
    expect(screen.getByTestId('recording-cast-done')).toHaveTextContent('Cast');
    expect(screen.getByTestId('recording-text-done')).toHaveTextContent('Text');
    expect(screen.getByTestId('recording-cast-active')).toBeDisabled();
    expect(screen.getByTestId('recording-text-active')).toBeDisabled();

    mocks.save.mockResolvedValueOnce('/tmp/done.cast').mockResolvedValueOnce('/tmp/done.txt');
    fireEvent.click(screen.getByTestId('recording-cast-done'));
    await waitFor(() => expect(mocks.exportCast).toHaveBeenCalledWith('done', '/tmp/done.cast'));
    fireEvent.click(screen.getByTestId('recording-text-done'));
    await waitFor(() => expect(mocks.exportText).toHaveBeenCalledWith('done', '/tmp/done.txt'));
    expect(mocks.save.mock.calls[0][0]).toEqual({
      defaultPath: 'recording-done.cast',
      filters: [{ name: 'asciinema cast', extensions: ['cast'] }],
    });
    expect(mocks.save.mock.calls[1][0]).toEqual({
      defaultPath: 'recording-done.txt',
      filters: [{ name: 'Text', extensions: ['txt'] }],
    });
  });

  it('treats Text dialog cancellation as a no-op', async () => {
    mocks.save.mockResolvedValue(null);
    render(<RecordingsTab />);
    fireEvent.click(screen.getByTestId('recording-text-done'));
    await waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(1));
    expect(mocks.exportText).not.toHaveBeenCalled();
    expect(mocks.message).not.toHaveBeenCalled();
  });

  it('surfaces Text export failures', async () => {
    mocks.save.mockResolvedValue('/tmp/done.txt');
    mocks.exportText.mockRejectedValue(new Error('write denied'));
    render(<RecordingsTab />);
    fireEvent.click(screen.getByTestId('recording-text-done'));
    await waitFor(() => expect(mocks.message).toHaveBeenCalledWith(
      expect.stringContaining('write denied'),
      { title: 'Recording export failed', kind: 'error' },
    ));
  });
});

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SftpPanel } from './SftpPanel';

const mocks = vi.hoisted(() => ({
  connections: vi.fn(),
  connect: vi.fn(),
  list: vi.fn(),
  mutate: vi.fn(),
  transfer: vi.fn(),
  cancel: vi.fn(),
  disconnect: vi.fn(),
}));

vi.mock('../lib/sshConnections', () => ({
  sshListConnections: mocks.connections,
}));
vi.mock('../lib/sftp', () => ({
  sftpConnect: mocks.connect,
  sftpList: mocks.list,
  sftpMutate: mocks.mutate,
  sftpTransfer: mocks.transfer,
  sftpCancelTransfer: mocks.cancel,
  sftpDisconnect: mocks.disconnect,
}));

describe('SftpPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.connections.mockResolvedValue([{
      id: 'ssh-1',
      name: 'Router',
      host: '192.0.2.10',
    }]);
    mocks.connect.mockResolvedValue('sftp-1');
    mocks.list.mockImplementation(async (side: string) => side === 'local'
      ? {
          path: '$HOME/test',
          entries: [{
            name: 'upload.txt',
            path: '$HOME/test/upload.txt',
            is_dir: false,
            is_symlink: false,
            size: 12,
            modified_at: null,
          }],
        }
      : {
          path: '$HOME/test',
          entries: [{
            name: 'download.txt',
            path: '$HOME/test/download.txt',
            is_dir: false,
            is_symlink: false,
            size: 24,
            modified_at: null,
          }],
        });
    mocks.mutate.mockResolvedValue(undefined);
    mocks.transfer.mockResolvedValue('transfer-1');
    mocks.cancel.mockResolvedValue(true);
    mocks.disconnect.mockResolvedValue(undefined);
  });

  it('shows the host warning, connects, and browses both native and POSIX panes', async () => {
    render(<SftpPanel onClose={() => {}} />);
    expect(screen.getByText('Host identity is not verified for this SFTP session.')).toBeInTheDocument();
    await screen.findByRole('option', { name: /Router/ });
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));

    expect(await screen.findByText('upload.txt')).toBeInTheDocument();
    expect(await screen.findByText('download.txt')).toBeInTheDocument();
    expect(mocks.connect).toHaveBeenCalledWith('ssh-1', '');
    expect(mocks.list).toHaveBeenCalledWith('local', '', 'sftp-1');
    expect(mocks.list).toHaveBeenCalledWith('remote', '.', 'sftp-1');
  });

  it('starts one upload and disconnects when the panel closes', async () => {
    const onClose = vi.fn();
    render(<SftpPanel onClose={onClose} />);
    await screen.findByRole('option', { name: /Router/ });
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    const uploadFile = await screen.findByText('upload.txt');
    fireEvent.click(uploadFile.closest('button')!);
    fireEvent.click(screen.getByRole('button', { name: 'Upload →' }));
    await waitFor(() => expect(mocks.transfer).toHaveBeenCalledWith(
      'sftp-1',
      'upload',
      '$HOME/test/upload.txt',
      '$HOME/test/upload.txt',
      expect.any(Function),
    ));
    fireEvent.click(screen.getByRole('button', { name: 'Close SFTP' }));
    await waitFor(() => expect(mocks.disconnect).toHaveBeenCalledWith('sftp-1'));
    expect(onClose).toHaveBeenCalled();
  });
});

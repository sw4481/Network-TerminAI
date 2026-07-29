import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { SavedSSHConnectionsModal } from './SavedSSHConnectionsModal';

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));

const CONN = {
  id: 'conn-1',
  name: 'core-sw1',
  host: '192.168.1.1',
  user: 'admin',
  port: 22,
  identity_file: null,
  password_encrypted: 'ENC_BLOB',
  created_at: 1_000,
  last_used_at: null,
};

describe('SavedSSHConnectionsModal — Connect password decryption', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    invokeMock.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
      if (cmd === 'ssh_list_connections') return Promise.resolve([CONN]);
      if (cmd === 'ssh_decrypt_password') {
        // The command decrypts the *encrypted blob*, not a connection id.
        expect(args).toEqual({ encrypted: 'ENC_BLOB' });
        return Promise.resolve('s3cret');
      }
      if (cmd === 'ssh_mark_used') return Promise.resolve(null);
      return Promise.resolve(null);
    });
  });

  it('decrypts using the encrypted blob and forwards the password to onConnect', async () => {
    const onConnect = vi.fn();
    render(<SavedSSHConnectionsModal onConnect={onConnect} onClose={() => {}} />);

    // Wait for the list to render.
    const connectBtn = await screen.findByTitle('Connect');
    fireEvent.click(connectBtn);

    await waitFor(() => expect(onConnect).toHaveBeenCalledTimes(1));

    // decrypt must have been called with { encrypted } (the regression).
    expect(invokeMock).toHaveBeenCalledWith('ssh_decrypt_password', {
      encrypted: 'ENC_BLOB',
    });
    // and the decrypted password must reach onConnect.
    const [, password] = onConnect.mock.calls[0];
    expect(password).toBe('s3cret');
  });

  it('connects with null password (key-based) when no saved password exists', async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === 'ssh_list_connections')
        return Promise.resolve([{ ...CONN, password_encrypted: null }]);
      if (cmd === 'ssh_mark_used') return Promise.resolve(null);
      if (cmd === 'ssh_decrypt_password')
        throw new Error('decrypt should not be called when there is no saved password');
      return Promise.resolve(null);
    });

    const onConnect = vi.fn();
    render(<SavedSSHConnectionsModal onConnect={onConnect} onClose={() => {}} />);

    const connectBtn = await screen.findByTitle('Connect');
    fireEvent.click(connectBtn);

    await waitFor(() => expect(onConnect).toHaveBeenCalledTimes(1));
    const [, password] = onConnect.mock.calls[0];
    expect(password).toBeNull();
    expect(invokeMock).not.toHaveBeenCalledWith('ssh_decrypt_password', expect.anything());
  });
});

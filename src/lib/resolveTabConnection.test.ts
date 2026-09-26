import { describe, it, expect, vi } from 'vitest';

const invokeMock = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

import { listSshConnections, matchConnectionForTab, resolveSshPassword, type SshConnection } from './resolveTabConnection';

const CONN_A: SshConnection = {
  id: 'conn-a',
  name: 'Switch A',
  host: '10.0.0.1',
  user: 'admin',
  port: 22,
  identity_file: null,
  password_encrypted: null,
  created_at: 0,
  last_used_at: null,
};

const CONN_B: SshConnection = {
  ...CONN_A,
  id: 'conn-b',
  name: 'Switch B',
  host: '10.0.0.2',
  user: null,
};

describe('listSshConnections', () => {
  it('invokes ssh_list_connections and returns its result', async () => {
    invokeMock.mockResolvedValueOnce([CONN_A]);
    const result = await listSshConnections();
    expect(invokeMock).toHaveBeenCalledWith('ssh_list_connections');
    expect(result).toEqual([CONN_A]);
  });
});

describe('matchConnectionForTab', () => {
  it('returns null when ctx is null', () => {
    expect(matchConnectionForTab([CONN_A, CONN_B], null)).toBeNull();
  });

  it('matches on exact host + exact user', () => {
    const match = matchConnectionForTab([CONN_A, CONN_B], { host: '10.0.0.1', user: 'admin' });
    expect(match?.id).toBe('conn-a');
  });

  it('matches on host when the saved connection has no user recorded', () => {
    const match = matchConnectionForTab([CONN_A, CONN_B], { host: '10.0.0.2', user: 'admin' });
    expect(match?.id).toBe('conn-b');
  });

  it('matches on host when ctx has no user recorded', () => {
    const match = matchConnectionForTab([CONN_A, CONN_B], { host: '10.0.0.1', user: null });
    expect(match?.id).toBe('conn-a');
  });

  it('returns null when host does not match anything', () => {
    expect(matchConnectionForTab([CONN_A, CONN_B], { host: '10.0.0.99', user: 'admin' })).toBeNull();
  });

  it('returns null when host matches but user conflicts', () => {
    expect(matchConnectionForTab([CONN_A], { host: '10.0.0.1', user: 'someone-else' })).toBeNull();
  });
});

describe('resolveSshPassword', () => {
  it('prefers the tab live session password when host matches', async () => {
    const getPasswordContext = vi.fn(() => ({ host: '10.0.0.1', password: 'live-pw' }));
    const pw = await resolveSshPassword('tab-1', 'conn-a', [CONN_A], getPasswordContext);
    expect(pw).toBe('live-pw');
  });

  it('falls back to decrypting the saved password when no live context matches', async () => {
    const connWithSaved: SshConnection = { ...CONN_A, password_encrypted: 'encrypted-blob' };
    const getPasswordContext = vi.fn(() => null);
    invokeMock.mockResolvedValueOnce('decrypted-pw');
    const pw = await resolveSshPassword('tab-1', 'conn-a', [connWithSaved], getPasswordContext);
    expect(invokeMock).toHaveBeenCalledWith('ssh_decrypt_password', { encrypted: 'encrypted-blob' });
    expect(pw).toBe('decrypted-pw');
  });

  it('returns undefined when neither a live context nor a saved password exists', async () => {
    const getPasswordContext = vi.fn(() => null);
    const pw = await resolveSshPassword('tab-1', 'conn-a', [CONN_A], getPasswordContext);
    expect(pw).toBeUndefined();
  });
});

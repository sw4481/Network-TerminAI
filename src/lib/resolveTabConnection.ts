import {
  sshDecryptPassword,
  sshListConnections,
  type SshConnection,
} from './sshConnections';
export type { SshConnection } from './sshConnections';

export async function listSshConnections(): Promise<SshConnection[]> {
  return sshListConnections();
}

/**
 * Match a tab's live SSH session (host/user recorded in sshPasswordStore
 * when a saved connection was used to connect) against the saved-connection
 * list. Best-effort: the live context auto-clears after 5 minutes and is
 * empty for key-only auth, so a null return just means "show a picker."
 */
export function matchConnectionForTab(
  connections: SshConnection[],
  ctx: { host: string; user: string | null } | null,
): SshConnection | null {
  if (!ctx) return null;
  return (
    connections.find(
      (c) => c.host === ctx.host && (ctx.user == null || c.user == null || c.user === ctx.user),
    ) ?? null
  );
}

/**
 * Resolve a password for an SSH target without prompting: prefer the tab's
 * live session password, then a saved+encrypted one. Returns undefined when
 * neither is available (caller must prompt).
 */
export async function resolveSshPassword(
  tabId: string,
  connectionId: string,
  connections: SshConnection[],
  getPasswordContext: (tabId: string) => { host: string; password: string } | null,
): Promise<string | undefined> {
  const ctx = getPasswordContext(tabId);
  const conn = connections.find((c) => c.id === connectionId);
  if (ctx && conn && ctx.host === conn.host) {
    return ctx.password;
  }
  if (conn?.password_encrypted) {
    try {
      const pwd = await sshDecryptPassword(conn.password_encrypted);
      if (pwd) return pwd;
    } catch (e) {
      console.warn('Could not decrypt saved password:', e);
    }
  }
  return undefined;
}

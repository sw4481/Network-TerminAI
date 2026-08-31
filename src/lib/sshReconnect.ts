import { terminalLaunchSavedSsh } from "./tauri";
import { ptyTabIdFor } from "./terminalRegistry";
import {
  buildSshCommand,
  sshDecryptPassword,
  sshGetConnection,
  sshMarkUsed,
} from "./sshConnections";
import { useSshPasswordStore } from "../state/sshPasswordStore";
import { useTerminalConnectionStore } from "../state/terminalConnectionStore";

export async function reconnectSavedSsh(terminalId: string): Promise<boolean> {
  const store = useTerminalConnectionStore.getState();
  const current = store.get(terminalId);
  if (!current || current.lifecycle === "reconnecting" || current.lifecycle === "connecting") {
    return false;
  }
  store.setLifecycle(terminalId, "reconnecting", { exitStatus: null, error: null });

  try {
    const connection = await sshGetConnection(current.connection_id);
    const password = connection.password_encrypted
      ? await sshDecryptPassword(connection.password_encrypted)
      : null;
    const command = buildSshCommand(connection);
    const backendPtyId = ptyTabIdFor(current.terminal_id) ?? current.backend_pty_id;
    const latest = useTerminalConnectionStore.getState().get(terminalId);
    if (!latest || latest.lifecycle !== "reconnecting") return false;

    useTerminalConnectionStore.getState().bind({
      terminalId: current.terminal_id,
      backendPtyId,
      connectionId: connection.id,
      displayName: connection.name,
      vendor: connection.vendor,
      platform: connection.platform,
      accentColor: connection.accent_color,
      syntaxHighlightingEnabled: connection.syntax_highlighting_enabled,
      syntaxProfile: connection.syntax_profile,
      sshCommand: command,
      lifecycle: "reconnecting",
    });
    useSshPasswordStore.getState().clearPasswordContext(backendPtyId);
    if (password) {
      useSshPasswordStore
        .getState()
        .setPasswordContext(backendPtyId, connection.host, connection.user, password);
    }
    await sshMarkUsed(connection.id);
    await terminalLaunchSavedSsh(backendPtyId, connection.id);
    return true;
  } catch (cause) {
    const latest = useTerminalConnectionStore.getState().get(terminalId);
    if (latest) {
      useSshPasswordStore.getState().clearPasswordContext(latest.backend_pty_id);
    }
    const detail = String(cause).toLowerCase();
    const message = detail.includes("not found") || detail.includes("no rows")
      ? "Saved connection no longer exists."
      : "Unable to reconnect. Check the saved connection and try again.";
    useTerminalConnectionStore.getState().setLifecycle(terminalId, "error", {
      exitStatus: null,
      error: message,
    });
    return false;
  }
}

export function useLocalShell(terminalId: string): void {
  const store = useTerminalConnectionStore.getState();
  const connection = store.get(terminalId);
  if (connection) {
    useSshPasswordStore.getState().clearPasswordContext(connection.backend_pty_id);
  }
  store.clear(terminalId);
}

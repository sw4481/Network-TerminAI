import { useTerminalConnectionStore } from "../state/terminalConnectionStore";

export function normalizeTrackedSshCommand(command: string): string {
  return command.replace(/\r/g, "").trim();
}

export function handleSavedSshCommandStart(
  terminalOrBackendId: string,
  command: string,
): boolean {
  const store = useTerminalConnectionStore.getState();
  const connection = store.get(terminalOrBackendId);
  if (!connection) return false;
  if (normalizeTrackedSshCommand(command) !== normalizeTrackedSshCommand(connection.ssh_command)) {
    return false;
  }
  store.setLifecycle(terminalOrBackendId, "connected", { exitStatus: null, error: null });
  return true;
}

export function handleSavedSshCommandEnd(
  terminalOrBackendId: string,
  completedCommand: string | null,
  exitStatus: number | null,
): boolean {
  if (!completedCommand) return false;
  const store = useTerminalConnectionStore.getState();
  const connection = store.get(terminalOrBackendId);
  if (!connection) return false;
  if (
    normalizeTrackedSshCommand(completedCommand) !==
    normalizeTrackedSshCommand(connection.ssh_command)
  ) {
    return false;
  }
  store.setLifecycle(terminalOrBackendId, "disconnected", {
    exitStatus,
    error: null,
  });
  return true;
}

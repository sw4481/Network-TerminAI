import type { SessionSnapshot } from "./tauri";
import { defaultShell } from "./defaultShell";

/** Must match the non-executable provenance marker persisted by the Windows backend. */
export const MANAGED_SSH_SHELL_MARKER = "terminai:managed-ssh-disconnected";

export function isManagedSshTab(shell: string, managed?: boolean): boolean {
  return shell === MANAGED_SSH_SHELL_MARKER || managed === true;
}

export function reopenedTabShell(managed?: boolean): string {
  return managed ? MANAGED_SSH_SHELL_MARKER : defaultShell();
}

export type RestoreTab = {
  id: string;
  title: string;
  shell_cmd: string;
  cwd: string;
  created_at: number;
  replayBytes: number[];
  managed: boolean;
};

export type RestorePlan = {
  tabs: RestoreTab[];
  activeTabId: string | null;
};

/**
 * Pure reducer: turn a saved session snapshot into a restore plan. A tab is a
 * terminal iff it has a non-empty shell_cmd (API/special tabs persist empty
 * shell_cmd). Active id falls back to the first restored terminal when the
 * saved active tab was not a terminal.
 */
export function planRestore(snapshot: SessionSnapshot | null): RestorePlan {
  if (!snapshot || snapshot.tabs.length === 0) {
    return { tabs: [], activeTabId: null };
  }
  const tabs: RestoreTab[] = snapshot.tabs
    .filter((t) => t.shell_cmd.trim() !== "")
    .map((t) => ({
      id: t.id,
      title: t.title,
      shell_cmd: t.shell_cmd,
      cwd: t.cwd,
      created_at: t.created_at,
      replayBytes: t.scrollback,
      // Persisted by the Windows backend as provenance, never as a shell to run.
      managed: t.shell_cmd === MANAGED_SSH_SHELL_MARKER,
    }));
  if (tabs.length === 0) return { tabs: [], activeTabId: null };
  const savedActiveIsTerminal = tabs.some((t) => t.id === snapshot.active_tab_id);
  return {
    tabs,
    activeTabId: savedActiveIsTerminal ? snapshot.active_tab_id : tabs[0].id,
  };
}

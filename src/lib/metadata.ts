import { invoke } from '@tauri-apps/api/core';

export type SshSource = 'chain' | 'process';

export interface GitInfo {
  branch: string;
  dirty: boolean;
  changedCount: number;
  ahead: number;
  behind: number;
}
export interface PortInfo {
  port: number;
  procName: string;
}
export interface SshInfo {
  host: string;
  user: string | null;
  port: number | null;
  source: SshSource;
}
export interface PaneMetadata {
  git: GitInfo | null;
  ports: PortInfo[];
  ssh: SshInfo | null;
  gatheredAt: number;
}

export const getPaneMetadata = (terminalId: string, cwd: string, tabId: string) =>
  invoke<PaneMetadata>('get_pane_metadata', { terminalId, cwd, tabId });

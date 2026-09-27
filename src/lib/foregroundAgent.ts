import { invoke } from '@tauri-apps/api/core';
import { listen, UnlistenFn } from '@tauri-apps/api/event';

export interface ForegroundAgentEvent {
  paneId: string;
  agent: string | null;
}

export function listenForegroundAgent(
  callback: (e: ForegroundAgentEvent) => void,
): Promise<UnlistenFn> {
  return listen<ForegroundAgentEvent>('pane_foreground_agent', (event) => {
    callback(event.payload);
  });
}

export async function getPaneForegroundAgent(paneId: string): Promise<string | null> {
  return invoke('get_pane_foreground_agent', { paneId });
}

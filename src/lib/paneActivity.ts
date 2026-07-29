import { invoke } from '@tauri-apps/api/core';
import { listen, UnlistenFn } from '@tauri-apps/api/event';

export interface CommandState {
  cmd: string;
  startTime: number;
  exitCode: number | null;
  outputPreview: string[];
}

export type NotificationState = 'idle' | 'running' | 'needs_attention';

export interface PaneActivity {
  paneId: string;
  tabId: string;
  activeCommand: CommandState | null;
  cwd: string;
  lastFocusTime: number | null;
  notificationState: NotificationState;
  updatedAt: number;
}

export async function getPaneActivity(paneId: string): Promise<PaneActivity | null> {
  return invoke('get_pane_activity', { paneId });
}

export async function getAllPaneActivities(tabId: string): Promise<PaneActivity[]> {
  return invoke('get_all_pane_activities', { tabId });
}

export async function clearPaneNotification(paneId: string): Promise<void> {
  return invoke('clear_pane_notification', { paneId });
}

export async function setPaneFocus(paneId: string): Promise<void> {
  return invoke('set_pane_focus', { paneId });
}

export function listenPaneActivityUpdated(
  callback: (activity: PaneActivity) => void
): Promise<UnlistenFn> {
  return listen<PaneActivity>('pane_activity_updated', (event) => {
    callback(event.payload);
  });
}

// Agent session types and bindings

export interface AgentSession {
  paneId: string;
  agentType: string;
  startedAt: number;
  lastActivity: number;
  isWaitingForUser: boolean;
}

export interface NotificationPreferences {
  minDurationSecs: number;
  notifyOnNonzeroExit: boolean;
  notifyOnAgentOutput: boolean;
  keywordTriggers: string[];
  ignoreCommands: string[];
  enableSound: boolean;
}

export async function registerAgentSession(paneId: string, agentType: string): Promise<void> {
  return invoke('register_agent_session', { paneId, agentType });
}

export async function unregisterAgentSession(paneId: string): Promise<void> {
  return invoke('unregister_agent_session', { paneId });
}

export async function getActiveAgentSessions(): Promise<AgentSession[]> {
  return invoke('get_active_agent_sessions');
}

export async function updateNotificationPreferences(prefs: NotificationPreferences): Promise<void> {
  return invoke('update_notification_preferences', { prefs });
}

export async function getNotificationPreferences(): Promise<NotificationPreferences> {
  return invoke('get_notification_preferences');
}

export function listenAgentSessionUpdated(callback: () => void): Promise<UnlistenFn> {
  return listen('agent_session_updated', callback);
}

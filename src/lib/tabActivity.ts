import type { PaneActivity } from './paneActivity';

export type TabActivityState = 'needs_attention' | 'running' | null;

/**
 * Aggregate a tab's pane activities into a single dot state using
 * highest-severity-wins: needs_attention > running > idle.
 */
export function tabActivityState(activities: PaneActivity[]): TabActivityState {
  let hasRunning = false;
  for (const a of activities) {
    if (a.notificationState === 'needs_attention') return 'needs_attention';
    if (a.notificationState === 'running') hasRunning = true;
  }
  return hasRunning ? 'running' : null;
}

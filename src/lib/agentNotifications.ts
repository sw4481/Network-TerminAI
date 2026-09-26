import type { PaneActivity } from './paneActivity';
import { listenPaneActivityUpdated } from './paneActivity';

export type AgentNotifierDeps = {
  /** Fire an OS notification for a pane. */
  notify: (paneId: string, title: string, body: string) => void;
  /** Human title of the tab a pane belongs to. */
  resolveTabTitle: (tabId: string) => string;
  /** "Claude" or "Codex" for a pane's agent. */
  agentLabel: (paneId: string) => string;
};

/**
 * Edge-detects the transition INTO `needs_attention` per pane and fires exactly
 * one OS notification on that edge. Mirrors heartbeatStore's Notification usage.
 * Holds last-seen state per pane so a pane sitting in `needs_attention` (repeated
 * updates) never re-notifies.
 */
export class AgentNotifier {
  private lastState = new Map<string, PaneActivity['notificationState']>();

  constructor(private readonly deps: AgentNotifierDeps) {}

  handle(activity: PaneActivity): void {
    const prev = this.lastState.get(activity.paneId);
    const next = activity.notificationState;
    this.lastState.set(activity.paneId, next);
    if (next === 'needs_attention' && prev !== 'needs_attention') {
      const label = this.deps.agentLabel(activity.paneId);
      const title = 'Claude needs your input';
      const body = `${label} is waiting in ${this.deps.resolveTabTitle(activity.tabId)}`;
      this.deps.notify(activity.paneId, title, body);
    }
  }

  async start(): Promise<() => void> {
    return listenPaneActivityUpdated((a) => this.handle(a));
  }
}

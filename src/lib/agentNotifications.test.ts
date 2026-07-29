import { describe, it, expect, vi } from 'vitest';
import { AgentNotifier } from './agentNotifications';
import type { PaneActivity, NotificationState } from './paneActivity';

function activity(paneId: string, state: NotificationState): PaneActivity {
  return {
    paneId,
    tabId: 'tab-' + paneId,
    activeCommand: null,
    cwd: '/tmp',
    lastFocusTime: null,
    notificationState: state,
    updatedAt: 0,
  };
}

function makeNotifier() {
  const notify = vi.fn();
  const n = new AgentNotifier({
    notify,
    resolveTabTitle: () => 'Tab 1',
    agentLabel: () => 'Claude',
  });
  return { n, notify };
}

describe('AgentNotifier', () => {
  it('fires on the edge into needs_attention', () => {
    const { n, notify } = makeNotifier();
    n.handle(activity('p1', 'running'));
    n.handle(activity('p1', 'needs_attention'));
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(
      'p1',
      'Claude needs your input',
      'Claude is waiting in Tab 1',
    );
  });

  it('does not re-fire while staying in needs_attention', () => {
    const { n, notify } = makeNotifier();
    n.handle(activity('p1', 'needs_attention'));
    n.handle(activity('p1', 'needs_attention'));
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('fires again after leaving and re-entering needs_attention', () => {
    const { n, notify } = makeNotifier();
    n.handle(activity('p1', 'needs_attention'));
    n.handle(activity('p1', 'running'));
    n.handle(activity('p1', 'needs_attention'));
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it('tracks panes independently', () => {
    const { n, notify } = makeNotifier();
    n.handle(activity('p1', 'needs_attention'));
    n.handle(activity('p2', 'needs_attention'));
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it('first-ever observation of needs_attention fires (no prior state)', () => {
    const { n, notify } = makeNotifier();
    n.handle(activity('p9', 'needs_attention'));
    expect(notify).toHaveBeenCalledTimes(1);
  });
});

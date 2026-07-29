import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render } from '@testing-library/react';
import { TabBar } from './TabBar';
import { useTabs } from '../state/tabsStore';
import { usePaneActivityStore } from '../state/paneActivityStore';
import type { PaneActivity } from '../lib/paneActivity';

// Stub child stores/components TabBar pulls in but that aren't under test.
vi.mock('../state/recordingStore', () => ({
  useRecordings: (sel: any) => sel({ active: {} }),
}));
vi.mock('./NotificationCenter', () => ({ default: () => null }));

function pa(tabId: string, notificationState: PaneActivity['notificationState']): PaneActivity {
  return { paneId: `${tabId}-p`, tabId, activeCommand: null, cwd: '/', lastFocusTime: null, notificationState, updatedAt: 0 };
}

function setTabs(tabs: any[], activeTabId: string | null) {
  useTabs.setState({ tabs, activeTabId } as any);
}
function setActivities(list: PaneActivity[]) {
  usePaneActivityStore.setState({ activities: new Map(list.map((a) => [a.paneId, a])) } as any);
}

const noop = () => {};

beforeEach(() => {
  setActivities([]);
});

describe('TabBar activity dot', () => {
  it('shows a needs-attention dot on a non-active terminal tab', () => {
    setTabs(
      [{ id: 'tab-1', title: 'one', tab_type: 'terminal' }, { id: 'tab-2', title: 'two', tab_type: 'terminal' }],
      'tab-2',
    );
    setActivities([pa('tab-1', 'needs_attention')]);
    const { container } = render(<TabBar onNew={noop} />);
    expect(container.querySelector('.tab-activity-dot--needs-attention')).toBeTruthy();
  });

  it('shows a running dot on a non-active terminal tab', () => {
    setTabs(
      [{ id: 'tab-1', title: 'one', tab_type: 'terminal' }, { id: 'tab-2', title: 'two', tab_type: 'terminal' }],
      'tab-2',
    );
    setActivities([pa('tab-1', 'running')]);
    const { container } = render(<TabBar onNew={noop} />);
    expect(container.querySelector('.tab-activity-dot--running')).toBeTruthy();
  });

  it('shows NO dot on the active tab even with activity', () => {
    setTabs([{ id: 'tab-1', title: 'one', tab_type: 'terminal' }], 'tab-1');
    setActivities([pa('tab-1', 'needs_attention')]);
    const { container } = render(<TabBar onNew={noop} />);
    expect(container.querySelector('.tab-activity-dot')).toBeNull();
  });

  it('shows NO dot for idle or non-terminal tabs', () => {
    setTabs(
      [{ id: 'tab-1', title: 'idle', tab_type: 'terminal' }, { id: 'tab-2', title: 'api', tab_type: 'api' }],
      'tab-9',
    );
    setActivities([pa('tab-1', 'idle'), pa('tab-2', 'needs_attention')]);
    const { container } = render(<TabBar onNew={noop} />);
    expect(container.querySelector('.tab-activity-dot')).toBeNull();
  });
});

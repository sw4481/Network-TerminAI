import { describe, it, expect, beforeEach } from 'vitest';
import { usePaneActivityStore } from './paneActivityStore';
import type { PaneActivity } from '../lib/paneActivity';

describe('paneActivityStore', () => {
  beforeEach(() => {
    usePaneActivityStore.setState({ activities: new Map() });
  });

  it('updates and retrieves activity', () => {
    const store = usePaneActivityStore.getState();

    const activity: PaneActivity = {
      paneId: 'pane-1',
      tabId: 'tab-1',
      activeCommand: {
        cmd: 'ls -la',
        startTime: Date.now(),
        exitCode: null,
        outputPreview: [],
      },
      cwd: '/home',
      lastFocusTime: null,
      notificationState: 'running',
      updatedAt: Date.now(),
    };

    store.updateActivity(activity);

    const retrieved = store.getActivity('pane-1');
    expect(retrieved).toEqual(activity);
  });

  it('filters activities by tab', () => {
    const store = usePaneActivityStore.getState();

    store.updateActivity({
      paneId: 'pane-1',
      tabId: 'tab-1',
      activeCommand: null,
      cwd: '/home',
      lastFocusTime: null,
      notificationState: 'idle',
      updatedAt: Date.now(),
    });

    store.updateActivity({
      paneId: 'pane-2',
      tabId: 'tab-2',
      activeCommand: null,
      cwd: '/tmp',
      lastFocusTime: null,
      notificationState: 'idle',
      updatedAt: Date.now(),
    });

    const tab1Activities = store.getAllForTab('tab-1');
    expect(tab1Activities).toHaveLength(1);
    expect(tab1Activities[0].paneId).toBe('pane-1');
  });

  it('removes activity', () => {
    const store = usePaneActivityStore.getState();

    store.updateActivity({
      paneId: 'pane-1',
      tabId: 'tab-1',
      activeCommand: null,
      cwd: '/home',
      lastFocusTime: null,
      notificationState: 'idle',
      updatedAt: Date.now(),
    });

    expect(store.getActivity('pane-1')).toBeDefined();

    store.removeActivity('pane-1');

    expect(store.getActivity('pane-1')).toBeUndefined();
  });
});

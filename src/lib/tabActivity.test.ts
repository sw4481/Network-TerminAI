import { describe, it, expect } from 'vitest';
import { tabActivityState } from './tabActivity';
import type { PaneActivity } from './paneActivity';

function pa(notificationState: PaneActivity['notificationState']): PaneActivity {
  return {
    paneId: 'p', tabId: 't', activeCommand: null, cwd: '/',
    lastFocusTime: null, notificationState, updatedAt: 0,
  };
}

describe('tabActivityState', () => {
  it('returns needs_attention when any pane needs attention (highest severity)', () => {
    expect(tabActivityState([pa('idle'), pa('running'), pa('needs_attention')]))
      .toBe('needs_attention');
  });

  it('returns running when a pane runs and none need attention', () => {
    expect(tabActivityState([pa('idle'), pa('running')])).toBe('running');
  });

  it('returns null when all panes idle', () => {
    expect(tabActivityState([pa('idle'), pa('idle')])).toBeNull();
  });

  it('returns null for no tracked panes', () => {
    expect(tabActivityState([])).toBeNull();
  });
});

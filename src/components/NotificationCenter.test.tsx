import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import NotificationCenter from './NotificationCenter';
import { usePaneActivityStore } from '../state/paneActivityStore';

describe('NotificationCenter', () => {
  it('shows count of panes needing attention', () => {
    const activities = new Map([
      ['pane-1', { paneId: 'pane-1', tabId: 'tab-1', notificationState: 'needs_attention', cwd: '/home', activeCommand: null, lastFocusTime: null, updatedAt: 0 }],
      ['pane-2', { paneId: 'pane-2', tabId: 'tab-1', notificationState: 'idle', cwd: '/home', activeCommand: null, lastFocusTime: null, updatedAt: 0 }],
    ]);
    usePaneActivityStore.setState({ activities });

    render(<NotificationCenter />);
    expect(screen.getByText('1')).toBeInTheDocument(); // badge count
  });

  it('opens dropdown on click', () => {
    const activities = new Map([
      ['pane-1', { paneId: 'pane-1', tabId: 'tab-1', notificationState: 'needs_attention', cwd: '/home', activeCommand: { cmd: 'pytest', startTime: 0, exitCode: 1, outputPreview: [] }, lastFocusTime: null, updatedAt: 0 }],
    ]);
    usePaneActivityStore.setState({ activities });

    render(<NotificationCenter />);
    const bell = screen.getByTestId('notification-bell');
    fireEvent.click(bell);

    expect(screen.getByText('pytest')).toBeInTheDocument();
  });
});

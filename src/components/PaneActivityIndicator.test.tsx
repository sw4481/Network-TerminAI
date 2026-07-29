import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PaneActivityIndicator } from './PaneActivityIndicator';
import { usePaneActivityStore } from '../state/paneActivityStore';

describe('PaneActivityIndicator', () => {
  beforeEach(() => {
    usePaneActivityStore.setState({ activities: new Map() });
  });

  it('renders nothing when no activity', () => {
    const { container } = render(<PaneActivityIndicator paneId="pane-1" />);
    expect(container.firstChild).toBeNull();
  });

  it('renders running border for active command', () => {
    usePaneActivityStore.getState().updateActivity({
      paneId: 'pane-1',
      tabId: 'tab-1',
      activeCommand: {
        cmd: 'sleep 60',
        startTime: Date.now() - 10000, // 10s ago
        exitCode: null,
        outputPreview: [],
      },
      cwd: '/home',
      lastFocusTime: null,
      notificationState: 'running',
      updatedAt: Date.now(),
    });

    const { container } = render(<PaneActivityIndicator paneId="pane-1" />);
    const border = container.querySelector('.pane-border-running');
    expect(border).toBeInTheDocument();
  });

  it('renders badge with command and duration', () => {
    usePaneActivityStore.getState().updateActivity({
      paneId: 'pane-1',
      tabId: 'tab-1',
      activeCommand: {
        cmd: 'npm run build',
        startTime: Date.now() - 45000, // 45s ago
        exitCode: null,
        outputPreview: [],
      },
      cwd: '/home',
      lastFocusTime: null,
      notificationState: 'running',
      updatedAt: Date.now(),
    });

    render(<PaneActivityIndicator paneId="pane-1" />);
    expect(screen.getByText('npm run build')).toBeInTheDocument();
    expect(screen.getByText('45s')).toBeInTheDocument();
  });

  it('truncates long command names', () => {
    usePaneActivityStore.getState().updateActivity({
      paneId: 'pane-1',
      tabId: 'tab-1',
      activeCommand: {
        cmd: 'this is a very long command that should be truncated for display',
        startTime: Date.now(),
        exitCode: null,
        outputPreview: [],
      },
      cwd: '/home',
      lastFocusTime: null,
      notificationState: 'running',
      updatedAt: Date.now(),
    });

    render(<PaneActivityIndicator paneId="pane-1" />);
    const badge = screen.getByText(/this is a very long command/);
    expect(badge.textContent).toHaveLength(30); // 27 chars + "..."
  });

  it('shows needs-attention border', () => {
    usePaneActivityStore.getState().updateActivity({
      paneId: 'pane-1',
      tabId: 'tab-1',
      activeCommand: {
        cmd: 'pytest',
        startTime: Date.now() - 60000,
        exitCode: 1,
        outputPreview: ['FAILED tests/test_auth.py::test_login'],
      },
      cwd: '/home',
      lastFocusTime: null,
      notificationState: 'needs_attention',
      updatedAt: Date.now(),
    });

    const { container } = render(<PaneActivityIndicator paneId="pane-1" />);
    const border = container.querySelector('.pane-border-needs-attention');
    expect(border).toBeInTheDocument();
  });
});

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import AgentActivityBadge from './AgentActivityBadge';
import { usePaneActivityStore } from '../state/paneActivityStore';

describe('AgentActivityBadge', () => {
  it('renders nothing when no agent session', () => {
    usePaneActivityStore.setState({ agentSessions: new Map() });
    const { container } = render(<AgentActivityBadge paneId="pane-1" />);
    expect(container.firstChild).toBeNull();
  });

  it('renders blue icon when agent is active', () => {
    const session = {
      paneId: 'pane-1',
      agentType: 'claude-code',
      startedAt: Date.now() / 1000,
      lastActivity: Date.now() / 1000,
      isWaitingForUser: false,
    };
    usePaneActivityStore.setState({ agentSessions: new Map([['pane-1', session]]) });

    render(<AgentActivityBadge paneId="pane-1" />);
    const badge = screen.getByTestId('agent-badge');
    expect(badge).toHaveClass('agent-active');
  });

  it('renders orange icon when agent is waiting', () => {
    const session = {
      paneId: 'pane-1',
      agentType: 'ccie-agent',
      startedAt: Date.now() / 1000,
      lastActivity: Date.now() / 1000,
      isWaitingForUser: true,
    };
    usePaneActivityStore.setState({ agentSessions: new Map([['pane-1', session]]) });

    render(<AgentActivityBadge paneId="pane-1" />);
    const badge = screen.getByTestId('agent-badge');
    expect(badge).toHaveClass('agent-waiting');
  });
});

import React from 'react';
import { usePaneActivityStore } from '../state/paneActivityStore';
import { ptyTabIdFor } from '../lib/terminalRegistry';
import './AgentActivityBadge.css';

interface AgentActivityBadgeProps {
  /** The pane's terminalId; agent sessions are keyed by the spawned PTY id,
   * so resolve terminalId → ptyTabId before lookup (fallback to raw id). */
  paneId: string;
}

const AgentActivityBadge: React.FC<AgentActivityBadgeProps> = ({ paneId }) => {
  const agentSession = usePaneActivityStore((state) =>
    state.getAgentSession(ptyTabIdFor(paneId) ?? paneId),
  );

  if (!agentSession) {
    return null;
  }

  const badgeClass = agentSession.isWaitingForUser ? 'agent-waiting' : 'agent-active';

  return (
    <div
      className={`agent-activity-badge ${badgeClass}`}
      data-testid="agent-badge"
      title={`${agentSession.agentType} - ${agentSession.isWaitingForUser ? 'waiting for input' : 'active'}`}
    >
      <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
        <path d="M8 2L9.5 6H14L10.5 9L12 13L8 10L4 13L5.5 9L2 6H6.5L8 2Z" />
      </svg>
    </div>
  );
};

export default AgentActivityBadge;

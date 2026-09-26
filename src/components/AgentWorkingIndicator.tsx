export function shouldRenderAgentMessage(role: string, content: string): boolean {
  return role !== "assistant" || content.trim().length > 0;
}

export function AgentWorkingIndicator() {
  return (
    <div
      className="agent-streaming"
      role="status"
      aria-live="polite"
      aria-label="Agent is working"
    >
      <span className="streaming-dot" aria-hidden="true"></span>
      <span className="streaming-dot" aria-hidden="true"></span>
      <span className="streaming-dot" aria-hidden="true"></span>
    </div>
  );
}

import { useEffect, useRef, useState } from 'react';
import { useForegroundAgentStore } from '../state/foregroundAgentStore';
import { usePaneActivityStore } from '../state/paneActivityStore';
import { usePanesStore } from '../state/panesStore';
import { useTabs } from '../state/tabsStore';
import { ptyTabIdFor } from '../lib/terminalRegistry';
import { setPaneFocus } from '../lib/paneActivity';
import { getPaneForegroundAgent } from '../lib/foregroundAgent';

/**
 * Warp-style agent toolbelt, rendered as a single pill in the bottom status
 * ribbon (alongside Sidecar / FTP / TFTP). Appears only when the focused pane's
 * foreground process is an agent CLI (claude/codex). Shows live
 * working/waiting/idle from paneActivityStore; clicking opens a popover (same
 * pattern as the FTP/TFTP pills) with Compose (opens the rich-input modal
 * targeting this pane) and Focus (re-asserts backend focus).
 */
export default function AgentToolbelt() {
  const focusedPaneId = usePanesStore((s) => s.focusedPaneId);
  const activeTabId = useTabs((s) => s.activeTabId);
  const byPane = useForegroundAgentStore((s) => s.byPane);
  const activities = usePaneActivityStore((s) => s.activities);
  const [open, setOpen] = useState(false);
  const popoverRef = useRef<HTMLDivElement>(null);

  // Resolve the focused pane → its PTY id (backend keys everything by PTY id).
  // Computed during render, NOT cached in a one-shot effect: the PTY id isn't
  // registered until after the pane's async spawn resolves, so a value captured
  // when focus first changes would be stale (ptyTabIdFor → null → terminalId).
  // Re-deriving each render — the component re-renders when byPane/activities/
  // focus change — means we read the id once the registry has it.
  const tabId = activeTabId;
  const terminalId = tabId
    ? usePanesStore.getState().resolveRecordingTerminalId(tabId)
    : null;
  const ptyId = terminalId ? (ptyTabIdFor(terminalId) ?? terminalId) : null;

  // Hydrate immediately so the pill can appear without waiting for the next
  // ~1.5s foreground poll tick. Runs when the resolved PTY id changes.
  useEffect(() => {
    if (!ptyId) return;
    void getPaneForegroundAgent(ptyId)
      .then((agent) => useForegroundAgentStore.getState().set(ptyId, agent))
      .catch(() => {});
  }, [ptyId, focusedPaneId]);

  // Click-outside to close the popover (mirrors FTP/TFTP pills).
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => {
      if (!popoverRef.current) return;
      if (!popoverRef.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', h);
    return () => window.removeEventListener('mousedown', h);
  }, [open]);

  if (!ptyId) return null;
  const agent = byPane.get(ptyId);
  if (!agent) {
    return null;
  }

  const state = activities.get(ptyId)?.notificationState ?? 'idle';
  const label = agent === 'claude' ? 'Claude' : 'Codex';
  const stateLabel =
    state === 'needs_attention' ? 'waiting' : state === 'running' ? 'working' : 'idle';
  // Map agent state onto the shared status-pill colour classes:
  // working → running (green), waiting → error (red), idle → stopped (grey).
  const pillClass =
    state === 'needs_attention' ? 'error' : state === 'running' ? 'running' : 'stopped';

  return (
    <>
      <button
        type="button"
        className={`status-pill ${pillClass}`}
        onClick={() => setOpen((v) => !v)}
        title={`${label} is ${stateLabel} in the focused pane — click for actions`}
      >
        <span className="status-dot" />
        <span className="status-label">
          {label}: {stateLabel}
        </span>
      </button>

      {open && (
        <div className="status-popover" ref={popoverRef}>
          <div className="status-popover-header">
            <span>{label} · {stateLabel}</span>
          </div>
          <div className="status-popover-body" style={{ display: 'flex', gap: 8, padding: 10 }}>
            <button
              type="button"
              className="start-mini"
              onClick={() => {
                setOpen(false);
                window.dispatchEvent(
                  new CustomEvent('ccie:open-rich-input', { detail: { paneId: ptyId } }),
                );
              }}
            >
              Compose
            </button>
            <button
              type="button"
              className="start-mini"
              onClick={() => {
                setOpen(false);
                void setPaneFocus(ptyId).catch(() => {});
              }}
            >
              Focus
            </button>
          </div>
        </div>
      )}
    </>
  );
}

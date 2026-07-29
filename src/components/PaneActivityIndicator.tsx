import { useEffect, useState } from 'react';
import { usePaneActivityStore } from '../state/paneActivityStore';
import { ptyTabIdFor } from '../lib/terminalRegistry';
import type { PaneActivity } from '../lib/paneActivity';
import '../styles/pane-activity.css';

interface PaneActivityIndicatorProps {
  /** The pane's terminalId (stable). Backend activity is keyed by the spawned
   * PTY id, so resolve terminalId → ptyTabId via the registry before lookup. */
  paneId: string;
}

export function PaneActivityIndicator({ paneId }: PaneActivityIndicatorProps) {
  const [activity, setActivity] = useState<PaneActivity | undefined>();
  const [, setTick] = useState(0);

  useEffect(() => {
    // Resolve terminalId → the PTY id the backend keys activity by. Falls back
    // to the raw id for the legacy path (where terminalId === the PTY id).
    const lookup = (state: { activities: Map<string, PaneActivity> }) => {
      const key = ptyTabIdFor(paneId) ?? paneId;
      return state.activities.get(key);
    };

    setActivity(lookup(usePaneActivityStore.getState()));
    const unsubscribe = usePaneActivityStore.subscribe((state) => {
      setActivity(lookup(state));
    });

    return unsubscribe;
  }, [paneId]);

  // Update duration every second for running commands
  useEffect(() => {
    if (!activity?.activeCommand || activity.activeCommand.exitCode !== null) {
      return;
    }

    const interval = setInterval(() => {
      setTick((t) => t + 1);
    }, 1000);

    return () => clearInterval(interval);
  }, [activity?.activeCommand, activity?.activeCommand?.exitCode]);

  if (!activity) {
    return null;
  }

  const { notificationState, activeCommand } = activity;

  // Calculate duration if command is running
  let duration: string | null = null;
  if (activeCommand && activeCommand.exitCode === null) {
    const elapsed = Math.floor((Date.now() - activeCommand.startTime) / 1000);
    if (elapsed < 60) {
      duration = `${elapsed}s`;
    } else if (elapsed < 3600) {
      duration = `${Math.floor(elapsed / 60)}m`;
    } else {
      duration = `${Math.floor(elapsed / 3600)}h`;
    }
  }

  // Determine class name for border animation
  const borderClass =
    notificationState === 'running'
      ? 'pane-border-running'
      : notificationState === 'needs_attention'
      ? 'pane-border-needs-attention'
      : '';

  // Badge content
  const badgeText = activeCommand
    ? activeCommand.cmd.length > 30
      ? activeCommand.cmd.substring(0, 27) + '...'
      : activeCommand.cmd
    : null;

  const exitIcon = activeCommand?.exitCode === 0 ? '✓' : activeCommand?.exitCode ? '✗' : null;

  return (
    <>
      {/* Animated border overlay */}
      {borderClass && <div className={`pane-border ${borderClass}`} />}

      {/* Badge in top-right corner */}
      {(badgeText || duration) && (
        <div className="pane-badge" title={getTooltipText(activity)}>
          {badgeText && <span className="pane-badge-cmd">{badgeText}</span>}
          {duration && <span className="pane-badge-duration">{duration}</span>}
          {exitIcon && (
            <span
              className={`pane-badge-exit ${
                activeCommand?.exitCode === 0 ? 'success' : 'error'
              }`}
            >
              {exitIcon}
            </span>
          )}
        </div>
      )}
    </>
  );
}

function getTooltipText(activity: PaneActivity): string {
  const { activeCommand, cwd } = activity;
  if (!activeCommand) {
    return `Working directory: ${cwd}`;
  }

  const lines: string[] = [];
  lines.push(`Command: ${activeCommand.cmd}`);

  if (activeCommand.exitCode !== null) {
    lines.push(`Exit code: ${activeCommand.exitCode}`);
  }

  const elapsed = Math.floor((Date.now() - activeCommand.startTime) / 1000);
  lines.push(`Duration: ${elapsed}s`);

  if (activeCommand.outputPreview.length > 0) {
    lines.push('');
    lines.push('Recent output:');
    lines.push(...activeCommand.outputPreview.slice(-5));
  }

  return lines.join('\n');
}

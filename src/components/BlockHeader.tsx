import { memo } from 'react';
import { TagChipStrip } from './TagChipStrip';
import './BlockHeader.css';

interface BlockHeaderProps {
  blockId: string;
  command: string;
  exitCode?: number;
  duration?: number;
  timestamp: number;
  bookmarked: boolean;
  pinned?: boolean;
  collapsed: boolean;
  tags?: string[];
  onToggleCollapse: () => void;
  children?: React.ReactNode;
}

export const BlockHeader = memo(function BlockHeader({
  blockId,
  command,
  exitCode,
  duration,
  timestamp,
  bookmarked,
  pinned,
  collapsed,
  tags,
  onToggleCollapse,
  children,
}: BlockHeaderProps) {
  const formatDuration = (ms: number) => {
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    const mins = Math.floor(ms / 60000);
    const secs = Math.floor((ms % 60000) / 1000);
    return `${mins}m ${secs}s`;
  };

  const formatTimestamp = (ts: number) => {
    const date = new Date(ts);
    return date.toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: true
    });
  };

  const getExitCodeColor = (code?: number) => {
    if (code === undefined) return 'gray';
    return code === 0 ? 'green' : 'red';
  };

  const safeTags = tags ?? [];
  const showRow2 = safeTags.length > 0;

  return (
    <div className="block-header" onClick={onToggleCollapse}>
      <div className="block-header-row1">
        <button
          className={`collapse-btn ${collapsed ? 'collapsed' : ''}`}
          aria-label={collapsed ? 'Expand' : 'Collapse'}
        >
          ▶
        </button>

        <div className="command-text" title={command}>
          {command}
        </div>

        <div className="metadata">
          {duration && (
            <span className="duration">{formatDuration(duration)}</span>
          )}

          {exitCode !== undefined && (
            <span
              className="exit-code"
              style={{ color: `var(--${getExitCodeColor(exitCode)})` }}
            >
              exit {exitCode}
            </span>
          )}

          <span className="timestamp">{formatTimestamp(timestamp)}</span>

          {pinned && <span className="pin-indicator" aria-label="Pinned">📌</span>}
          {bookmarked && <span className="bookmark-indicator">★</span>}
        </div>

        {children}
      </div>

      <div className="block-header-row2" data-empty={showRow2 ? 'false' : 'true'}>
        <TagChipStrip blockId={blockId} tags={safeTags} />
      </div>
    </div>
  );
});

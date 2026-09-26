import { memo, useCallback, useRef, useState } from 'react';
import { SharePopover } from './SharePopover';
import type { Block } from '../state/blocksStore';
import './BlockActions.css';

interface BlockActionsProps {
  block: Block;
  onRerun: () => void;
  onBookmark: () => void;
  onCopy: () => void;
  bookmarked: boolean;
}

export const BlockActions = memo(function BlockActions({
  block,
  onRerun,
  onBookmark,
  onCopy,
  bookmarked,
}: BlockActionsProps) {
  const shareBtnRef = useRef<HTMLButtonElement | null>(null);
  const [shareOpen, setShareOpen] = useState(false);

  const handleClick = (e: React.MouseEvent, action: () => void) => {
    e.stopPropagation(); // Don't trigger collapse
    action();
  };

  const toggleShare = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setShareOpen((s) => !s);
  }, []);

  const closeShare = useCallback(() => setShareOpen(false), []);

  return (
    <div className="block-actions">
      <button
        onClick={(e) => handleClick(e, onRerun)}
        title="Rerun command"
        className="action-btn"
      >
        ↻
      </button>

      <button
        onClick={(e) => handleClick(e, onBookmark)}
        title={bookmarked ? 'Remove bookmark' : 'Bookmark'}
        className={`action-btn ${bookmarked ? 'bookmarked' : ''}`}
      >
        ★
      </button>

      <button
        onClick={(e) => handleClick(e, onCopy)}
        title="Copy output"
        className="action-btn"
      >
        📋
      </button>

      <span className="share-popover-anchor">
        <button
          ref={shareBtnRef}
          onClick={toggleShare}
          title="Share block"
          aria-haspopup="menu"
          aria-expanded={shareOpen}
          className={`action-btn ${shareOpen ? 'active' : ''}`}
        >
          ↗
        </button>
        <SharePopover
          block={block}
          anchorRef={shareBtnRef}
          open={shareOpen}
          onClose={closeShare}
        />
      </span>
    </div>
  );
});

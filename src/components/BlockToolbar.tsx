import { memo } from 'react';
import './BlockToolbar.css';

interface BlockToolbarProps {
  onRerun: () => void;
  onBookmark: () => void;
  onCopy: () => void;
  onExplain: () => void;
  onSearch: () => void;
  onExport: () => void;
  bookmarked: boolean;
  visible: boolean;
}

export const BlockToolbar = memo(function BlockToolbar({
  onRerun,
  onBookmark,
  onCopy,
  onExplain,
  onSearch,
  onExport,
  bookmarked,
  visible,
}: BlockToolbarProps) {
  const handleClick = (e: React.MouseEvent, action: () => void) => {
    e.stopPropagation();
    action();
  };

  return (
    <div className={`block-toolbar ${visible ? '' : 'hidden'}`}>
      <button
        onClick={(e) => handleClick(e, onRerun)}
        title="Rerun command"
        className="toolbar-btn"
      >
        <span className="toolbar-icon">↻</span>
        <span className="toolbar-label">Rerun</span>
      </button>

      <button
        onClick={(e) => handleClick(e, onBookmark)}
        title={bookmarked ? 'Remove bookmark' : 'Bookmark'}
        className={`toolbar-btn ${bookmarked ? 'bookmarked' : ''}`}
      >
        <span className="toolbar-icon">★</span>
        <span className="toolbar-label">Bookmark</span>
      </button>

      <button
        onClick={(e) => handleClick(e, onCopy)}
        title="Copy output"
        className="toolbar-btn"
      >
        <span className="toolbar-icon">📋</span>
        <span className="toolbar-label">Copy</span>
      </button>

      <button
        onClick={(e) => handleClick(e, onExplain)}
        title="Explain command"
        className="toolbar-btn"
      >
        <span className="toolbar-icon">💡</span>
        <span className="toolbar-label">Explain</span>
      </button>

      <button
        onClick={(e) => handleClick(e, onSearch)}
        title="Search in output"
        className="toolbar-btn"
      >
        <span className="toolbar-icon">🔍</span>
        <span className="toolbar-label">Search</span>
      </button>

      <button
        onClick={(e) => handleClick(e, onExport)}
        title="Export block"
        className="toolbar-btn"
      >
        <span className="toolbar-icon">↗</span>
        <span className="toolbar-label">Export</span>
      </button>
    </div>
  );
});

import { useRef, useEffect } from 'react';
import './BlockSearch.css';

type BlockSearchProps = {
  searchQuery: string;
  onSearchChange: (query: string) => void;
  matchCount: number;
  currentMatch: number;
  onNext: () => void;
  onPrev: () => void;
  onClose: () => void;
  inputLabel?: string;
  placeholder?: string;
};

/**
 * Search UI for command block output with match counter and navigation.
 * Supports keyboard shortcuts: Enter (next), Shift+Enter (prev), Esc (close).
 */
export function BlockSearch({
  searchQuery,
  onSearchChange,
  matchCount,
  currentMatch,
  onNext,
  onPrev,
  onClose,
  inputLabel = 'Search in output',
  placeholder = 'Search in output...',
}: BlockSearchProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      onClose();
    } else if (e.key === 'Enter') {
      if (e.shiftKey) {
        onPrev();
      } else {
        onNext();
      }
      e.preventDefault();
    }
  };

  return (
    <div className="block-search">
      <input
        ref={inputRef}
        type="text"
        className="search-input"
        placeholder={placeholder}
        value={searchQuery}
        onChange={(e) => onSearchChange(e.target.value)}
        onKeyDown={handleKeyDown}
        aria-label={inputLabel}
      />
      <div className="search-controls">
        {matchCount > 0 && (
          <span className="match-counter">
            {currentMatch + 1} / {matchCount}
          </span>
        )}
        {matchCount === 0 && searchQuery && (
          <span className="no-matches">No matches</span>
        )}
        <button
          className="search-nav-btn"
          onClick={onPrev}
          disabled={matchCount === 0}
          aria-label="Previous match"
          title="Previous match (Shift+Enter)"
        >
          ↑
        </button>
        <button
          className="search-nav-btn"
          onClick={onNext}
          disabled={matchCount === 0}
          aria-label="Next match"
          title="Next match (Enter)"
        >
          ↓
        </button>
        <button
          className="search-close-btn"
          onClick={onClose}
          aria-label="Close search"
          title="Close search (Esc)"
        >
          ✕
        </button>
      </div>
    </div>
  );
}

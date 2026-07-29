import { memo, useCallback, useEffect, useRef, useState } from 'react';
import type { CommandSuggestion } from '../hooks/useCommandSuggestions';
import './CommandSuggestions.css';

interface CommandSuggestionsProps {
  suggestions: CommandSuggestion[];
  onSelect: (command: string) => void;
  onClose?: () => void;
  visible: boolean;
  selectedIndex?: number;
  loading?: boolean;
}

type Position = { x: number; y: number };

export const CommandSuggestions = memo(function CommandSuggestions({
  suggestions,
  onSelect,
  onClose,
  visible,
  selectedIndex = 0,
  loading = false,
}: CommandSuggestionsProps) {
  // null → use the default CSS position (bottom-center). Once dragged, we pin
  // to explicit viewport coordinates.
  const [position, setPosition] = useState<Position | null>(null);
  const dragState = useRef<{ startX: number; startY: number; originX: number; originY: number } | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const handleDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const rect = panelRef.current?.getBoundingClientRect();
    dragState.current = {
      startX: e.clientX,
      startY: e.clientY,
      originX: position?.x ?? rect?.left ?? 0,
      originY: position?.y ?? rect?.top ?? 0,
    };
  }, [position]);

  useEffect(() => {
    const handleMove = (e: MouseEvent) => {
      if (!dragState.current) return;
      const dx = e.clientX - dragState.current.startX;
      const dy = e.clientY - dragState.current.startY;
      setPosition({
        x: dragState.current.originX + dx,
        y: dragState.current.originY + dy,
      });
    };
    const handleUp = () => {
      dragState.current = null;
    };
    window.addEventListener('mousemove', handleMove);
    window.addEventListener('mouseup', handleUp);
    return () => {
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('mouseup', handleUp);
    };
  }, []);

  if (!visible || (suggestions.length === 0 && !loading)) {
    return null;
  }

  // When pinned, drop the CSS transform/centering and use explicit coords.
  const pinnedStyle = position
    ? { left: position.x, top: position.y, bottom: 'auto', transform: 'none' as const }
    : undefined;

  return (
    <div
      ref={panelRef}
      className="command-suggestions"
      style={pinnedStyle}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="suggestions-drag-handle">
        <span className="drag-dots" onMouseDown={handleDragStart}>⠿</span>
        <span className="drag-label" onMouseDown={handleDragStart}>Suggestions</span>
        {onClose && (
          <button
            className="suggestions-close-btn"
            onClick={(e) => {
              e.stopPropagation();
              e.preventDefault();
              onClose();
            }}
            onMouseDown={(e) => {
              // Prevent drag from starting when clicking close button
              e.stopPropagation();
            }}
            title="Close suggestions (Esc)"
          >
            ✕
          </button>
        )}
      </div>
      {loading ? (
        <div className="suggestion-loading">
          <span className="spinner">⏳</span>
          Loading suggestions...
        </div>
      ) : (
        <ul className="suggestions-list">
          {suggestions.map((suggestion, index) => (
            <li
              key={`${suggestion.command}-${index}`}
              className={`suggestion-item ${index === selectedIndex ? 'selected' : ''}`}
              onClick={(e) => {
                e.stopPropagation(); // Prevent event from bubbling up
                onSelect(suggestion.command);
              }}
            >
              <div className="suggestion-command">{suggestion.command}</div>
              <div className="suggestion-description">{suggestion.description}</div>
              {suggestion.category && (
                <span className={`suggestion-category ${suggestion.category}`}>
                  {suggestion.category}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
});

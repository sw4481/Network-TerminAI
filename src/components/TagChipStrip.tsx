import { memo, useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useBlocksStore } from '../state/blocksStore';
import './TagChipStrip.css';

interface TagChipStripProps {
  blockId: string;
  tags: string[];
  /** When true, the "+ tag" add-affordance is always visible.
   *  Otherwise it only shows on parent .command-block hover/focus. */
  alwaysShowAdd?: boolean;
}

export const TagChipStrip = memo(function TagChipStrip({
  blockId,
  tags,
  alwaysShowAdd = false,
}: TagChipStripProps) {
  const filterTags = useBlocksStore((s) => s.filterTags);
  const setFilterTags = useBlocksStore((s) => s.setFilterTags);
  const addTag = useBlocksStore((s) => s.addTag);
  const removeTag = useBlocksStore((s) => s.removeTag);

  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (adding && inputRef.current) {
      inputRef.current.focus();
    }
  }, [adding]);

  const toggleFilter = useCallback(
    (tag: string) => {
      const next = filterTags.includes(tag)
        ? filterTags.filter((t) => t !== tag)
        : [...filterTags, tag];
      setFilterTags(next);
    },
    [filterTags, setFilterTags],
  );

  const handleRemove = useCallback(
    (e: React.MouseEvent, tag: string) => {
      e.stopPropagation();
      void removeTag(blockId, tag);
    },
    [blockId, removeTag],
  );

  const commitDraft = useCallback(() => {
    const value = draft.trim();
    if (value.length > 0) {
      void addTag(blockId, value);
    }
    setDraft('');
    setAdding(false);
  }, [addTag, blockId, draft]);

  const cancelDraft = useCallback(() => {
    setDraft('');
    setAdding(false);
  }, []);

  const handleInputKey = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        commitDraft();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        cancelDraft();
      } else if (e.key === 'Backspace' && draft.length === 0) {
        e.preventDefault();
        cancelDraft();
      }
    },
    [cancelDraft, commitDraft, draft.length],
  );

  return (
    <div
      className="tag-chip-strip"
      role="list"
      aria-label="Tags"
      data-always-show-add={alwaysShowAdd ? 'true' : 'false'}
      onClick={(e) => e.stopPropagation()}
    >
      {tags.map((tag) => {
        const active = filterTags.includes(tag);
        return (
          <button
            key={tag}
            type="button"
            role="listitem"
            className="tag-chip"
            data-active={active ? 'true' : 'false'}
            onClick={(e) => {
              e.stopPropagation();
              toggleFilter(tag);
            }}
            title={active ? `Click to clear filter: ${tag}` : `Click to filter by: ${tag}`}
          >
            <span className="tag-chip-text">{tag}</span>
            <span
              className="tag-chip-remove"
              aria-label={`Remove tag ${tag}`}
              onClick={(e) => handleRemove(e, tag)}
            >
              ×
            </span>
          </button>
        );
      })}

      {adding ? (
        <input
          ref={inputRef}
          className="tag-chip-input"
          placeholder="tag…"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={handleInputKey}
          onBlur={commitDraft}
          aria-label="Add tag"
        />
      ) : (
        <button
          type="button"
          className="tag-chip-add"
          aria-label="Add tag"
          onClick={(e) => {
            e.stopPropagation();
            setAdding(true);
          }}
        >
          +
        </button>
      )}
    </div>
  );
});

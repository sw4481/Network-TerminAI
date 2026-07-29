import { memo, useCallback, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useBlocksStore } from '../state/blocksStore';
import './TagFilterBar.css';

interface TagFilterBarProps {
  tabId: string;
  /** Optional override; defaults to the deduped union of every tag on every block in tabId. */
  availableTags?: string[];
}

export const TagFilterBar = memo(function TagFilterBar({
  tabId,
  availableTags,
}: TagFilterBarProps) {
  const filterTags = useBlocksStore((s) => s.filterTags);
  const setFilterTags = useBlocksStore((s) => s.setFilterTags);
  const blocksByTab = useBlocksStore((s) => s.blocksByTab);

  const tags = useMemo(() => {
    if (availableTags) {
      return [...new Set(availableTags)].sort();
    }
    const blocks = blocksByTab.get(tabId) ?? [];
    const set = new Set<string>();
    for (const b of blocks) {
      for (const t of b.tags ?? []) set.add(t);
    }
    // Always include any active filter chips, even ones not currently on a block.
    for (const t of filterTags) set.add(t);
    return [...set].sort();
  }, [availableTags, blocksByTab, filterTags, tabId]);

  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLInputElement | null>(null);

  const toggle = useCallback(
    (tag: string) => {
      const next = filterTags.includes(tag)
        ? filterTags.filter((t) => t !== tag)
        : [...filterTags, tag];
      setFilterTags(next);
    },
    [filterTags, setFilterTags],
  );

  const commitDraft = useCallback(() => {
    const value = draft.trim();
    if (value.length > 0 && !filterTags.includes(value)) {
      setFilterTags([...filterTags, value]);
    }
    setDraft('');
    setAdding(false);
  }, [draft, filterTags, setFilterTags]);

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

  const startAdd = useCallback(() => {
    setAdding(true);
    requestAnimationFrame(() => inputRef.current?.focus());
  }, []);

  const clear = useCallback(() => {
    setFilterTags([]);
  }, [setFilterTags]);

  return (
    <div
      className="tag-filter-bar"
      role="region"
      aria-label="Filter blocks by tag"
    >
      <span className="tag-filter-bar-label">FILTER</span>
      <span className="tag-filter-bar-arrow" aria-hidden="true">▸</span>

      <div className="tag-filter-bar-chips">
        {tags.length === 0 && !adding && (
          <span className="tag-filter-bar-empty">no tags yet</span>
        )}
        {tags.map((tag) => {
          const active = filterTags.includes(tag);
          return (
            <button
              key={tag}
              type="button"
              className="tag-chip"
              data-active={active ? 'true' : 'false'}
              onClick={() => toggle(tag)}
              title={
                active ? `Click to clear filter: ${tag}` : `Click to filter by: ${tag}`
              }
            >
              <span className="tag-chip-text">{tag}</span>
            </button>
          );
        })}

        {adding ? (
          <input
            ref={inputRef}
            className="tag-chip-input"
            placeholder="+tag…"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={handleInputKey}
            onBlur={commitDraft}
            aria-label="Add filter tag"
          />
        ) : (
          <button
            type="button"
            className="tag-filter-bar-add"
            aria-label="Add filter tag"
            onClick={startAdd}
          >
            + tag…
          </button>
        )}
      </div>

      {filterTags.length > 0 && (
        <button
          type="button"
          className="tag-filter-bar-clear"
          onClick={clear}
        >
          Clear
        </button>
      )}
    </div>
  );
});

import { memo, useEffect, useMemo, useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useBlocksStore, type Block } from '../state/blocksStore';
import { CommandBlock } from './CommandBlock';
import { PinnedRow } from './PinnedRow';
import { TagFilterBar } from './TagFilterBar';
import './BlockList.css';

interface BlockListProps {
  tabId: string;
  blocks: Block[];
  /** Block id currently keyboard-focused via useBlockShortcuts; the row scrolls
   *  into view and gets a focus ring. */
  focusedBlockId?: string | null;
  onFocusBlock?: (id: string | null) => void;
}

const COLLAPSED_HEIGHT = 44;
const EXPANDED_ESTIMATE = 320;

export const BlockList = memo(function BlockList({
  tabId,
  blocks,
  focusedBlockId,
  onFocusBlock,
}: BlockListProps) {
  const filterTags = useBlocksStore((s) => s.filterTags);

  const filtered = useMemo(() => {
    if (filterTags.length === 0) return blocks;
    // A block matches if it carries every selected filter tag (AND semantics).
    return blocks.filter((b) => {
      const tags = b.tags ?? [];
      return filterTags.every((t) => tags.includes(t));
    });
  }, [blocks, filterTags]);

  const parentRef = useRef<HTMLDivElement | null>(null);

  const virtualizer = useVirtualizer({
    count: filtered.length,
    getScrollElement: () => parentRef.current,
    estimateSize: (index) =>
      filtered[index]?.collapsed ? COLLAPSED_HEIGHT : EXPANDED_ESTIMATE,
    overscan: 4,
    getItemKey: (index) => filtered[index]?.id ?? index,
  });

  const virtualItems = virtualizer.getVirtualItems();
  const totalSize = virtualizer.getTotalSize();

  // Scroll the focused block into view when keyboard navigation moves it.
  useEffect(() => {
    if (!focusedBlockId) return;
    const idx = filtered.findIndex((b) => b.id === focusedBlockId);
    if (idx === -1) return;
    virtualizer.scrollToIndex(idx, { align: 'center' });
  }, [focusedBlockId, filtered, virtualizer]);

  return (
    <div className="block-list" ref={parentRef}>
      <div className="block-list-header">
        <PinnedRow tabId={tabId} />
        <TagFilterBar tabId={tabId} />
      </div>

      {filtered.length === 0 ? (
        <div className="block-list-empty">
          {filterTags.length > 0 ? (
            <p>
              No blocks match{' '}
              <strong>{filterTags.join(' + ')}</strong> — clear the filter to see
              all {blocks.length} blocks.
            </p>
          ) : (
            <>
              <p>Blocks Mode - Command History</p>
              <p className="hint">
                Type a command below and press Enter to execute
              </p>
              <p className="hint">
                ⚠️ Note: Interactive commands (ssh, vim, top) don't work in
                blocks mode. Use Terminal mode instead.
              </p>
            </>
          )}
        </div>
      ) : (
        <div
          className="block-list-virtual"
          style={{
            height: `${totalSize}px`,
            position: 'relative',
            width: '100%',
          }}
        >
          {virtualItems.map((vItem) => {
            const block = filtered[vItem.index];
            const isFocused = block.id === focusedBlockId;
            return (
              <div
                key={vItem.key}
                id={`block-row-${block.id}`}
                ref={virtualizer.measureElement}
                data-index={vItem.index}
                data-focused={isFocused ? 'true' : 'false'}
                className="block-list-row"
                onMouseDown={() => onFocusBlock?.(block.id)}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  transform: `translateY(${vItem.start}px)`,
                }}
              >
                <CommandBlock block={block} active={isFocused} />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
});

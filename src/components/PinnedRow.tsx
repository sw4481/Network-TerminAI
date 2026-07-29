import { memo, useCallback, useMemo, useState } from 'react';
import { useBlocksStore, type Block } from '../state/blocksStore';
import { TagChipStrip } from './TagChipStrip';
import './PinnedRow.css';

interface PinnedRowProps {
  tabId: string;
}

export const PinnedRow = memo(function PinnedRow({ tabId }: PinnedRowProps) {
  const blocksByTab = useBlocksStore((s) => s.blocksByTab);
  const setPinPosition = useBlocksStore((s) => s.setPinPosition);

  const pinned = useMemo<Block[]>(() => {
    const blocks = blocksByTab.get(tabId) ?? [];
    return blocks
      .filter((b) => b.pinned)
      .slice()
      .sort((a, b) => (a.pinPosition ?? 0) - (b.pinPosition ?? 0));
  }, [blocksByTab, tabId]);

  const [dragId, setDragId] = useState<string | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);
  const [reordering, setReordering] = useState(false);

  const handleDragStart = useCallback(
    (e: React.DragEvent<HTMLLIElement>, id: string) => {
      if (reordering) {
        e.preventDefault();
        return;
      }
      setDragId(id);
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', id);
    },
    [reordering],
  );

  const handleDragOver = useCallback(
    (e: React.DragEvent<HTMLLIElement>, id: string) => {
      if (dragId === null || dragId === id) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      setDropTargetId(id);
    },
    [dragId],
  );

  const handleDragLeave = useCallback(() => {
    setDropTargetId(null);
  }, []);

  const handleDrop = useCallback(
    async (e: React.DragEvent<HTMLLIElement>, id: string) => {
      e.preventDefault();
      if (reordering) return;
      const sourceId = dragId ?? e.dataTransfer.getData('text/plain');
      if (!sourceId || sourceId === id) {
        setDragId(null);
        setDropTargetId(null);
        return;
      }

      const order = pinned.map((b) => b.id);
      const fromIdx = order.indexOf(sourceId);
      const toIdx = order.indexOf(id);
      if (fromIdx === -1 || toIdx === -1) {
        setDragId(null);
        setDropTargetId(null);
        return;
      }

      const reordered = order.slice();
      reordered.splice(fromIdx, 1);
      reordered.splice(toIdx, 0, sourceId);

      // Re-number positions densely so future inserts stay deterministic.
      // Sequence the writes so a rapid second drop can't interleave; the
      // pinned array is derived from the store and would otherwise be read
      // mid-update.
      setReordering(true);
      try {
        for (let i = 0; i < reordered.length; i++) {
          await setPinPosition(reordered[i], i);
        }
      } finally {
        setReordering(false);
        setDragId(null);
        setDropTargetId(null);
      }
    },
    [dragId, pinned, reordering, setPinPosition],
  );

  const scrollToBlock = useCallback((id: string) => {
    const el = document.querySelector(`[data-block-id="${id}"]:not([data-pinned-mini])`);
    if (el && 'scrollIntoView' in el) {
      (el as HTMLElement).scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, []);

  if (pinned.length === 0) {
    return null;
  }

  return (
    <aside className="pinned-row" aria-label="Pinned blocks">
      <header className="pinned-row-header">
        <span className="pinned-row-label">PINNED</span>
        <span className="pinned-row-sep">·</span>
        <span className="pinned-row-count">
          {pinned.length} {pinned.length === 1 ? 'block' : 'blocks'}
        </span>
      </header>

      <ol className="pinned-row-list">
        {pinned.map((block) => (
          <li
            key={block.id}
            className="pinned-row-item"
            draggable
            data-block-id={block.id}
            data-pinned-mini="true"
            data-drop-target={dropTargetId === block.id ? 'true' : 'false'}
            onDragStart={(e) => handleDragStart(e, block.id)}
            onDragOver={(e) => handleDragOver(e, block.id)}
            onDragLeave={handleDragLeave}
            onDrop={(e) => handleDrop(e, block.id)}
            onClick={() => scrollToBlock(block.id)}
          >
            <div className="pinned-row-item-row1">
              <span className="pinned-row-glyph" aria-hidden="true">▸</span>
              <span className="pinned-row-cmd" title={block.command}>
                {block.command}
              </span>
              {block.durationMs !== undefined && (
                <span className="pinned-row-duration">
                  {block.durationMs < 1000
                    ? `${block.durationMs}ms`
                    : `${(block.durationMs / 1000).toFixed(1)}s`}
                </span>
              )}
              {block.bookmarked && (
                <span className="pinned-row-bookmark" aria-label="Bookmarked">
                  ★
                </span>
              )}
            </div>
            {(block.tags?.length ?? 0) > 0 && (
              <div className="pinned-row-item-row2">
                <TagChipStrip blockId={block.id} tags={block.tags ?? []} />
              </div>
            )}
          </li>
        ))}
      </ol>
    </aside>
  );
});

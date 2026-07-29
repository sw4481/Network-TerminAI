import { useCallback, useEffect, useRef, useState } from 'react';
import { useHotkeys } from 'react-hotkeys-hook';
import { useBlocksStore, type Block } from '../state/blocksStore';

const CHORD_TIMEOUT_MS = 1500;

interface UseBlockShortcutsOptions {
  tabId: string | null | undefined;
  /** When true (default), shortcuts are wired to the window. */
  enabled?: boolean;
  /** Optional callback fired when a "create share" hotkey resolves. */
  onShareCreated?: (blockId: string, shareId: string) => void;
  /** Optional callback fired when ⌘K T fires — UI can use it to open a tag input. */
  onRequestAddTag?: (blockId: string) => void;
}

interface UseBlockShortcutsResult {
  focusedBlockId: string | null;
  setFocusedBlockId: (id: string | null) => void;
  /** True while we are waiting for the second key in a ⌘K chord. */
  chordPending: boolean;
}

/** Returns the active blocks for the given tab in their visible order. */
function readBlocks(state: ReturnType<typeof useBlocksStore.getState>, tabId: string): Block[] {
  return state.blocksByTab.get(tabId) ?? [];
}

export function useBlockShortcuts({
  tabId,
  enabled = true,
  onShareCreated,
  onRequestAddTag,
}: UseBlockShortcutsOptions): UseBlockShortcutsResult {
  const [focusedBlockId, setFocusedBlockId] = useState<string | null>(null);
  const [chordPending, setChordPending] = useState(false);
  const chordTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearChord = useCallback(() => {
    if (chordTimerRef.current) {
      clearTimeout(chordTimerRef.current);
      chordTimerRef.current = null;
    }
    setChordPending(false);
  }, []);

  // Reset chord on tab change
  useEffect(() => {
    clearChord();
  }, [tabId, clearChord]);

  useEffect(() => {
    return () => {
      if (chordTimerRef.current) {
        clearTimeout(chordTimerRef.current);
        chordTimerRef.current = null;
      }
    };
  }, []);

  const startChord = useCallback(() => {
    setChordPending(true);
    if (chordTimerRef.current) clearTimeout(chordTimerRef.current);
    chordTimerRef.current = setTimeout(() => {
      setChordPending(false);
      chordTimerRef.current = null;
    }, CHORD_TIMEOUT_MS);
  }, []);

  // ⌘↑ / ⌘↓ — jump focus between blocks
  useHotkeys(
    'meta+up',
    (e) => {
      if (!enabled || !tabId) return;
      e.preventDefault();
      const state = useBlocksStore.getState();
      const blocks = readBlocks(state, tabId);
      if (blocks.length === 0) return;
      const idx = blocks.findIndex((b) => b.id === focusedBlockId);
      const nextIdx = idx <= 0 ? 0 : idx - 1;
      setFocusedBlockId(blocks[nextIdx].id);
    },
    { enabled, enableOnFormTags: false },
    [enabled, tabId, focusedBlockId],
  );

  useHotkeys(
    'meta+down',
    (e) => {
      if (!enabled || !tabId) return;
      e.preventDefault();
      const state = useBlocksStore.getState();
      const blocks = readBlocks(state, tabId);
      if (blocks.length === 0) return;
      const idx = blocks.findIndex((b) => b.id === focusedBlockId);
      const nextIdx = idx === -1 || idx >= blocks.length - 1 ? blocks.length - 1 : idx + 1;
      setFocusedBlockId(blocks[nextIdx].id);
    },
    { enabled, enableOnFormTags: false },
    [enabled, tabId, focusedBlockId],
  );

  // ⌘K — start chord
  useHotkeys(
    'meta+k',
    (e) => {
      if (!enabled) return;
      e.preventDefault();
      startChord();
    },
    { enabled, enableOnFormTags: false },
    [enabled, startChord],
  );

  // Chord resolvers — only run when chordPending is true
  useHotkeys(
    'b',
    () => {
      if (!enabled || !chordPending || !focusedBlockId) {
        clearChord();
        return;
      }
      const { toggleCollapse } = useBlocksStore.getState();
      void toggleCollapse(focusedBlockId);
      clearChord();
    },
    { enabled: enabled && chordPending, enableOnFormTags: false },
    [enabled, chordPending, focusedBlockId, clearChord],
  );

  useHotkeys(
    'p',
    () => {
      if (!enabled || !chordPending || !focusedBlockId) {
        clearChord();
        return;
      }
      const { togglePin } = useBlocksStore.getState();
      void togglePin(focusedBlockId);
      clearChord();
    },
    { enabled: enabled && chordPending, enableOnFormTags: false },
    [enabled, chordPending, focusedBlockId, clearChord],
  );

  useHotkeys(
    't',
    () => {
      if (!enabled || !chordPending || !focusedBlockId) {
        clearChord();
        return;
      }
      onRequestAddTag?.(focusedBlockId);
      clearChord();
    },
    { enabled: enabled && chordPending, enableOnFormTags: false },
    [enabled, chordPending, focusedBlockId, clearChord, onRequestAddTag],
  );

  useHotkeys(
    's',
    async () => {
      if (!enabled || !chordPending || !focusedBlockId) {
        clearChord();
        return;
      }
      clearChord();
      try {
        const { createShare } = useBlocksStore.getState();
        const shareId = await createShare(focusedBlockId);
        const url = `ccie-terminal://block/${shareId}`;
        if (typeof navigator !== 'undefined' && navigator.clipboard) {
          await navigator.clipboard.writeText(url);
        }
        onShareCreated?.(focusedBlockId, shareId);
      } catch (err) {
        console.error('Failed to create share:', err);
      }
    },
    { enabled: enabled && chordPending, enableOnFormTags: false },
    [enabled, chordPending, focusedBlockId, clearChord, onShareCreated],
  );

  // Escape clears any pending chord
  useHotkeys(
    'escape',
    () => {
      if (chordPending) clearChord();
    },
    { enabled: enabled && chordPending },
    [enabled, chordPending, clearChord],
  );

  return { focusedBlockId, setFocusedBlockId, chordPending };
}

import { create } from 'zustand';
import { getPaneMetadata, type PaneMetadata } from '../lib/metadata';
import { usePanesStore } from './panesStore';
import { useTabs } from './tabsStore';
import { useIacStateStore } from './iacStateStore';

const DEFAULT_POSITION = { x: window.innerWidth - 320, y: 80 };

interface MetadataStore {
  open: boolean;
  data: PaneMetadata | null;
  loading: boolean;
  error: string | null;
  position: { x: number; y: number };
  toggle: () => void;
  setPosition: (x: number, y: number) => void;
  refresh: () => Promise<void>;
}

export const useMetadataStore = create<MetadataStore>((set) => ({
  open: false,
  data: null,
  loading: false,
  error: null,
  position: DEFAULT_POSITION,

  toggle: () => {
    set((s) => {
      const open = !s.open;
      // Reset to default corner each time it opens (no persistence).
      return open
        ? { open, position: { x: window.innerWidth - 320, y: 80 } }
        : { open };
    });
    // Refresh on open.
    if (useMetadataStore.getState().open) {
      void useMetadataStore.getState().refresh();
    }
  },

  setPosition: (x, y) => set({ position: { x, y } }),

  refresh: async () => {
    // Resolve focused pane context using the real panesStore/tabsStore API.
    const paneId = usePanesStore.getState().focusedPaneId;
    if (!paneId) {
      set({ error: 'No focused pane', data: null, loading: false });
      return;
    }
    const tabId = useTabs.getState().activeTabId ?? '';
    // Focused-pane-aware resolver: returns the focused leaf's terminalId,
    // falling back to the tabId.
    const terminalId = usePanesStore.getState().resolveRecordingTerminalId(tabId);
    // Live cwd is tracked by the shell's OSC 7 sequence in iacStateStore
    // (keyed by terminalId) and mirrored onto the tab in tabsStore. The
    // paneActivityStore is NOT kept live, so prefer the OSC-7-fed sources.
    const cwdByTerminal = useIacStateStore.getState().cwdByTerminal;
    const tabCwd = useTabs.getState().tabs.find((t) => t.id === tabId)?.cwd;
    const cwd =
      cwdByTerminal[terminalId] ??
      cwdByTerminal[tabId] ??
      tabCwd ??
      '/';

    set({ loading: true, error: null });
    try {
      const data = await getPaneMetadata(terminalId, cwd, tabId);
      set({ data, loading: false });
    } catch (e) {
      set({ error: String(e), loading: false });
    }
  },
}));

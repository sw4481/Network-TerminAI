import { create } from "zustand";
import type { BlockViewMode } from "../components/BlockTabStrip";

interface State {
  /** The block currently focused by the user (last hovered/clicked). Used by
   *  the View menu to know which CommandBlock to target. */
  focusedBlockId: string | null;
  /** Per-block view mode. When unset, CommandBlock falls back to "raw". */
  viewModeByBlock: Record<string, BlockViewMode>;
  setFocused: (id: string | null) => void;
  setViewMode: (id: string, mode: BlockViewMode) => void;
}

export const useStructuredView = create<State>((set) => ({
  focusedBlockId: null,
  viewModeByBlock: {},
  setFocused: (id) => set({ focusedBlockId: id }),
  setViewMode: (id, mode) =>
    set((s) => ({ viewModeByBlock: { ...s.viewModeByBlock, [id]: mode } })),
}));

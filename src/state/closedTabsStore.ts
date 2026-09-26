import { create } from "zustand";

export type ClosedTab = {
  id: string;
  title: string;
  cwd: string;
  closedAt: number;
};

const CAP = 25;

type Store = {
  items: ClosedTab[];
  push: (t: ClosedTab) => void;
  popMostRecent: () => ClosedTab | null;
  removeById: (id: string) => void;
};

export const useClosedTabs = create<Store>((set, get) => ({
  items: [],
  push: (t) =>
    set((s) => ({ items: [t, ...s.items.filter((x) => x.id !== t.id)].slice(0, CAP) })),
  popMostRecent: () => {
    const [head, ...rest] = get().items;
    if (!head) return null;
    set({ items: rest });
    return head;
  },
  removeById: (id) => set((s) => ({ items: s.items.filter((x) => x.id !== id) })),
}));

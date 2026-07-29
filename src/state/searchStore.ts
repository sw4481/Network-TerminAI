import { create } from "zustand";
import type { SearchResults } from "../lib/tauri";

type FilterType = "all" | "commands" | "ai" | "skills";

type Store = {
  isOpen: boolean;
  query: string;
  filter: FilterType;
  results: SearchResults | null;
  selectedIndex: number;
  setOpen: (open: boolean) => void;
  setQuery: (query: string) => void;
  setFilter: (filter: FilterType) => void;
  setResults: (results: SearchResults) => void;
  setSelectedIndex: (index: number) => void;
  clearSearch: () => void;
};

export const useSearch = create<Store>((set) => ({
  isOpen: false,
  query: "",
  filter: "all",
  results: null,
  selectedIndex: 0,
  setOpen: (isOpen) => set({ isOpen }),
  setQuery: (query) => set({ query, selectedIndex: 0 }),
  setFilter: (filter) => set({ filter, selectedIndex: 0 }),
  setResults: (results) => set({ results, selectedIndex: 0 }),
  setSelectedIndex: (selectedIndex) => set({ selectedIndex }),
  clearSearch: () =>
    set({ query: "", results: null, selectedIndex: 0, isOpen: false }),
}));

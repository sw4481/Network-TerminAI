export type TerminalSearchResults = {
  resultIndex: number;
  resultCount: number;
};

export type TerminalSearchDisposable = {
  dispose: () => void;
};

export type TerminalSearchOptions = {
  caseSensitive: boolean;
  regex: boolean;
  wholeWord: boolean;
  decorations: {
    matchBackground: string;
    matchBorder: string;
    matchOverviewRuler: string;
    activeMatchBackground: string;
    activeMatchBorder: string;
    activeMatchColor: string;
    activeMatchOverviewRuler: string;
  };
};

export interface TerminalSearchHandle {
  findNext: (query: string, options: TerminalSearchOptions) => boolean;
  findPrevious: (query: string, options: TerminalSearchOptions) => boolean;
  clearDecorations: () => void;
  onDidChangeResults: (
    listener: (results: TerminalSearchResults) => void,
  ) => TerminalSearchDisposable;
  focus: () => void;
}

export const TERMINAL_SEARCH_OPTIONS: TerminalSearchOptions = {
  caseSensitive: false,
  regex: false,
  wholeWord: false,
  decorations: {
    matchBackground: '#5CCFE633',
    matchBorder: '#5CCFE6',
    matchOverviewRuler: '#5CCFE6',
    activeMatchBackground: '#FFD580',
    activeMatchBorder: '#FFFFFF',
    activeMatchColor: '#0F1114',
    activeMatchOverviewRuler: '#FFD580',
  },
};

/** Adapt the pinned xterm search addon without exposing it to React callers. */
export function createTerminalSearchHandle(
  term: any,
  searchAddon: any,
): TerminalSearchHandle {
  return {
    findNext: (query, options) => searchAddon.findNext(query, options),
    findPrevious: (query, options) => searchAddon.findPrevious(query, options),
    clearDecorations: () => searchAddon.clearDecorations(),
    onDidChangeResults: (listener) => searchAddon.onDidChangeResults(listener),
    focus: () => term.focus(),
  };
}

/** Cmd+F on macOS; Ctrl+F on Windows/Linux. */
export function isTerminalSearchShortcut(
  event: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>,
  platform = typeof navigator === 'undefined' ? '' : navigator.platform,
): boolean {
  if (event.key.toLowerCase() !== 'f' || event.altKey || event.shiftKey) return false;
  const isMac = platform.toUpperCase().includes('MAC');
  return isMac
    ? event.metaKey && !event.ctrlKey
    : event.ctrlKey && !event.metaKey;
}

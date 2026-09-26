import { useCallback, useEffect, useState } from 'react';
import {
  TERMINAL_SEARCH_OPTIONS,
  type TerminalSearchHandle,
} from '../lib/terminalSearch';

export function useTerminalBufferSearch(handle: TerminalSearchHandle | null) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [resultIndex, setResultIndex] = useState(0);
  const [resultCount, setResultCount] = useState(0);

  useEffect(() => {
    if (!open || !handle) return;
    const subscription = handle.onDidChangeResults((results) => {
      setResultCount(Math.max(0, results.resultCount));
      setResultIndex(results.resultCount > 0 ? Math.max(0, results.resultIndex) : 0);
    });
    return () => subscription.dispose();
  }, [handle, open]);

  useEffect(() => {
    if (!open || !handle) return;
    if (!query) {
      handle.clearDecorations();
      setResultIndex(0);
      setResultCount(0);
      return;
    }
    handle.findNext(query, TERMINAL_SEARCH_OPTIONS);
  }, [handle, open, query]);

  useEffect(() => () => {
    handle?.clearDecorations();
  }, [handle]);

  const openSearch = useCallback(() => setOpen(true), []);

  const closeSearch = useCallback(() => {
    handle?.clearDecorations();
    setOpen(false);
    setQuery('');
    setResultIndex(0);
    setResultCount(0);
    queueMicrotask(() => handle?.focus());
  }, [handle]);

  const next = useCallback(() => {
    if (handle && query) handle.findNext(query, TERMINAL_SEARCH_OPTIONS);
  }, [handle, query]);

  const previous = useCallback(() => {
    if (handle && query) handle.findPrevious(query, TERMINAL_SEARCH_OPTIONS);
  }, [handle, query]);

  return {
    open,
    query,
    resultIndex,
    resultCount,
    setQuery,
    openSearch,
    closeSearch,
    next,
    previous,
  };
}

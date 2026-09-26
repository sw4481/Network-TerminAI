import { useState, useMemo, useCallback, useEffect } from 'react';

/**
 * Hook for managing search state and navigation within command block output.
 * Provides case-insensitive search with match highlighting and navigation.
 */
export function useOutputSearch(output: string) {
  const [searchQuery, setSearchQuery] = useState('');
  const [currentMatchIndex, setCurrentMatchIndex] = useState(0);

  // Find all match positions using useMemo (case-insensitive)
  const matches = useMemo(() => {
    if (!searchQuery.trim()) return [];
    const regex = new RegExp(escapeRegex(searchQuery), 'gi');
    const found: number[] = [];
    let match;
    while ((match = regex.exec(output)) !== null) {
      found.push(match.index);
    }
    return found;
  }, [output, searchQuery]);

  // Reset currentMatchIndex when matches array changes
  useEffect(() => {
    if (currentMatchIndex >= matches.length) {
      setCurrentMatchIndex(matches.length > 0 ? 0 : 0);
    }
  }, [matches.length, currentMatchIndex]);

  const nextMatch = useCallback(() => {
    if (matches.length === 0) return;
    setCurrentMatchIndex((prev) => (prev + 1) % matches.length);
  }, [matches.length]);

  const prevMatch = useCallback(() => {
    if (matches.length === 0) return;
    setCurrentMatchIndex((prev) => (prev - 1 + matches.length) % matches.length);
  }, [matches.length]);

  const clearSearch = useCallback(() => {
    setSearchQuery('');
    setCurrentMatchIndex(0);
  }, []);

  return {
    searchQuery,
    setSearchQuery,
    matches,
    currentMatchIndex,
    nextMatch,
    prevMatch,
    clearSearch,
  };
}

/**
 * Escapes special regex characters in a string for literal matching.
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * useOutputSearch hook tests - In-block output search functionality
 *
 * Tests search state management, match finding, and navigation.
 */
import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useOutputSearch } from './useOutputSearch';

describe('useOutputSearch', () => {
  it('returns empty matches for empty query', () => {
    const output = 'line 1\nline 2\nline 3';
    const { result } = renderHook(() => useOutputSearch(output));

    expect(result.current.matches).toEqual([]);
    expect(result.current.searchQuery).toBe('');
    expect(result.current.currentMatchIndex).toBe(0);
  });

  it('finds all case-insensitive matches', () => {
    const output = 'Error: failed\nWarning: issue\nerror: another';
    const { result } = renderHook(() => useOutputSearch(output));

    act(() => {
      result.current.setSearchQuery('error');
    });

    expect(result.current.matches).toEqual([0, 29]); // Positions of "Error" and "error"
    expect(result.current.searchQuery).toBe('error');
  });

  it('nextMatch cycles forward with wrap-around', () => {
    const output = 'foo bar foo bar foo';
    const { result } = renderHook(() => useOutputSearch(output));

    act(() => {
      result.current.setSearchQuery('foo');
    });

    expect(result.current.currentMatchIndex).toBe(0);

    act(() => {
      result.current.nextMatch();
    });
    expect(result.current.currentMatchIndex).toBe(1);

    act(() => {
      result.current.nextMatch();
    });
    expect(result.current.currentMatchIndex).toBe(2);

    // Wrap around to first match
    act(() => {
      result.current.nextMatch();
    });
    expect(result.current.currentMatchIndex).toBe(0);
  });

  it('prevMatch cycles backward with wrap-around', () => {
    const output = 'foo bar foo bar foo';
    const { result } = renderHook(() => useOutputSearch(output));

    act(() => {
      result.current.setSearchQuery('foo');
    });

    expect(result.current.currentMatchIndex).toBe(0);

    // Wrap around to last match
    act(() => {
      result.current.prevMatch();
    });
    expect(result.current.currentMatchIndex).toBe(2);

    act(() => {
      result.current.prevMatch();
    });
    expect(result.current.currentMatchIndex).toBe(1);

    act(() => {
      result.current.prevMatch();
    });
    expect(result.current.currentMatchIndex).toBe(0);
  });

  it('clearSearch resets state', () => {
    const output = 'foo bar foo';
    const { result } = renderHook(() => useOutputSearch(output));

    act(() => {
      result.current.setSearchQuery('foo');
    });

    expect(result.current.matches.length).toBeGreaterThan(0);

    act(() => {
      result.current.nextMatch();
    });

    expect(result.current.currentMatchIndex).toBe(1);

    act(() => {
      result.current.clearSearch();
    });

    expect(result.current.searchQuery).toBe('');
    expect(result.current.matches).toEqual([]);
    expect(result.current.currentMatchIndex).toBe(0);
  });

  it('resets currentMatchIndex when search query changes to fewer matches', () => {
    const output = 'error warning error warning error';
    const { result } = renderHook(() => useOutputSearch(output));

    act(() => {
      result.current.setSearchQuery('error');
    });

    // Navigate to match beyond the bounds of the next search
    act(() => {
      result.current.nextMatch();
      result.current.nextMatch(); // Move to index 2 (3rd match)
    });

    expect(result.current.currentMatchIndex).toBe(2);

    act(() => {
      result.current.setSearchQuery('warning'); // Only 2 matches
    });

    // Should reset to 0 since index 2 is out of bounds
    expect(result.current.currentMatchIndex).toBe(0);
  });
});

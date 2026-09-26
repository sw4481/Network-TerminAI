import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  TerminalSearchHandle,
  TerminalSearchResults,
} from '../lib/terminalSearch';
import { useTerminalBufferSearch } from './useTerminalBufferSearch';

describe('useTerminalBufferSearch', () => {
  let listener: ((results: TerminalSearchResults) => void) | null;
  let handle: TerminalSearchHandle;
  const findNext = vi.fn(() => true);
  const findPrevious = vi.fn(() => true);
  const clearDecorations = vi.fn();
  const disposeSubscription = vi.fn();
  const focus = vi.fn();

  beforeEach(() => {
    listener = null;
    findNext.mockClear();
    findPrevious.mockClear();
    clearDecorations.mockClear();
    disposeSubscription.mockClear();
    focus.mockClear();
    handle = {
      findNext,
      findPrevious,
      clearDecorations,
      focus,
      onDidChangeResults: vi.fn((next) => {
        listener = next;
        return { dispose: disposeSubscription };
      }),
    };
  });

  it('searches literally and case-insensitively, tracks results, and navigates', () => {
    const { result } = renderHook(() => useTerminalBufferSearch(handle));

    act(() => result.current.openSearch());
    act(() => result.current.setQuery('Error [42]'));
    expect(findNext).toHaveBeenLastCalledWith(
      'Error [42]',
      expect.objectContaining({ caseSensitive: false, regex: false, wholeWord: false }),
    );

    act(() => listener?.({ resultIndex: 1, resultCount: 3 }));
    expect(result.current.resultIndex).toBe(1);
    expect(result.current.resultCount).toBe(3);

    act(() => result.current.next());
    act(() => result.current.previous());
    expect(findNext).toHaveBeenCalledTimes(2);
    expect(findPrevious).toHaveBeenCalledWith('Error [42]', expect.anything());
  });

  it('clears empty queries and closes with subscription disposal and xterm focus', async () => {
    const { result } = renderHook(() => useTerminalBufferSearch(handle));
    act(() => result.current.openSearch());
    act(() => result.current.setQuery('needle'));
    act(() => result.current.setQuery(''));
    expect(clearDecorations).toHaveBeenCalled();

    act(() => result.current.closeSearch());
    await act(async () => Promise.resolve());
    expect(result.current.open).toBe(false);
    expect(result.current.query).toBe('');
    expect(disposeSubscription).toHaveBeenCalledTimes(1);
    expect(focus).toHaveBeenCalledTimes(1);
  });
});

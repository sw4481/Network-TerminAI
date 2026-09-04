import { describe, expect, it } from 'vitest';

import {
  nextBookmarkLine,
  normalizeBookmarkLines,
  previousBookmarkLine,
  toggleBookmarkLine,
} from './bookmarks';

describe('bookmark line-state helpers', () => {
  it('normalizes bookmark lines to a sorted one-based set', () => {
    expect(normalizeBookmarkLines([4, 1, 4, 0, -2, 9], 5)).toEqual([1, 4]);
  });

  it('removes an existing bookmark line', () => {
    expect(toggleBookmarkLine([1, 4], 4, 5)).toEqual([1]);
  });

  it('adds a missing bookmark line', () => {
    expect(toggleBookmarkLine([1], 3, 5)).toEqual([1, 3]);
  });

  it('finds the next bookmark and wraps at the end', () => {
    expect(nextBookmarkLine([2, 5, 9], 5)).toBe(9);
    expect(nextBookmarkLine([2, 5, 9], 9)).toBe(2);
  });

  it('finds the previous bookmark and wraps at the beginning', () => {
    expect(previousBookmarkLine([2, 5, 9], 2)).toBe(9);
    expect(previousBookmarkLine([2, 5, 9], 5)).toBe(2);
  });

  it('returns null when no bookmarks exist', () => {
    expect(nextBookmarkLine([], 4)).toBeNull();
  });
});

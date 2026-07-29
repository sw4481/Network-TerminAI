import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useBlockHover } from './useBlockHover';

describe('useBlockHover', () => {
  it('should initialize with isHovered = false', () => {
    const { result } = renderHook(() => useBlockHover());
    expect(result.current.isHovered).toBe(false);
  });

  it('should set isHovered to true when handleMouseEnter is called', () => {
    const { result } = renderHook(() => useBlockHover());

    act(() => {
      result.current.handleMouseEnter();
    });

    expect(result.current.isHovered).toBe(true);
  });

  it('should set isHovered to false when handleMouseLeave is called', () => {
    const { result } = renderHook(() => useBlockHover());

    // First set to true
    act(() => {
      result.current.handleMouseEnter();
    });
    expect(result.current.isHovered).toBe(true);

    // Then set back to false
    act(() => {
      result.current.handleMouseLeave();
    });
    expect(result.current.isHovered).toBe(false);
  });
});

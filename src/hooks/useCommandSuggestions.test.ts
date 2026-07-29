import { renderHook, waitFor } from '@testing-library/react';
import { act } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useCommandSuggestions } from './useCommandSuggestions';

// Mock the Tauri invoke function
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

import { invoke } from '@tauri-apps/api/core';
const mockInvoke = invoke as ReturnType<typeof vi.fn>;

describe('useCommandSuggestions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return empty suggestions initially', () => {
    const { result } = renderHook(() => useCommandSuggestions());

    expect(result.current.suggestions).toEqual([]);
    expect(result.current.loading).toBe(false);
  });

  it('should query history immediately and call AI after debounce', async () => {
    // History returns an array; AI returns { suggestions }.
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'get_history_suggestions') {
        return Promise.resolve([
          { command: 'ls -la', description: 'Used 13 times', category: 'history' },
        ]);
      }
      return Promise.resolve({
        suggestions: [
          { command: 'ls -lh', description: 'List with human-readable sizes' },
        ],
      });
    });

    const { result } = renderHook(() => useCommandSuggestions());

    // Type partial command
    act(() => {
      result.current.getSuggestions('ls -');
    });

    // History is queried immediately (no debounce)
    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith('get_history_suggestions', {
        partial: 'ls -',
        limit: 3,
      });
    });

    // AI is called after the debounce delay
    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith('ai_suggest_command', {
        partialCommand: 'ls -',
        cwd: expect.any(String),
      });
    });

    // Both history and (deduped) AI suggestions are merged
    await waitFor(() => {
      expect(result.current.suggestions).toHaveLength(2);
      expect(result.current.suggestions[0].command).toBe('ls -la');
      expect(result.current.suggestions[1].command).toBe('ls -lh');
    });
  });

  it('should cancel previous AI request when new input arrives', async () => {
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'get_history_suggestions') return Promise.resolve([]);
      return Promise.resolve({ suggestions: [] });
    });

    const { result } = renderHook(() => useCommandSuggestions());

    act(() => {
      result.current.getSuggestions('ls');
    });

    // Type more before debounce completes
    act(() => {
      result.current.getSuggestions('ls -');
    });

    // Only one AI call fires (the earlier debounce was cancelled)
    await waitFor(() => {
      const aiCalls = mockInvoke.mock.calls.filter(
        (c) => c[0] === 'ai_suggest_command'
      );
      expect(aiCalls).toHaveLength(1);
      expect(aiCalls[0][1]).toEqual({
        partialCommand: 'ls -',
        cwd: expect.any(String),
      });
    });
  });

  it('should clear suggestions', () => {
    const { result } = renderHook(() => useCommandSuggestions());

    act(() => {
      result.current.clearSuggestions();
    });

    expect(result.current.suggestions).toEqual([]);
  });
});

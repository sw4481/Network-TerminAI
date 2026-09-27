import { renderHook } from '@testing-library/react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useCommandSuggestions } from './useCommandSuggestions';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

import { invoke } from '@tauri-apps/api/core';
const mockInvoke = invoke as ReturnType<typeof vi.fn>;

const PREFERENCES_STORAGE_KEY = 'ccie.commandSuggestionPreferences';

async function flushPromises(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

function setPreferences(
  requireFiveCharactersForAi: boolean,
  waitForTwoSecondsOfInactivity: boolean,
): void {
  window.localStorage.setItem(PREFERENCES_STORAGE_KEY, JSON.stringify({
    requireFiveCharactersForAi,
    waitForTwoSecondsOfInactivity,
  }));
}

describe('useCommandSuggestions', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
    window.localStorage.clear();
  });

  it('should return empty suggestions initially', () => {
    const { result } = renderHook(() => useCommandSuggestions());

    expect(result.current.suggestions).toEqual([]);
    expect(result.current.loading).toBe(false);
  });

  it('queries history with the complete long prefix and waits two seconds for AI by default', async () => {
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'get_history_suggestions') {
        return Promise.resolve([
          {
            command: 'show interfaces status',
            description: 'Used 13 times',
            category: 'history',
          },
        ]);
      }
      return Promise.resolve({
        suggestions: [
          {
            command: 'show interfaces switchport',
            description: 'Show switchport details',
          },
        ],
      });
    });

    const { result } = renderHook(() => useCommandSuggestions('/workspace'));
    const completeInput = 'show interfaces ';

    act(() => {
      result.current.getSuggestions(completeInput);
    });

    expect(mockInvoke).toHaveBeenCalledWith('get_history_suggestions', {
      partial: completeInput,
      limit: 3,
    });

    await flushPromises();
    expect(result.current.suggestions.map((suggestion) => suggestion.category)).toEqual([
      'history',
    ]);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_999);
    });
    expect(mockInvoke.mock.calls.filter((call) => call[0] === 'ai_suggest_command')).toHaveLength(0);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(mockInvoke).toHaveBeenCalledWith('ai_suggest_command', {
      partialCommand: completeInput,
      cwd: '/workspace',
    });

    await flushPromises();
    expect(result.current.suggestions.map((suggestion) => suggestion.command)).toEqual([
      'show interfaces status',
      'show interfaces switchport',
    ]);
  });

  it('restores the two-character AI minimum when the five-character control is off', async () => {
    setPreferences(false, true);
    mockInvoke.mockImplementation((cmd: string) => (
      cmd === 'get_history_suggestions'
        ? Promise.resolve([])
        : Promise.resolve({ suggestions: [] })
    ));

    const { result } = renderHook(() => useCommandSuggestions());
    act(() => result.current.getSuggestions('ls'));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_999);
    });
    expect(mockInvoke.mock.calls.filter((call) => call[0] === 'ai_suggest_command')).toHaveLength(0);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(mockInvoke).toHaveBeenCalledWith('ai_suggest_command', {
      partialCommand: 'ls',
      cwd: '/',
    });
  });

  it('keeps AI gated below five characters while history still runs', async () => {
    mockInvoke.mockImplementation((cmd: string) => (
      cmd === 'get_history_suggestions'
        ? Promise.resolve([
          { command: 'show version', description: 'Used 5 times', category: 'history' },
        ])
        : Promise.resolve({ suggestions: [] })
    ));

    const { result } = renderHook(() => useCommandSuggestions());
    act(() => result.current.getSuggestions('show'));
    await flushPromises();

    expect(result.current.suggestions.map((suggestion) => suggestion.command)).toEqual([
      'show version',
    ]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(mockInvoke.mock.calls.filter((call) => call[0] === 'ai_suggest_command')).toHaveLength(0);
  });

  it('restores the 300 ms AI delay when the inactivity control is off', async () => {
    setPreferences(true, false);
    mockInvoke.mockImplementation((cmd: string) => (
      cmd === 'get_history_suggestions'
        ? Promise.resolve([])
        : Promise.resolve({ suggestions: [] })
    ));

    const { result } = renderHook(() => useCommandSuggestions());
    act(() => result.current.getSuggestions('show ip'));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(299);
    });
    expect(mockInvoke.mock.calls.filter((call) => call[0] === 'ai_suggest_command')).toHaveLength(0);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(mockInvoke).toHaveBeenCalledWith('ai_suggest_command', {
      partialCommand: 'show ip',
      cwd: '/',
    });
  });

  it('does not let an older history response replace newer prefix matches', async () => {
    let resolveOlder!: (value: unknown) => void;
    let resolveNewer!: (value: unknown) => void;
    mockInvoke.mockImplementation((cmd: string, args: { partial?: string }) => {
      if (cmd !== 'get_history_suggestions') {
        return Promise.resolve({ suggestions: [] });
      }
      return new Promise((resolve) => {
        if (args.partial === 'sh') resolveOlder = resolve;
        if (args.partial === 'sho') resolveNewer = resolve;
      });
    });

    const { result } = renderHook(() => useCommandSuggestions());
    act(() => result.current.getSuggestions('sh'));
    act(() => result.current.getSuggestions('sho'));

    await act(async () => {
      resolveNewer([
        { command: 'show version', description: 'Used 5 times', category: 'history' },
      ]);
      await Promise.resolve();
    });
    expect(result.current.suggestions.map((suggestion) => suggestion.command)).toEqual([
      'show version',
    ]);

    await act(async () => {
      resolveOlder([
        { command: 'shutdown', description: 'Used once', category: 'history' },
      ]);
      await Promise.resolve();
    });
    expect(result.current.suggestions.map((suggestion) => suggestion.command)).toEqual([
      'show version',
    ]);
  });

  it('puts history first even when AI resolves before the history lookup', async () => {
    setPreferences(false, false);
    let resolveHistory!: (value: unknown) => void;
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'get_history_suggestions') {
        return new Promise((resolve) => { resolveHistory = resolve; });
      }
      return Promise.resolve({
        suggestions: [
          { command: 'show ip route', description: 'Show the routing table' },
        ],
      });
    });

    const { result } = renderHook(() => useCommandSuggestions());
    act(() => result.current.getSuggestions('show ip'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(result.current.suggestions.map((suggestion) => suggestion.command)).toEqual([
      'show ip route',
    ]);

    await act(async () => {
      resolveHistory([
        {
          command: 'show ip interface brief',
          description: 'Used 9 times',
          category: 'history',
        },
      ]);
      await Promise.resolve();
    });
    expect(result.current.suggestions.map((suggestion) => suggestion.command)).toEqual([
      'show ip interface brief',
      'show ip route',
    ]);
  });

  it('cancels the previous AI timer when new input arrives', async () => {
    setPreferences(false, false);
    mockInvoke.mockImplementation((cmd: string) => (
      cmd === 'get_history_suggestions'
        ? Promise.resolve([])
        : Promise.resolve({ suggestions: [] })
    ));

    const { result } = renderHook(() => useCommandSuggestions());
    act(() => result.current.getSuggestions('ls'));
    act(() => result.current.getSuggestions('ls -'));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    const aiCalls = mockInvoke.mock.calls.filter((call) => call[0] === 'ai_suggest_command');
    expect(aiCalls).toHaveLength(1);
    expect(aiCalls[0][1]).toEqual({ partialCommand: 'ls -', cwd: '/' });
  });

  it('should clear suggestions', async () => {
    let resolveHistory!: (value: unknown) => void;
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'get_history_suggestions') {
        return new Promise((resolve) => { resolveHistory = resolve; });
      }
      return Promise.resolve({ suggestions: [] });
    });

    const { result } = renderHook(() => useCommandSuggestions());
    act(() => result.current.getSuggestions('show'));
    act(() => result.current.clearSuggestions());

    await act(async () => {
      resolveHistory([
        { command: 'show version', description: 'Used 5 times', category: 'history' },
      ]);
      await Promise.resolve();
    });

    expect(result.current.suggestions).toEqual([]);
    expect(result.current.loading).toBe(false);
  });
});

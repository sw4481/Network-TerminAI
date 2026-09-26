import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useCommandSuggestionPreferences } from './useCommandSuggestionPreferences';

export interface CommandSuggestion {
  command: string;
  description: string;
  category?: string;
}

const HISTORY_MIN_CHARS = 2;
const AI_DEFAULT_MIN_CHARS = 5;
const AI_LEGACY_MIN_CHARS = 2;
const AI_INACTIVITY_DELAY_MS = 2_000;
const AI_LEGACY_DELAY_MS = 300;

function mergeSuggestions(
  history: CommandSuggestion[],
  ai: CommandSuggestion[],
): CommandSuggestion[] {
  const seen = new Set(history.map((suggestion) => suggestion.command));
  return [
    ...history,
    ...ai.filter((suggestion) => {
      if (seen.has(suggestion.command)) return false;
      seen.add(suggestion.command);
      return true;
    }),
  ];
}

export function useCommandSuggestions(cwd: string = '/') {
  const [suggestions, setSuggestions] = useState<CommandSuggestion[]>([]);
  const [loading, setLoading] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const requestIdRef = useRef(0);
  const historySuggestionsRef = useRef<CommandSuggestion[]>([]);
  const aiSuggestionsRef = useRef<CommandSuggestion[]>([]);
  const { preferences } = useCommandSuggestionPreferences();

  const cancelPendingAi = useCallback(() => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
  }, []);

  const getSuggestions = useCallback((partialCommand: string) => {
    const requestId = ++requestIdRef.current;
    cancelPendingAi();

    historySuggestionsRef.current = [];
    aiSuggestionsRef.current = [];
    setSuggestions([]);
    setLoading(false);

    const meaningfulLength = partialCommand.trim().length;
    if (meaningfulLength < HISTORY_MIN_CHARS) return;

    // Preserve the complete typed prefix, including meaningful spacing. The
    // trimmed value is used only for the minimum-character gates above/below.
    const partial = partialCommand;

    // History is independent from AI: query it immediately for every prefix
    // from two characters onward, with no upper length limit.
    invoke<CommandSuggestion[]>('get_history_suggestions', { partial, limit: 3 })
      .then((historyResult) => {
        if (requestIdRef.current !== requestId) return;
        historySuggestionsRef.current = Array.isArray(historyResult) ? historyResult : [];
        setSuggestions(mergeSuggestions(
          historySuggestionsRef.current,
          aiSuggestionsRef.current,
        ));
      })
      .catch((error) => {
        if (requestIdRef.current !== requestId) return;
        console.warn('[useCommandSuggestions] History lookup failed:', error);
      });

    const aiMinChars = preferences.requireFiveCharactersForAi
      ? AI_DEFAULT_MIN_CHARS
      : AI_LEGACY_MIN_CHARS;
    if (meaningfulLength < aiMinChars) return;

    const aiDelayMs = preferences.waitForTwoSecondsOfInactivity
      ? AI_INACTIVITY_DELAY_MS
      : AI_LEGACY_DELAY_MS;

    timeoutRef.current = setTimeout(async () => {
      timeoutRef.current = null;
      if (requestIdRef.current !== requestId) return;

      setLoading(true);
      const abortController = new AbortController();
      abortControllerRef.current = abortController;

      try {
        const result = await invoke<{ suggestions: CommandSuggestion[] }>(
          'ai_suggest_command',
          { partialCommand: partial, cwd },
        );

        if (
          requestIdRef.current !== requestId
          || abortController.signal.aborted
        ) return;

        aiSuggestionsRef.current = Array.isArray(result?.suggestions)
          ? result.suggestions
          : [];
        setSuggestions(mergeSuggestions(
          historySuggestionsRef.current,
          aiSuggestionsRef.current,
        ));
      } catch (error) {
        if (
          requestIdRef.current === requestId
          && !abortController.signal.aborted
        ) {
          console.error('[useCommandSuggestions] ❌ AI suggestions failed:', error);
        }
      } finally {
        if (
          requestIdRef.current === requestId
          && !abortController.signal.aborted
        ) {
          setLoading(false);
        }
        if (abortControllerRef.current === abortController) {
          abortControllerRef.current = null;
        }
      }
    }, aiDelayMs);
  }, [
    cancelPendingAi,
    cwd,
    preferences.requireFiveCharactersForAi,
    preferences.waitForTwoSecondsOfInactivity,
  ]);

  const clearSuggestions = useCallback(() => {
    ++requestIdRef.current;
    cancelPendingAi();
    historySuggestionsRef.current = [];
    aiSuggestionsRef.current = [];
    setSuggestions([]);
    setLoading(false);
  }, [cancelPendingAi]);

  useEffect(() => () => {
    ++requestIdRef.current;
    cancelPendingAi();
  }, [cancelPendingAi]);

  return {
    suggestions,
    loading,
    getSuggestions,
    clearSuggestions,
  };
}

import { useState, useCallback, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';

export interface CommandSuggestion {
  command: string;
  description: string;
  category?: string;
}

const DEBOUNCE_MS = 300;
const MIN_CHARS = 2;

export function useCommandSuggestions(cwd: string = '/') {
  const [suggestions, setSuggestions] = useState<CommandSuggestion[]>([]);
  const [loading, setLoading] = useState(false);
  const timeoutRef = useRef<NodeJS.Timeout | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  const getSuggestions = useCallback((partialCommand: string) => {
    // Clear existing timeout
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
    }

    // Cancel any in-flight request
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }

    // Don't suggest for very short input
    if (partialCommand.trim().length < MIN_CHARS) {
      setSuggestions([]);
      return;
    }

    const partial = partialCommand.trim();

    // Step 1: Get instant history matches (no debounce, fire-and-forget so it
    // never delays the debounce timer below).
    invoke<CommandSuggestion[]>('get_history_suggestions', { partial, limit: 3 })
      .then((historyResult) => {
        if (historyResult && historyResult.length > 0) {
          setSuggestions(historyResult);
        }
      })
      .catch((error) => {
        console.warn('[useCommandSuggestions] History lookup failed:', error);
      });

    // Step 2: Debounce the AI call and merge with history
    timeoutRef.current = setTimeout(async () => {
      setLoading(true);

      // Create new AbortController for this request
      const abortController = new AbortController();
      abortControllerRef.current = abortController;

      try {
        const result = await invoke<{ suggestions: CommandSuggestion[] }>(
          'ai_suggest_command',
          { partialCommand: partial, cwd }
        );

        // Only update state if this request wasn't aborted
        if (!abortController.signal.aborted) {
          // Merge AI suggestions with existing history, dedupe by command
          setSuggestions((prev) => {
            const aiSuggestions = result.suggestions || [];
            const seen = new Set(prev.map(s => s.command));
            const newSuggestions = aiSuggestions.filter(s => !seen.has(s.command));
            return [...prev, ...newSuggestions];
          });
        }
      } catch (error) {
        // Don't log errors for aborted requests
        if (!abortController.signal.aborted) {
          console.error('[useCommandSuggestions] ❌ AI suggestions failed:', error);
        }
      } finally {
        if (!abortController.signal.aborted) {
          setLoading(false);
        }
      }
    }, DEBOUNCE_MS);
  }, [cwd]);

  const clearSuggestions = useCallback(() => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
    }
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    setSuggestions([]);
    setLoading(false);
  }, []);

  return {
    suggestions,
    loading,
    getSuggestions,
    clearSuggestions,
  };
}

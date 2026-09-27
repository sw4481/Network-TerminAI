import { useCallback, useEffect, useState } from 'react';

export interface CommandSuggestionPreferences {
  requireFiveCharactersForAi: boolean;
  waitForTwoSecondsOfInactivity: boolean;
}

export const DEFAULT_COMMAND_SUGGESTION_PREFERENCES: CommandSuggestionPreferences = {
  requireFiveCharactersForAi: true,
  waitForTwoSecondsOfInactivity: true,
};

export const COMMAND_SUGGESTION_PREFERENCES_STORAGE_KEY =
  'ccie.commandSuggestionPreferences';

const PREFERENCES_CHANGED_EVENT = 'ccie-command-suggestion-preferences-changed';

function normalizePreferences(value: unknown): CommandSuggestionPreferences {
  const candidate = value && typeof value === 'object'
    ? value as Partial<CommandSuggestionPreferences>
    : {};

  return {
    requireFiveCharactersForAi:
      typeof candidate.requireFiveCharactersForAi === 'boolean'
        ? candidate.requireFiveCharactersForAi
        : DEFAULT_COMMAND_SUGGESTION_PREFERENCES.requireFiveCharactersForAi,
    waitForTwoSecondsOfInactivity:
      typeof candidate.waitForTwoSecondsOfInactivity === 'boolean'
        ? candidate.waitForTwoSecondsOfInactivity
        : DEFAULT_COMMAND_SUGGESTION_PREFERENCES.waitForTwoSecondsOfInactivity,
  };
}

export function readCommandSuggestionPreferences(): CommandSuggestionPreferences {
  if (typeof window === 'undefined') {
    return { ...DEFAULT_COMMAND_SUGGESTION_PREFERENCES };
  }

  try {
    const raw = window.localStorage.getItem(COMMAND_SUGGESTION_PREFERENCES_STORAGE_KEY);
    return raw
      ? normalizePreferences(JSON.parse(raw))
      : { ...DEFAULT_COMMAND_SUGGESTION_PREFERENCES };
  } catch {
    return { ...DEFAULT_COMMAND_SUGGESTION_PREFERENCES };
  }
}

function persistCommandSuggestionPreferences(
  preferences: CommandSuggestionPreferences,
): CommandSuggestionPreferences {
  const normalized = normalizePreferences(preferences);
  if (typeof window === 'undefined') return normalized;

  try {
    window.localStorage.setItem(
      COMMAND_SUGGESTION_PREFERENCES_STORAGE_KEY,
      JSON.stringify(normalized),
    );
  } catch (error) {
    console.warn('Failed to persist command suggestion preferences:', error);
  }

  window.dispatchEvent(new CustomEvent(PREFERENCES_CHANGED_EVENT));
  return normalized;
}

export function useCommandSuggestionPreferences(): {
  preferences: CommandSuggestionPreferences;
  updatePreferences: (updates: Partial<CommandSuggestionPreferences>) => void;
} {
  const [preferences, setPreferences] = useState<CommandSuggestionPreferences>(
    readCommandSuggestionPreferences,
  );

  useEffect(() => {
    const syncPreferences = () => {
      setPreferences(readCommandSuggestionPreferences());
    };
    const handleStorage = (event: StorageEvent) => {
      if (
        event.key === COMMAND_SUGGESTION_PREFERENCES_STORAGE_KEY
        || event.key === null
      ) {
        syncPreferences();
      }
    };

    window.addEventListener(PREFERENCES_CHANGED_EVENT, syncPreferences);
    window.addEventListener('storage', handleStorage);
    return () => {
      window.removeEventListener(PREFERENCES_CHANGED_EVENT, syncPreferences);
      window.removeEventListener('storage', handleStorage);
    };
  }, []);

  const updatePreferences = useCallback(
    (updates: Partial<CommandSuggestionPreferences>) => {
      const next = persistCommandSuggestionPreferences({
        ...readCommandSuggestionPreferences(),
        ...updates,
      });
      setPreferences(next);
    },
    [],
  );

  return { preferences, updatePreferences };
}

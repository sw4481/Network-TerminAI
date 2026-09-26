import { useCallback, useEffect, useState } from "react";

export interface AiChatPreferences {
  streamLlmOutput: boolean;
}

export const DEFAULT_AI_CHAT_PREFERENCES: AiChatPreferences = {
  streamLlmOutput: false,
};

export const AI_CHAT_PREFERENCES_STORAGE_KEY = "ccie.aiChatPreferences.v1";

const PREFERENCES_CHANGED_EVENT = "ccie-ai-chat-preferences-changed";

function normalizePreferences(value: unknown): AiChatPreferences {
  const candidate = value && typeof value === "object"
    ? value as Partial<AiChatPreferences>
    : {};

  return {
    streamLlmOutput:
      typeof candidate.streamLlmOutput === "boolean"
        ? candidate.streamLlmOutput
        : DEFAULT_AI_CHAT_PREFERENCES.streamLlmOutput,
  };
}

export function readAiChatPreferences(): AiChatPreferences {
  if (typeof window === "undefined") {
    return { ...DEFAULT_AI_CHAT_PREFERENCES };
  }

  try {
    const raw = window.localStorage.getItem(AI_CHAT_PREFERENCES_STORAGE_KEY);
    return raw
      ? normalizePreferences(JSON.parse(raw))
      : { ...DEFAULT_AI_CHAT_PREFERENCES };
  } catch {
    return { ...DEFAULT_AI_CHAT_PREFERENCES };
  }
}

function persistAiChatPreferences(preferences: AiChatPreferences): AiChatPreferences {
  const normalized = normalizePreferences(preferences);
  if (typeof window === "undefined") return normalized;

  try {
    window.localStorage.setItem(
      AI_CHAT_PREFERENCES_STORAGE_KEY,
      JSON.stringify(normalized),
    );
  } catch (error) {
    console.warn("Failed to persist AI chat preferences:", error);
  }

  window.dispatchEvent(new CustomEvent(PREFERENCES_CHANGED_EVENT));
  return normalized;
}

export function useAiChatPreferences(): {
  preferences: AiChatPreferences;
  updatePreferences: (updates: Partial<AiChatPreferences>) => void;
} {
  const [preferences, setPreferences] = useState<AiChatPreferences>(
    readAiChatPreferences,
  );

  useEffect(() => {
    const syncPreferences = () => setPreferences(readAiChatPreferences());
    const handleStorage = (event: StorageEvent) => {
      if (event.key === AI_CHAT_PREFERENCES_STORAGE_KEY || event.key === null) {
        syncPreferences();
      }
    };

    window.addEventListener(PREFERENCES_CHANGED_EVENT, syncPreferences);
    window.addEventListener("storage", handleStorage);
    return () => {
      window.removeEventListener(PREFERENCES_CHANGED_EVENT, syncPreferences);
      window.removeEventListener("storage", handleStorage);
    };
  }, []);

  const updatePreferences = useCallback(
    (updates: Partial<AiChatPreferences>) => {
      const next = persistAiChatPreferences({
        ...readAiChatPreferences(),
        ...updates,
      });
      setPreferences(next);
    },
    [],
  );

  return { preferences, updatePreferences };
}

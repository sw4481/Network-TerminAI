import { useCallback, useEffect, useState } from "react";
import {
  DEFAULT_EDITOR_SETTINGS,
  type EditorSettings,
} from "../components/editor/MonacoEditor";

const STORAGE_KEY = "ccie.editorSettings";

function loadInitial(): EditorSettings {
  if (typeof window === "undefined") return DEFAULT_EDITOR_SETTINGS;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_EDITOR_SETTINGS;
    const parsed = JSON.parse(raw) as Partial<EditorSettings>;
    return { ...DEFAULT_EDITOR_SETTINGS, ...parsed };
  } catch {
    return DEFAULT_EDITOR_SETTINGS;
  }
}

export function useEditorSettings(): {
  settings: EditorSettings;
  setSettings: (next: EditorSettings) => void;
  reset: () => void;
} {
  const [settings, setSettingsState] = useState<EditorSettings>(loadInitial);

  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch (err) {
      console.warn("Failed to persist editor settings:", err);
    }
  }, [settings]);

  const setSettings = useCallback(
    (next: EditorSettings) => setSettingsState(next),
    [],
  );

  const reset = useCallback(
    () => setSettingsState(DEFAULT_EDITOR_SETTINGS),
    [],
  );

  return { settings, setSettings, reset };
}

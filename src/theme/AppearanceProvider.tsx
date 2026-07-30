import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type PropsWithChildren,
} from "react";
import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";
import { appearanceSettingsGet, appearanceSettingsSet } from "../lib/tauri";
import { createDefaultAppearanceSettings } from "./defaults";
import type { AppearanceSettingsV1, AppThemeId } from "./types";
import { normalizeAppearanceSettings, parseAppearanceSettings } from "./validation";
import { applyAppearanceSettings } from "../lib/terminalRegistry";

export const APPEARANCE_SETTINGS_CHANGED_EVENT = "appearance-settings-changed";
export const APPEARANCE_THEME_MIRROR_KEY = "ccie.appearance.theme.v1";

type AppearanceContextValue = {
  settings: AppearanceSettingsV1;
  hydrated: boolean;
  error: string | null;
  previewSettings: (settings: AppearanceSettingsV1) => void;
  setSettings: (settings: AppearanceSettingsV1) => Promise<void>;
};

const AppearanceContext = createContext<AppearanceContextValue | undefined>(undefined);

function isAppThemeId(value: string | null): value is AppThemeId {
  return value === "terminai-dark" || value === "slate-grey" || value === "matrix";
}

function mirroredThemeId(): AppThemeId {
  try {
    const mirrored = localStorage.getItem(APPEARANCE_THEME_MIRROR_KEY);
    return isAppThemeId(mirrored) ? mirrored : "terminai-dark";
  } catch {
    return "terminai-dark";
  }
}

function writeThemeMirror(theme: AppThemeId): void {
  try {
    localStorage.setItem(APPEARANCE_THEME_MIRROR_KEY, theme);
  } catch (error) {
    console.warn("Failed to mirror appearance theme:", error);
  }
}

export function applyAppearanceToDocument(settings: AppearanceSettingsV1): void {
  const root = document.documentElement;
  root.dataset.theme = settings.appTheme;
  root.dataset.matrixScanlines = String(settings.effects.matrixScanlines);
  root.dataset.matrixGlow = String(settings.effects.matrixGlow);
  root.dataset.matrixMotion = settings.effects.motion;
}

/** Runs synchronously before the xterm CDN wait loop in main.tsx. */
export function applyMirroredThemeBeforeRender(): AppThemeId {
  const theme = mirroredThemeId();
  applyAppearanceToDocument({ ...createDefaultAppearanceSettings(), appTheme: theme });
  return theme;
}

function initialSettings(): AppearanceSettingsV1 {
  const settings = createDefaultAppearanceSettings();
  settings.appTheme = mirroredThemeId();
  return settings;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function AppearanceProvider({ children }: PropsWithChildren) {
  const [settings, setSettingsState] = useState<AppearanceSettingsV1>(initialSettings);
  const [hydrated, setHydrated] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const applyPreview = useCallback((next: AppearanceSettingsV1) => {
    setSettingsState(next);
    applyAppearanceToDocument(next);
    applyAppearanceSettings(next);
  }, []);

  const applyAuthoritativeSettings = useCallback((next: AppearanceSettingsV1) => {
    applyPreview(next);
    writeThemeMirror(next.appTheme);
  }, [applyPreview]);

  useEffect(() => {
    applyAppearanceToDocument(settings);
  }, [settings]);

  useEffect(() => {
    let disposed = false;
    let unlisten: UnlistenFn | undefined;
    let receivedLiveEvent = false;

    void (async () => {
      try {
        const stopListening = await listen<AppearanceSettingsV1>(
          APPEARANCE_SETTINGS_CHANGED_EVENT,
          (event) => {
            if (disposed) return;
            receivedLiveEvent = true;
            applyAuthoritativeSettings(normalizeAppearanceSettings(event.payload));
            setError(null);
            setHydrated(true);
          },
        );
        if (disposed) stopListening();
        else unlisten = stopListening;
      } catch (listenerError) {
        console.error("Failed to listen for appearance changes:", listenerError);
      }

      try {
        const stored = await appearanceSettingsGet();
        if (!disposed && !receivedLiveEvent) {
          applyAuthoritativeSettings(normalizeAppearanceSettings(stored));
          setError(null);
        }
      } catch (loadError) {
        if (!disposed) {
          applyPreview(createDefaultAppearanceSettings());
          setError(errorMessage(loadError));
        }
      } finally {
        if (!disposed) setHydrated(true);
      }
    })();

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [applyAuthoritativeSettings, applyPreview]);

  const setSettings = useCallback(async (candidate: AppearanceSettingsV1) => {
    const validated = parseAppearanceSettings(candidate);
    if (!validated) {
      const message = "Invalid appearance settings";
      applyPreview(createDefaultAppearanceSettings());
      setError(message);
      return;
    }
    try {
      const stored = await appearanceSettingsSet(validated);
      const normalized = normalizeAppearanceSettings(stored);
      applyAuthoritativeSettings(normalized);
      setError(null);
      await emit(APPEARANCE_SETTINGS_CHANGED_EVENT, normalized);
    } catch (saveError) {
      applyPreview(createDefaultAppearanceSettings());
      setError(errorMessage(saveError));
    }
  }, [applyAuthoritativeSettings, applyPreview]);

  const previewSettings = useCallback((candidate: AppearanceSettingsV1) => {
    const validated = parseAppearanceSettings(candidate);
    if (!validated) {
      setError("Invalid appearance settings");
      return;
    }
    applyPreview(validated);
    setError(null);
  }, [applyPreview]);

  const value = useMemo<AppearanceContextValue>(
    () => ({ settings, hydrated, error, previewSettings, setSettings }),
    [settings, hydrated, error, previewSettings, setSettings],
  );

  return <AppearanceContext.Provider value={value}>{children}</AppearanceContext.Provider>;
}

export function useAppearance(): AppearanceContextValue {
  const value = useContext(AppearanceContext);
  if (!value) throw new Error("useAppearance must be used within AppearanceProvider");
  return value;
}

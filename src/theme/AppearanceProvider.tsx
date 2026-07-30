import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
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
  authoritativeState: "pending" | "ready" | "failed";
  error: string | null;
  previewSettings: (settings: AppearanceSettingsV1) => void;
  setSettings: (settings: AppearanceSettingsV1) => Promise<void>;
  retryAuthoritativeSettings: () => Promise<void>;
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
  const [authoritativeState, setAuthoritativeState] = useState<"pending" | "ready" | "failed">("pending");
  const [error, setError] = useState<string | null>(null);
  const generationRef = useRef(0);

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
            generationRef.current += 1;
            receivedLiveEvent = true;
            applyAuthoritativeSettings(normalizeAppearanceSettings(event.payload));
            setError(null);
            setAuthoritativeState("ready");
            setHydrated(true);
          },
        );
        if (disposed) stopListening();
        else unlisten = stopListening;
      } catch (listenerError) {
        console.error("Failed to listen for appearance changes:", listenerError);
      }

      const requestGeneration = ++generationRef.current;
      try {
        const stored = await appearanceSettingsGet();
        if (!disposed && !receivedLiveEvent && requestGeneration === generationRef.current) {
          applyAuthoritativeSettings(normalizeAppearanceSettings(stored));
          setError(null);
          setAuthoritativeState("ready");
        }
      } catch (loadError) {
        if (!disposed && requestGeneration === generationRef.current) {
          applyPreview(createDefaultAppearanceSettings());
          setError(errorMessage(loadError));
          setAuthoritativeState("failed");
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
      throw new Error(message);
    }
    try {
      const requestGeneration = ++generationRef.current;
      const stored = await appearanceSettingsSet(validated);
      if (requestGeneration !== generationRef.current) return;
      const normalized = normalizeAppearanceSettings(stored);
      applyAuthoritativeSettings(normalized);
      setError(null);
      await emit(APPEARANCE_SETTINGS_CHANGED_EVENT, normalized);
    } catch (saveError) {
      applyPreview(createDefaultAppearanceSettings());
      const message = errorMessage(saveError);
      setError(message);
      throw saveError instanceof Error ? saveError : new Error(message);
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

  const retryAuthoritativeSettings = useCallback(async () => {
    const requestGeneration = ++generationRef.current;
    setAuthoritativeState("pending");
    setError(null);
    try {
      const stored = await appearanceSettingsGet();
      if (requestGeneration !== generationRef.current) return;
      const normalized = normalizeAppearanceSettings(stored);
      applyAuthoritativeSettings(normalized);
      setAuthoritativeState("ready");
    } catch (loadError) {
      if (requestGeneration !== generationRef.current) return;
      applyPreview(createDefaultAppearanceSettings());
      const message = errorMessage(loadError);
      setError(message);
      setAuthoritativeState("failed");
      throw loadError instanceof Error ? loadError : new Error(message);
    } finally {
      setHydrated(true);
    }
  }, [applyAuthoritativeSettings, applyPreview]);

  const value = useMemo<AppearanceContextValue>(
    () => ({ settings, hydrated, authoritativeState, error, previewSettings, setSettings, retryAuthoritativeSettings }),
    [settings, hydrated, authoritativeState, error, previewSettings, setSettings, retryAuthoritativeSettings],
  );

  return <AppearanceContext.Provider value={value}>{children}</AppearanceContext.Provider>;
}

export function useAppearance(): AppearanceContextValue {
  const value = useContext(AppearanceContext);
  if (!value) throw new Error("useAppearance must be used within AppearanceProvider");
  return value;
}

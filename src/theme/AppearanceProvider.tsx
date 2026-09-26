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
import {
  appearanceSettingsGet,
  appearanceSettingsPatch,
  appearanceSettingsSet,
  type AppearanceSettingsPatchRequest,
} from "../lib/tauri";
import { createDefaultAppearanceSettings } from "./defaults";
import type { AppearanceSettingsV1, AppThemeId } from "./types";
import { normalizeAppearanceSettings, parseAppearanceSettings } from "./validation";
import { applyAppearanceSettings } from "../lib/terminalRegistry";

export const APPEARANCE_SETTINGS_CHANGED_EVENT = "appearance-settings-changed";
export const APPEARANCE_THEME_MIRROR_KEY = "ccie.appearance.theme.v1";

export type AppearanceSettingsPatch = Partial<
  Pick<AppearanceSettingsV1, "appTheme" | "editorTheme" | "terminal" | "effects">
>;

type AppearanceAuthorityPayload = AppearanceSettingsV1 & {
  revision?: number;
  sourceId?: string;
};

type AppearanceField = keyof AppearanceSettingsPatch;

type AppearanceContextValue = {
  settings: AppearanceSettingsV1;
  hydrated: boolean;
  authoritativeState: "pending" | "ready" | "failed";
  error: string | null;
  isSaving: boolean;
  previewSettings: (settings: AppearanceSettingsV1) => void;
  saveSettingsPatch: (patch: AppearanceSettingsPatch) => Promise<void>;
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

function authorityRevision(value: unknown): number | null {
  if (typeof value !== "object" || value === null) return null;
  const revision = (value as { revision?: unknown }).revision;
  return typeof revision === "number"
    && Number.isSafeInteger(revision)
    && revision >= 0
    ? revision
    : null;
}

const APPEARANCE_FIELDS: readonly AppearanceField[] = [
  "appTheme",
  "editorTheme",
  "terminal",
  "effects",
];

function fieldChanged(
  field: AppearanceField,
  before: AppearanceSettingsV1,
  after: AppearanceSettingsV1,
): boolean {
  if (field === "appTheme" || field === "editorTheme") {
    return before[field] !== after[field];
  }
  return JSON.stringify(before[field]) !== JSON.stringify(after[field]);
}

function preservePreviewOverlay(
  authority: AppearanceSettingsV1,
  previousAuthority: AppearanceSettingsV1,
  live: AppearanceSettingsV1,
): AppearanceSettingsV1 {
  const merged = { ...authority };
  for (const field of APPEARANCE_FIELDS) {
    if (fieldChanged(field, previousAuthority, live)) {
      Object.assign(merged, { [field]: live[field] });
    }
  }
  return merged;
}

function scopedPatchRequest(
  fields: readonly AppearanceField[],
  settings: AppearanceSettingsV1,
): AppearanceSettingsPatchRequest {
  if (
    fields.length === 2
    && fields.includes("appTheme")
    && fields.includes("effects")
  ) {
    return {
      scope: "application",
      appTheme: settings.appTheme,
      effects: settings.effects,
    };
  }
  if (fields.length === 1 && fields[0] === "editorTheme") {
    return {
      scope: "editor",
      editorTheme: settings.editorTheme,
    };
  }
  if (fields.length === 1 && fields[0] === "terminal") {
    return {
      scope: "terminal",
      terminal: settings.terminal,
    };
  }
  throw new Error("Appearance patch must target exactly one settings scope");
}

export function AppearanceProvider({ children }: PropsWithChildren) {
  const [settings, setSettingsState] = useState<AppearanceSettingsV1>(initialSettings);
  const [hydrated, setHydrated] = useState(false);
  const [authoritativeState, setAuthoritativeState] = useState<"pending" | "ready" | "failed">("pending");
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const liveSettingsRef = useRef(settings);
  const authoritativeSettingsRef = useRef(settings);
  const authorityEpochRef = useRef(0);
  const backendRevisionRef = useRef<number | null>(null);
  const fieldRevisionRef = useRef<Record<AppearanceField, number>>({
    appTheme: 0,
    editorTheme: 0,
    terminal: 0,
    effects: 0,
  });
  const saveLockRef = useRef(false);
  const generationRef = useRef(0);
  const sourceIdRef = useRef(
    globalThis.crypto?.randomUUID?.()
      ?? `appearance:${Math.random().toString(36).slice(2)}`,
  );

  const applyPreview = useCallback((next: AppearanceSettingsV1) => {
    liveSettingsRef.current = next;
    setSettingsState(next);
    applyAppearanceToDocument(next);
    applyAppearanceSettings(next);
  }, []);

  const acceptAuthoritativeSettings = useCallback((value: AppearanceAuthorityPayload) => {
    const revision = authorityRevision(value);
    const currentRevision = backendRevisionRef.current;
    if (
      (revision === null && currentRevision !== null)
      || (revision !== null && currentRevision !== null && revision <= currentRevision)
    ) {
      return null;
    }

    const next = normalizeAppearanceSettings(value);
    const previousAuthority = authoritativeSettingsRef.current;
    const live = liveSettingsRef.current;
    authoritativeSettingsRef.current = next;
    authorityEpochRef.current += 1;
    if (revision !== null) backendRevisionRef.current = revision;
    writeThemeMirror(next.appTheme);
    return { next, previousAuthority, live, revision };
  }, []);

  const applyAuthoritativeSettings = useCallback((value: AppearanceAuthorityPayload) => {
    const accepted = acceptAuthoritativeSettings(value);
    if (!accepted) return false;
    applyPreview(
      preservePreviewOverlay(
        accepted.next,
        accepted.previousAuthority,
        accepted.live,
      ),
    );
    return true;
  }, [acceptAuthoritativeSettings, applyPreview]);

  useEffect(() => {
    applyAppearanceToDocument(settings);
  }, [settings]);

  useEffect(() => {
    let disposed = false;
    let unlisten: UnlistenFn | undefined;
    let receivedLiveEvent = false;

    void (async () => {
      try {
        const stopListening = await listen<AppearanceAuthorityPayload>(
          APPEARANCE_SETTINGS_CHANGED_EVENT,
          (event) => {
            if (disposed) return;
            if (event.payload.sourceId === sourceIdRef.current) return;
            if (!applyAuthoritativeSettings(event.payload)) return;
            generationRef.current += 1;
            receivedLiveEvent = true;
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
        const hasBackendRevision = authorityRevision(stored) !== null;
        if (
          !disposed
          && (
            hasBackendRevision
            || (!receivedLiveEvent && requestGeneration === generationRef.current)
          )
          && applyAuthoritativeSettings(stored)
        ) {
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

  const saveSettingsPatch = useCallback(async (patch: AppearanceSettingsPatch) => {
    if (saveLockRef.current) {
      throw new Error("Appearance settings are already being saved");
    }

    const fields = APPEARANCE_FIELDS.filter((field) => field in patch);
    const authoritativeAtStart = authoritativeSettingsRef.current;
    const candidate = {
      ...authoritativeAtStart,
      ...patch,
      schemaVersion: 1 as const,
    };
    const validated = parseAppearanceSettings(candidate);
    if (!validated) {
      const message = "Invalid appearance settings";
      setError(message);
      throw new Error(message);
    }

    saveLockRef.current = true;
    setIsSaving(true);
    generationRef.current += 1;
    const authorityEpochAtStart = authorityEpochRef.current;
    const fieldRevisionsAtStart = Object.fromEntries(
      fields.map((field) => [field, fieldRevisionRef.current[field]]),
    ) as Partial<Record<AppearanceField, number>>;

    try {
      let stored: AppearanceAuthorityPayload;
      try {
        stored = fields.length === APPEARANCE_FIELDS.length
          ? await appearanceSettingsSet(validated)
          : await appearanceSettingsPatch(scopedPatchRequest(fields, validated));
      } catch (saveError) {
        const message = errorMessage(saveError);
        if (authorityEpochAtStart === authorityEpochRef.current) {
          const restored = { ...liveSettingsRef.current };
          for (const field of fields) {
            if (fieldRevisionRef.current[field] === fieldRevisionsAtStart[field]) {
              Object.assign(restored, { [field]: authoritativeAtStart[field] });
            }
          }
          applyPreview(restored);
          setError(message);
        }
        throw saveError instanceof Error ? saveError : new Error(message);
      }

      if (
        authorityRevision(stored) === null
        && authorityEpochAtStart !== authorityEpochRef.current
      ) {
        return;
      }

      const accepted = acceptAuthoritativeSettings(stored);
      if (!accepted) return;
      const normalized = accepted.next;
      setAuthoritativeState("ready");

      const mergedPreview = { ...normalized };
      for (const field of APPEARANCE_FIELDS) {
        const savedField = fields.includes(field);
        const hasNewerSavedFieldPreview = savedField
          && fieldRevisionRef.current[field] !== fieldRevisionsAtStart[field];
        const hasUnrelatedPreviewOverlay = !savedField
          && fieldChanged(field, accepted.previousAuthority, accepted.live);
        if (hasNewerSavedFieldPreview || hasUnrelatedPreviewOverlay) {
          Object.assign(mergedPreview, { [field]: accepted.live[field] });
        }
      }
      applyPreview(mergedPreview);
      setError(null);

      try {
        await emit(APPEARANCE_SETTINGS_CHANGED_EVENT, {
          ...normalized,
          ...(accepted.revision === null ? {} : { revision: accepted.revision }),
          sourceId: sourceIdRef.current,
        });
      } catch (broadcastError) {
        const message = `Appearance saved, but other windows could not be notified: ${errorMessage(broadcastError)}`;
        console.error(message, broadcastError);
        setError(message);
      }
    } finally {
      saveLockRef.current = false;
      setIsSaving(false);
    }
  }, [acceptAuthoritativeSettings, applyPreview]);

  const setSettings = useCallback(
    async (candidate: AppearanceSettingsV1) => {
      const validated = parseAppearanceSettings(candidate);
      if (!validated) {
        const message = "Invalid appearance settings";
        setError(message);
        throw new Error(message);
      }
      await saveSettingsPatch({
        appTheme: validated.appTheme,
        editorTheme: validated.editorTheme,
        terminal: validated.terminal,
        effects: validated.effects,
      });
    },
    [saveSettingsPatch],
  );

  const previewSettings = useCallback((candidate: AppearanceSettingsV1) => {
    const validated = parseAppearanceSettings(candidate);
    if (!validated) {
      setError("Invalid appearance settings");
      return;
    }
    generationRef.current += 1;
    for (const field of APPEARANCE_FIELDS) {
      if (fieldChanged(field, liveSettingsRef.current, validated)) {
        fieldRevisionRef.current[field] += 1;
      }
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
      const revision = authorityRevision(stored);
      if (revision === null && requestGeneration !== generationRef.current) return;
      if (revision !== null && revision === backendRevisionRef.current) {
        setAuthoritativeState("ready");
        return;
      }
      if (applyAuthoritativeSettings(stored)) setAuthoritativeState("ready");
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
    () => ({
      settings,
      hydrated,
      authoritativeState,
      error,
      isSaving,
      previewSettings,
      saveSettingsPatch,
      setSettings,
      retryAuthoritativeSettings,
    }),
    [
      settings,
      hydrated,
      authoritativeState,
      error,
      isSaving,
      previewSettings,
      saveSettingsPatch,
      setSettings,
      retryAuthoritativeSettings,
    ],
  );

  return <AppearanceContext.Provider value={value}>{children}</AppearanceContext.Provider>;
}

export function useAppearance(): AppearanceContextValue {
  const value = useContext(AppearanceContext);
  if (!value) throw new Error("useAppearance must be used within AppearanceProvider");
  return value;
}

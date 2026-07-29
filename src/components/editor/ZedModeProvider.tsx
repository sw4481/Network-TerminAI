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
import { editorModeGet, editorModeSet, type EditorMode } from "../../lib/tauri";
import {
  INITIAL_ZED_SNAPSHOT_REVISION,
  isNewerZedSnapshotRevision,
  nextZedSnapshotRevision,
  type ZedSnapshotRevision,
} from "./zedSnapshotRevision";

export const ZED_MODE_CHANGED_EVENT = "zed-mode-changed";
export const ZED_VIM_STORAGE_KEY = "ccie.zed.vimEnabled";

export type ZedModeChangedPayload = {
  mode: EditorMode;
  vimEnabled: boolean;
  revision: ZedSnapshotRevision;
};

export type ZedModeContextValue = Pick<
  ZedModeChangedPayload,
  "mode" | "vimEnabled"
> & {
  hydrated: boolean;
  setMode: (mode: EditorMode) => Promise<void>;
  setVimEnabled: (enabled: boolean) => Promise<void>;
};

const ZedModeContext = createContext<ZedModeContextValue | undefined>(
  undefined,
);

function readVimPreference(): boolean {
  try {
    return localStorage.getItem(ZED_VIM_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

function writeVimPreference(enabled: boolean): void {
  try {
    localStorage.setItem(ZED_VIM_STORAGE_KEY, String(enabled));
  } catch (error) {
    console.warn("Failed to persist Vim preference:", error);
  }
}

export function ZedModeProvider({ children }: PropsWithChildren) {
  const [mode, setModeState] = useState<EditorMode>("monaco");
  const [vimEnabled, setVimEnabledState] = useState(readVimPreference);
  const [hydrated, setHydrated] = useState(false);
  const [sourceId] = useState(() => crypto.randomUUID());
  const latestSnapshotRef = useRef<ZedModeChangedPayload>({
    mode,
    vimEnabled,
    revision: INITIAL_ZED_SNAPSHOT_REVISION,
  });

  const applySnapshot = useCallback((payload: ZedModeChangedPayload) => {
    if (
      !isNewerZedSnapshotRevision(
        payload.revision,
        latestSnapshotRef.current.revision,
      )
    ) {
      return false;
    }
    latestSnapshotRef.current = payload;
    setModeState(payload.mode);
    setVimEnabledState(payload.vimEnabled);
    return true;
  }, []);

  useEffect(() => {
    let disposed = false;
    let unlisten: UnlistenFn | undefined;
    let receivedLiveEvent = false;

    void (async () => {
      try {
        const stopListening = await listen<ZedModeChangedPayload>(
          ZED_MODE_CHANGED_EVENT,
          (event) => {
            if (!disposed) {
              const applied = applySnapshot(event.payload);
              if (applied) {
                receivedLiveEvent = true;
                setHydrated(true);
                writeVimPreference(event.payload.vimEnabled);
              }
            }
          },
        );
        if (disposed) {
          stopListening();
        } else {
          unlisten = stopListening;
        }
      } catch (error) {
        console.error("Failed to listen for Zed mode changes:", error);
      }

      try {
        const storedMode = await editorModeGet();
        if (!disposed && !receivedLiveEvent) {
          const hydratedSnapshot = {
            ...latestSnapshotRef.current,
            mode: storedMode,
          };
          latestSnapshotRef.current = hydratedSnapshot;
          setModeState(hydratedSnapshot.mode);
          setVimEnabledState(hydratedSnapshot.vimEnabled);
        }
      } catch (error) {
        console.error("Failed to load editor mode:", error);
      } finally {
        if (!disposed) setHydrated(true);
      }
    })();

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [applySnapshot]);

  useEffect(() => {
    document.body.classList.toggle("zed-mode", mode === "zed");
    return () => document.body.classList.remove("zed-mode");
  }, [mode]);

  const broadcast = useCallback(async (payload: ZedModeChangedPayload) => {
    try {
      await emit(ZED_MODE_CHANGED_EVENT, payload);
    } catch (error) {
      console.error("Failed to broadcast Zed mode change:", error);
    }
  }, []);

  const setMode = useCallback(
    async (nextMode: EditorMode) => {
      await editorModeSet(nextMode);
      const nextSnapshot = {
        ...latestSnapshotRef.current,
        mode: nextMode,
        revision: nextZedSnapshotRevision(
          latestSnapshotRef.current.revision,
          sourceId,
        ),
      } satisfies ZedModeChangedPayload;
      applySnapshot(nextSnapshot);
      await broadcast(nextSnapshot);
    },
    [applySnapshot, broadcast, sourceId],
  );

  const setVimEnabled = useCallback(
    async (enabled: boolean) => {
      const nextSnapshot = {
        ...latestSnapshotRef.current,
        vimEnabled: enabled,
        revision: nextZedSnapshotRevision(
          latestSnapshotRef.current.revision,
          sourceId,
        ),
      } satisfies ZedModeChangedPayload;
      writeVimPreference(enabled);
      applySnapshot(nextSnapshot);
      await broadcast(nextSnapshot);
    },
    [applySnapshot, broadcast, sourceId],
  );

  const value = useMemo<ZedModeContextValue>(
    () => ({ mode, vimEnabled, hydrated, setMode, setVimEnabled }),
    [mode, vimEnabled, hydrated, setMode, setVimEnabled],
  );

  return (
    <ZedModeContext.Provider value={value}>{children}</ZedModeContext.Provider>
  );
}

export function useZedMode(): ZedModeContextValue {
  const value = useContext(ZedModeContext);
  if (!value) {
    throw new Error("useZedMode must be used within ZedModeProvider");
  }
  return value;
}

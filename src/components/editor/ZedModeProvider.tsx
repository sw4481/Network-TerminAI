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
import {
  emit,
  listen,
  type UnlistenFn,
} from "@tauri-apps/api/event";
import {
  editorModeGet,
  editorModeSet,
  type EditorMode,
} from "../../lib/tauri";

export const ZED_MODE_CHANGED_EVENT = "zed-mode-changed";
export const ZED_VIM_STORAGE_KEY = "ccie.zed.vimEnabled";

type ZedModeChangedPayload = {
  mode: EditorMode;
  vimEnabled: boolean;
};

export type ZedModeContextValue = ZedModeChangedPayload & {
  setMode: (mode: EditorMode) => Promise<void>;
  setVimEnabled: (enabled: boolean) => Promise<void>;
};

const ZedModeContext = createContext<ZedModeContextValue | undefined>(undefined);

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
  const latestSnapshotRef = useRef<ZedModeChangedPayload>({
    mode,
    vimEnabled,
  });

  const applySnapshot = useCallback((payload: ZedModeChangedPayload) => {
    latestSnapshotRef.current = payload;
    setModeState(payload.mode);
    setVimEnabledState(payload.vimEnabled);
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
            receivedLiveEvent = true;
            if (!disposed) {
              applySnapshot(event.payload);
              writeVimPreference(event.payload.vimEnabled);
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
          applySnapshot({
            ...latestSnapshotRef.current,
            mode: storedMode,
          });
        }
      } catch (error) {
        console.error("Failed to load editor mode:", error);
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
      } satisfies ZedModeChangedPayload;
      applySnapshot(nextSnapshot);
      await broadcast(nextSnapshot);
    },
    [applySnapshot, broadcast],
  );

  const setVimEnabled = useCallback(
    async (enabled: boolean) => {
      const nextSnapshot = {
        ...latestSnapshotRef.current,
        vimEnabled: enabled,
      } satisfies ZedModeChangedPayload;
      writeVimPreference(enabled);
      applySnapshot(nextSnapshot);
      await broadcast(nextSnapshot);
    },
    [applySnapshot, broadcast],
  );

  const value = useMemo<ZedModeContextValue>(
    () => ({ mode, vimEnabled, setMode, setVimEnabled }),
    [mode, vimEnabled, setMode, setVimEnabled],
  );

  return (
    <ZedModeContext.Provider value={value}>
      {children}
    </ZedModeContext.Provider>
  );
}

export function useZedMode(): ZedModeContextValue {
  const value = useContext(ZedModeContext);
  if (!value) {
    throw new Error("useZedMode must be used within ZedModeProvider");
  }
  return value;
}

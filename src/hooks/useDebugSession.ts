import { useCallback, useEffect, useRef, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  DAP_EVENT,
  dapCheckAvailable,
  dapClearTab,
  dapContinue,
  dapEvaluate,
  dapNext,
  dapPause,
  dapRestart,
  dapScopes,
  dapSessionForTab,
  dapStackTrace,
  dapStart,
  dapStepIn,
  dapStepOut,
  dapStop,
  dapThreads,
  dapVariables,
  type DapEventEnvelope,
  type DapLaunchOptions,
  type DapScope,
  type DapSessionInfo,
  type DapStackFrame,
  type DapThread,
  type DapVariable,
} from "../lib/tauri";

export type DebugSessionStatus =
  | "idle"
  | "starting"
  | "running"
  | "paused"
  | "stopped"
  | "error";

export type DebugScopeState = DapScope & {
  variables: DapVariable[];
  loading: boolean;
  error: string | null;
};

export type DebugWatch = {
  id: string;
  expression: string;
  value: string | null;
  type: string | null;
  variablesReference: number;
  error: string | null;
};

export type DebugOutputEntry = {
  category: string;
  output: string;
};

export const DEBUG_OUTPUT_MAX_ENTRIES = 500;
export const DEBUG_OUTPUT_MAX_CHARS = 100_000;

export function appendBoundedDebugOutput(
  entries: readonly DebugOutputEntry[],
  next: DebugOutputEntry,
): DebugOutputEntry[] {
  const combined = [...entries, next].slice(-DEBUG_OUTPUT_MAX_ENTRIES);
  let total = combined.reduce((sum, entry) => sum + entry.output.length, 0);
  let start = 0;
  while (start < combined.length - 1 && total > DEBUG_OUTPUT_MAX_CHARS) {
    total -= combined[start].output.length;
    start += 1;
  }
  const bounded = combined.slice(start);
  if (
    bounded.length === 1 &&
    bounded[0].output.length > DEBUG_OUTPUT_MAX_CHARS
  ) {
    return [
      {
        ...bounded[0],
        output: bounded[0].output.slice(-DEBUG_OUTPUT_MAX_CHARS),
      },
    ];
  }
  return bounded;
}

function eventBody(
  envelope: DapEventEnvelope,
): Record<string, unknown> {
  return envelope.body ?? {};
}

function bodyNumber(
  body: Record<string, unknown>,
  key: string,
): number | null {
  const value = body[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function newWatchId(): string {
  return `watch:${globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)}`;
}

export type DebugSessionController = {
  status: DebugSessionStatus;
  session: DapSessionInfo | null;
  error: string | null;
  threads: DapThread[];
  selectedThreadId: number | null;
  frames: DapStackFrame[];
  selectedFrameId: number | null;
  scopes: DebugScopeState[];
  watches: DebugWatch[];
  output: DebugOutputEntry[];
  start: (options: DapLaunchOptions) => Promise<boolean>;
  restart: () => Promise<boolean>;
  stop: () => Promise<void>;
  continueExecution: () => Promise<void>;
  pause: () => Promise<void>;
  stepOver: () => Promise<void>;
  stepInto: () => Promise<void>;
  stepOut: () => Promise<void>;
  selectThread: (threadId: number) => Promise<void>;
  selectFrame: (frame: DapStackFrame) => Promise<void>;
  loadVariables: (variablesReference: number) => Promise<DapVariable[]>;
  addWatch: (expression: string) => Promise<void>;
  removeWatch: (watchId: string) => void;
  clearOutput: () => void;
};

export function useDebugSession(
  tabId: string,
  enabled: boolean | null = true,
): DebugSessionController {
  const [status, setStatus] = useState<DebugSessionStatus>("idle");
  const [session, setSession] = useState<DapSessionInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [threads, setThreads] = useState<DapThread[]>([]);
  const [selectedThreadId, setSelectedThreadId] = useState<number | null>(null);
  const [frames, setFrames] = useState<DapStackFrame[]>([]);
  const [selectedFrameId, setSelectedFrameId] = useState<number | null>(null);
  const [scopes, setScopes] = useState<DebugScopeState[]>([]);
  const [watches, setWatches] = useState<DebugWatch[]>([]);
  const [output, setOutput] = useState<DebugOutputEntry[]>([]);

  const sessionRef = useRef<DapSessionInfo | null>(null);
  const activeSessionIdRef = useRef<string | null>(null);
  const selectedThreadRef = useRef<number | null>(null);
  const selectedFrameRef = useRef<number | null>(null);
  const watchesRef = useRef<DebugWatch[]>([]);
  const statusRef = useRef<DebugSessionStatus>("idle");
  const generationRef = useRef(0);
  const lastLaunchRef = useRef<DapLaunchOptions | null>(null);
  const stoppingSessionsRef = useRef(new Set<string>());

  sessionRef.current = session;
  selectedThreadRef.current = selectedThreadId;
  selectedFrameRef.current = selectedFrameId;
  watchesRef.current = watches;
  statusRef.current = status;

  const clearFrameState = useCallback(() => {
    selectedFrameRef.current = null;
    setFrames([]);
    setSelectedFrameId(null);
    setScopes([]);
  }, []);

  const clearPausedState = useCallback(() => {
    selectedThreadRef.current = null;
    setThreads([]);
    setSelectedThreadId(null);
    clearFrameState();
  }, [clearFrameState]);

  const fail = useCallback((cause: unknown) => {
    const message = cause instanceof Error ? cause.message : String(cause);
    setError(message);
    setStatus("error");
  }, []);

  const stopBackend = useCallback(async (sessionId: string) => {
    if (stoppingSessionsRef.current.has(sessionId)) return;
    stoppingSessionsRef.current.add(sessionId);
    try {
      await dapStop(sessionId);
    } finally {
      stoppingSessionsRef.current.delete(sessionId);
    }
  }, []);

  const evaluateWatch = useCallback(
    async (
      currentSessionId: string,
      watch: DebugWatch,
      frameId: number | null,
      generation: number,
    ): Promise<DebugWatch> => {
      try {
        const evaluated = await dapEvaluate(
          currentSessionId,
          watch.expression,
          frameId,
        );
        if (generation !== generationRef.current) return watch;
        return {
          ...watch,
          value: evaluated.result,
          type: evaluated.type ?? null,
          variablesReference: evaluated.variablesReference,
          error: null,
        };
      } catch (watchError) {
        return {
          ...watch,
          value: null,
          type: null,
          variablesReference: 0,
          error: String(watchError),
        };
      }
    },
    [],
  );

  const refreshWatches = useCallback(
    async (
      currentSessionId: string,
      frameId: number | null,
      generation: number,
    ) => {
      const evaluated = await Promise.all(
        watchesRef.current.map((watch) =>
          evaluateWatch(currentSessionId, watch, frameId, generation),
        ),
      );
      if (
        generation !== generationRef.current ||
        activeSessionIdRef.current !== currentSessionId
      ) {
        return;
      }
      watchesRef.current = evaluated;
      setWatches(evaluated);
    },
    [evaluateWatch],
  );

  const hydrateFrame = useCallback(
    async (
      currentSessionId: string,
      frame: DapStackFrame,
      generation: number,
    ) => {
      const response = await dapScopes(currentSessionId, frame.id);
      if (
        generation !== generationRef.current ||
        activeSessionIdRef.current !== currentSessionId
      ) {
        return;
      }
      const initial = response.scopes.map<DebugScopeState>((scope) => ({
        ...scope,
        variables: [],
        loading: scope.variablesReference > 0,
        error: null,
      }));
      setScopes(initial);
      const hydrated = await Promise.all(
        initial.map(async (scope): Promise<DebugScopeState> => {
          if (scope.variablesReference <= 0) {
            return { ...scope, loading: false };
          }
          try {
            const variables = await dapVariables(
              currentSessionId,
              scope.variablesReference,
            );
            return {
              ...scope,
              variables: variables.variables,
              loading: false,
            };
          } catch (scopeError) {
            return {
              ...scope,
              variables: [],
              loading: false,
              error: String(scopeError),
            };
          }
        }),
      );
      if (
        generation === generationRef.current &&
        activeSessionIdRef.current === currentSessionId &&
        selectedFrameRef.current === frame.id
      ) {
        setScopes(hydrated);
      }
      await refreshWatches(currentSessionId, frame.id, generation);
    },
    [refreshWatches],
  );

  const refreshPaused = useCallback(
    async (currentSessionId: string, preferredThreadId: number | null) => {
      const generation = generationRef.current;
      try {
        const threadResponse = await dapThreads(currentSessionId);
        if (
          generation !== generationRef.current ||
          activeSessionIdRef.current !== currentSessionId
        ) {
          return;
        }
        setThreads(threadResponse.threads);
        const thread =
          threadResponse.threads.find(
            (candidate) => candidate.id === preferredThreadId,
          ) ?? threadResponse.threads[0];
        if (!thread) {
          clearPausedState();
          return;
        }
        selectedThreadRef.current = thread.id;
        setSelectedThreadId(thread.id);
        const stack = await dapStackTrace(currentSessionId, thread.id);
        if (
          generation !== generationRef.current ||
          activeSessionIdRef.current !== currentSessionId
        ) {
          return;
        }
        setFrames(stack.stackFrames);
        const frame = stack.stackFrames[0];
        if (!frame) {
          selectedFrameRef.current = null;
          setSelectedFrameId(null);
          setScopes([]);
          await refreshWatches(currentSessionId, null, generation);
          return;
        }
        selectedFrameRef.current = frame.id;
        setSelectedFrameId(frame.id);
        await hydrateFrame(currentSessionId, frame, generation);
      } catch (refreshError) {
        if (
          generation === generationRef.current &&
          activeSessionIdRef.current === currentSessionId
        ) {
          fail(refreshError);
        }
      }
    },
    [clearPausedState, fail, hydrateFrame, refreshWatches],
  );

  const refreshRunningThreads = useCallback(async (currentSessionId: string) => {
    const generation = generationRef.current;
    try {
      const response = await dapThreads(currentSessionId);
      if (
        generation !== generationRef.current ||
        activeSessionIdRef.current !== currentSessionId
      ) {
        return;
      }
      setThreads(response.threads);
      const selected =
        response.threads.find(
          (thread) => thread.id === selectedThreadRef.current,
        ) ?? response.threads[0];
      selectedThreadRef.current = selected?.id ?? null;
      setSelectedThreadId(selected?.id ?? null);
    } catch {
      // Some adapters reject `threads` briefly while a process is resuming.
      // The next thread/process/stopped event will refresh it again.
    }
  }, []);

  const handleEvent = useCallback(
    (envelope: DapEventEnvelope) => {
      if (envelope.tabId !== tabId) return;
      const activeSessionId = activeSessionIdRef.current;
      if (activeSessionId && activeSessionId !== envelope.sessionId) return;
      if (!activeSessionId) activeSessionIdRef.current = envelope.sessionId;
      const body = eventBody(envelope);

      switch (envelope.event) {
        case "output": {
          const text =
            typeof body.output === "string" ? body.output : String(body.output ?? "");
          if (text) {
            setOutput((entries) =>
              appendBoundedDebugOutput(entries, {
                category:
                  typeof body.category === "string"
                    ? body.category
                    : "console",
                output: text,
              }),
            );
          }
          break;
        }
        case "process":
          setError(null);
          setStatus("running");
          void refreshRunningThreads(envelope.sessionId);
          break;
        case "thread":
          void refreshRunningThreads(envelope.sessionId);
          break;
        case "stopped": {
          setError(null);
          setStatus("paused");
          const threadId = bodyNumber(body, "threadId");
          void refreshPaused(envelope.sessionId, threadId);
          break;
        }
        case "continued":
          generationRef.current += 1;
          clearFrameState();
          setStatus("running");
          break;
        case "exited":
        case "terminated": {
          generationRef.current += 1;
          clearPausedState();
          activeSessionIdRef.current = null;
          sessionRef.current = null;
          setSession(null);
          setStatus("stopped");
          void stopBackend(envelope.sessionId).catch(() => {});
          break;
        }
        case "adapterError":
          generationRef.current += 1;
          clearPausedState();
          activeSessionIdRef.current = null;
          sessionRef.current = null;
          setSession(null);
          fail(
            typeof body.message === "string"
              ? body.message
              : "Python debug adapter stopped unexpectedly",
          );
          void stopBackend(envelope.sessionId).catch(() => {});
          break;
        default:
          break;
      }
    },
    [
      clearFrameState,
      clearPausedState,
      fail,
      refreshPaused,
      refreshRunningThreads,
      stopBackend,
      tabId,
    ],
  );

  useEffect(() => {
    if (enabled !== true) return;
    let disposed = false;
    let unlisten: UnlistenFn | null = null;

    void listen<DapEventEnvelope>(DAP_EVENT, (event) => {
      if (!disposed) handleEvent(event.payload);
    })
      .then((stopListening) => {
        if (disposed) stopListening();
        else unlisten = stopListening;
      })
      .catch((listenError) => {
        if (!disposed) fail(listenError);
      });

    void dapSessionForTab(tabId)
      .then((existing) => {
        if (disposed || !existing) return;
        sessionRef.current = existing;
        activeSessionIdRef.current = existing.sessionId;
        setSession(existing);
        setStatus(
          existing.status === "paused"
            ? "paused"
            : existing.status === "starting"
              ? "starting"
              : "running",
        );
        if (existing.status === "paused") {
          void refreshPaused(existing.sessionId, null);
        }
      })
      .catch((restoreError) => {
        if (!disposed) fail(restoreError);
      });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [enabled, fail, handleEvent, refreshPaused, tabId]);

  const resetSession = useCallback(() => {
    generationRef.current += 1;
    activeSessionIdRef.current = null;
    sessionRef.current = null;
    setSession(null);
    clearPausedState();
  }, [clearPausedState]);

  useEffect(() => {
    if (enabled !== false) return;
    resetSession();
    setStatus("idle");
    void dapClearTab(tabId).catch((clearError) => {
      console.error("Failed to clear Python debugger state:", clearError);
    });
  }, [enabled, resetSession, tabId]);

  useEffect(
    () => () => {
      void dapClearTab(tabId).catch((clearError) => {
        console.error("Failed to clear Python debugger state:", clearError);
      });
    },
    [tabId],
  );

  const start = useCallback(
    async (options: DapLaunchOptions): Promise<boolean> => {
      const generation = generationRef.current + 1;
      generationRef.current = generation;
      lastLaunchRef.current = options;
      activeSessionIdRef.current = null;
      sessionRef.current = null;
      setSession(null);
      clearPausedState();
      setOutput([]);
      setError(null);
      setStatus("starting");
      try {
        const availability = await dapCheckAvailable(options.workspaceRoot);
        if (!availability.available) {
          throw new Error(
            availability.message ?? "Python debugger is unavailable",
          );
        }
        const started = await dapStart(options);
        if (generation !== generationRef.current) {
          await stopBackend(started.sessionId).catch(() => {});
          return false;
        }
        activeSessionIdRef.current = started.sessionId;
        sessionRef.current = started;
        setSession(started);
        setStatus(started.status === "paused" ? "paused" : "running");
        return true;
      } catch (startError) {
        if (generation === generationRef.current) fail(startError);
        return false;
      }
    },
    [clearPausedState, fail, stopBackend],
  );

  const restart = useCallback(async (): Promise<boolean> => {
    const currentSessionId =
      sessionRef.current?.sessionId ?? activeSessionIdRef.current;
    if (!currentSessionId) {
      return lastLaunchRef.current ? start(lastLaunchRef.current) : false;
    }
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    activeSessionIdRef.current = null;
    sessionRef.current = null;
    setSession(null);
    clearPausedState();
    setOutput([]);
    setError(null);
    setStatus("starting");
    try {
      const restarted = await dapRestart(currentSessionId);
      if (generation !== generationRef.current) {
        await stopBackend(restarted.sessionId).catch(() => {});
        return false;
      }
      activeSessionIdRef.current = restarted.sessionId;
      sessionRef.current = restarted;
      setSession(restarted);
      setStatus(restarted.status === "paused" ? "paused" : "running");
      return true;
    } catch (restartError) {
      if (generation === generationRef.current) fail(restartError);
      return false;
    }
  }, [clearPausedState, fail, start, stopBackend]);

  const stop = useCallback(async () => {
    const currentSessionId =
      sessionRef.current?.sessionId ?? activeSessionIdRef.current;
    resetSession();
    setError(null);
    setStatus("idle");
    if (!currentSessionId) return;
    try {
      await stopBackend(currentSessionId);
    } catch (stopError) {
      fail(stopError);
    }
  }, [fail, resetSession, stopBackend]);

  const requireSessionId = useCallback(() => {
    const sessionId =
      sessionRef.current?.sessionId ?? activeSessionIdRef.current;
    if (!sessionId) throw new Error("No active Python debug session");
    return sessionId;
  }, []);

  const requireThreadId = useCallback(
    async (sessionId: string): Promise<number> => {
      if (selectedThreadRef.current !== null) {
        return selectedThreadRef.current;
      }
      const response = await dapThreads(sessionId);
      const thread = response.threads[0];
      if (!thread) throw new Error("The debuggee has no active thread");
      setThreads(response.threads);
      selectedThreadRef.current = thread.id;
      setSelectedThreadId(thread.id);
      return thread.id;
    },
    [],
  );

  const runThreadControl = useCallback(
    async (
      command: (sessionId: string, threadId: number) => Promise<unknown>,
    ) => {
      try {
        const sessionId = requireSessionId();
        const threadId = await requireThreadId(sessionId);
        await command(sessionId, threadId);
        generationRef.current += 1;
        clearFrameState();
        setError(null);
        setStatus("running");
      } catch (controlError) {
        fail(controlError);
      }
    },
    [clearFrameState, fail, requireSessionId, requireThreadId],
  );

  const continueExecution = useCallback(
    () => runThreadControl(dapContinue),
    [runThreadControl],
  );
  const stepOver = useCallback(
    () => runThreadControl(dapNext),
    [runThreadControl],
  );
  const stepInto = useCallback(
    () => runThreadControl(dapStepIn),
    [runThreadControl],
  );
  const stepOut = useCallback(
    () => runThreadControl(dapStepOut),
    [runThreadControl],
  );

  const pause = useCallback(async () => {
    try {
      const sessionId = requireSessionId();
      const threadId = await requireThreadId(sessionId);
      await dapPause(sessionId, threadId);
    } catch (pauseError) {
      fail(pauseError);
    }
  }, [fail, requireSessionId, requireThreadId]);

  const selectThread = useCallback(
    async (threadId: number) => {
      const sessionId = requireSessionId();
      selectedThreadRef.current = threadId;
      setSelectedThreadId(threadId);
      const generation = generationRef.current;
      try {
        const stack = await dapStackTrace(sessionId, threadId);
        if (
          generation !== generationRef.current ||
          activeSessionIdRef.current !== sessionId
        ) {
          return;
        }
        setFrames(stack.stackFrames);
        const frame = stack.stackFrames[0];
        selectedFrameRef.current = frame?.id ?? null;
        setSelectedFrameId(frame?.id ?? null);
        setScopes([]);
        if (frame) await hydrateFrame(sessionId, frame, generation);
      } catch (threadError) {
        fail(threadError);
      }
    },
    [fail, hydrateFrame, requireSessionId],
  );

  const selectFrame = useCallback(
    async (frame: DapStackFrame) => {
      const sessionId = requireSessionId();
      const generation = generationRef.current;
      selectedFrameRef.current = frame.id;
      setSelectedFrameId(frame.id);
      setScopes([]);
      try {
        await hydrateFrame(sessionId, frame, generation);
      } catch (frameError) {
        if (generation === generationRef.current) fail(frameError);
      }
    },
    [fail, hydrateFrame, requireSessionId],
  );

  const loadVariables = useCallback(
    async (variablesReference: number): Promise<DapVariable[]> => {
      if (variablesReference <= 0) return [];
      const response = await dapVariables(
        requireSessionId(),
        variablesReference,
      );
      return response.variables;
    },
    [requireSessionId],
  );

  const addWatch = useCallback(
    async (expression: string) => {
      const trimmed = expression.trim();
      if (!trimmed) return;
      const watch: DebugWatch = {
        id: newWatchId(),
        expression: trimmed,
        value: null,
        type: null,
        variablesReference: 0,
        error: null,
      };
      const next = [...watchesRef.current, watch];
      watchesRef.current = next;
      setWatches(next);
      if (statusRef.current !== "paused") return;
      const sessionId = requireSessionId();
      const generation = generationRef.current;
      const evaluated = await evaluateWatch(
        sessionId,
        watch,
        selectedFrameRef.current,
        generation,
      );
      if (
        generation !== generationRef.current ||
        activeSessionIdRef.current !== sessionId
      ) {
        return;
      }
      const updated = watchesRef.current.map((candidate) =>
        candidate.id === evaluated.id ? evaluated : candidate,
      );
      watchesRef.current = updated;
      setWatches(updated);
    },
    [evaluateWatch, requireSessionId],
  );

  const removeWatch = useCallback((watchId: string) => {
    const next = watchesRef.current.filter((watch) => watch.id !== watchId);
    watchesRef.current = next;
    setWatches(next);
  }, []);

  const clearOutput = useCallback(() => setOutput([]), []);

  return {
    status,
    session,
    error,
    threads,
    selectedThreadId,
    frames,
    selectedFrameId,
    scopes,
    watches,
    output,
    start,
    restart,
    stop,
    continueExecution,
    pause,
    stepOver,
    stepInto,
    stepOut,
    selectThread,
    selectFrame,
    loadVariables,
    addWatch,
    removeWatch,
    clearOutput,
  };
}

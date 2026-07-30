import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type * as Monaco from "monaco-editor";
import {
  DAP_BREAKPOINTS_CHANGED_EVENT,
  DAP_EVENT,
  dapBreakpointsGet,
  dapBreakpointsSet,
  dapSessionForTab,
  dapStackTrace,
  dapThreads,
  type DapBreakpoint,
  type DapBreakpointSet,
  type DapEventEnvelope,
  type DapSessionInfo,
  type DapStackFrame,
} from "../../../lib/tauri";

export function buildBreakpointDecorations(
  monaco: typeof Monaco,
  breakpoints: readonly DapBreakpoint[],
  modelLineCount: number,
): Monaco.editor.IModelDeltaDecoration[] {
  const lastLine = Math.max(1, modelLineCount);
  return breakpoints.map((breakpoint) => {
    const line = Math.min(lastLine, Math.max(1, breakpoint.line));
    const state = breakpoint.verified
      ? "verified"
      : breakpoint.message
        ? "rejected"
        : "requested";
    const tooltip = breakpoint.verified
      ? `Breakpoint at line ${breakpoint.line}`
      : breakpoint.message ?? `Pending breakpoint at line ${breakpoint.line}`;
    return {
      range: new monaco.Range(line, 1, line, 1),
      options: {
        isWholeLine: false,
        glyphMarginClassName: `zed-debug-breakpoint zed-debug-breakpoint--${state}`,
        glyphMarginHoverMessage: { value: tooltip },
        stickiness:
          monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
      },
    };
  });
}

export function buildStoppedLineDecoration(
  monaco: typeof Monaco,
  lineNumber: number,
  modelLineCount: number,
): Monaco.editor.IModelDeltaDecoration {
  const line = Math.min(Math.max(1, modelLineCount), Math.max(1, lineNumber));
  return {
    range: new monaco.Range(line, 1, line, 1),
    options: {
      isWholeLine: true,
      className: "zed-debug-current-line",
      glyphMarginClassName: "zed-debug-current-line-glyph",
      glyphMarginHoverMessage: { value: "Current debug position" },
      stickiness:
        monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
    },
  };
}

type DebugDecorationDependencies = {
  getBreakpoints?: typeof dapBreakpointsGet;
  setBreakpoints?: typeof dapBreakpointsSet;
  getSessionForTab?: typeof dapSessionForTab;
  getThreads?: typeof dapThreads;
  getStackTrace?: typeof dapStackTrace;
  listenEvent?: <T>(
    eventName: string,
    handler: (payload: T) => void,
  ) => Promise<UnlistenFn>;
  onError?: (error: unknown) => void;
};

export type InstallDebugDecorationsOptions = {
  editor: Monaco.editor.IStandaloneCodeEditor;
  monaco: typeof Monaco;
  tabId: string;
  workspaceRoot: string;
  filePath: string;
  dependencies?: DebugDecorationDependencies;
};

const EMPTY_DISPOSABLE: Monaco.IDisposable = { dispose() {} };

function samePath(left: string | undefined, right: string): boolean {
  if (!left) return false;
  return left.replace(/\/+$/, "") === right.replace(/\/+$/, "");
}

export function installDebugDecorations({
  editor,
  monaco,
  tabId,
  workspaceRoot,
  filePath,
  dependencies = {},
}: InstallDebugDecorationsOptions): Monaco.IDisposable {
  const expectedModel = editor.getModel();
  if (!expectedModel) return EMPTY_DISPOSABLE;

  const getBreakpoints =
    dependencies.getBreakpoints ?? dapBreakpointsGet;
  const setBreakpoints =
    dependencies.setBreakpoints ?? dapBreakpointsSet;
  const getSessionForTab =
    dependencies.getSessionForTab ?? dapSessionForTab;
  const getThreads = dependencies.getThreads ?? dapThreads;
  const getStackTrace = dependencies.getStackTrace ?? dapStackTrace;
  const listenEvent =
    dependencies.listenEvent ??
    (async <T,>(eventName: string, handler: (payload: T) => void) =>
      listen<T>(eventName, (event) => handler(event.payload)));

  const breakpointDecorations = editor.createDecorationsCollection();
  const stoppedDecorations = editor.createDecorationsCollection();
  let breakpoints: DapBreakpoint[] = [];
  let authoritativeFilePath = filePath;
  let activeSessionId: string | null = null;
  let disposed = false;
  let generation = 0;
  const unlisteners: UnlistenFn[] = [];

  const ownsExpectedModel = () =>
    !disposed && editor.getModel() === expectedModel;

  const renderBreakpoints = (next: readonly DapBreakpoint[]) => {
    if (!ownsExpectedModel()) return;
    breakpoints = [...next];
    breakpointDecorations.set(
      buildBreakpointDecorations(
        monaco,
        breakpoints,
        expectedModel.getLineCount(),
      ),
    );
  };

  const renderStoppedFrame = (frame: DapStackFrame | undefined) => {
    if (
      !ownsExpectedModel() ||
      !frame?.source?.path ||
      (!samePath(frame.source.path, filePath) &&
        !samePath(frame.source.path, authoritativeFilePath))
    ) {
      stoppedDecorations.clear();
      return;
    }
    stoppedDecorations.set([
      buildStoppedLineDecoration(
        monaco,
        frame.line,
        expectedModel.getLineCount(),
      ),
    ]);
    editor.revealLineInCenterIfOutsideViewport(frame.line);
  };

  const refreshStoppedFrame = async (
    sessionId: string,
    preferredThreadId: number | null,
  ) => {
    const requestGeneration = ++generation;
    try {
      let threadId = preferredThreadId;
      if (threadId === null) {
        const response = await getThreads(sessionId);
        threadId = response.threads[0]?.id ?? null;
      }
      if (threadId === null) {
        if (ownsExpectedModel()) stoppedDecorations.clear();
        return;
      }
      const stack = await getStackTrace(sessionId, threadId);
      if (
        requestGeneration === generation &&
        ownsExpectedModel() &&
        activeSessionId === sessionId
      ) {
        renderStoppedFrame(stack.stackFrames[0]);
      }
    } catch (error) {
      if (requestGeneration === generation && ownsExpectedModel()) {
        stoppedDecorations.clear();
        dependencies.onError?.(error);
      }
    }
  };

  const applyBreakpointSet = (set: DapBreakpointSet) => {
    if (
      set.tabId === tabId &&
      (samePath(set.filePath, filePath) ||
        samePath(set.filePath, authoritativeFilePath)) &&
      ownsExpectedModel()
    ) {
      authoritativeFilePath = set.filePath;
      renderBreakpoints(set.breakpoints);
    }
  };

  const mouseDisposable = editor.onMouseDown((event) => {
    if (
      !ownsExpectedModel() ||
      event.event.leftButton !== true ||
      event.target.type !==
        monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN ||
      !event.target.position
    ) {
      return;
    }
    const line = event.target.position.lineNumber;
    const lines = new Set(breakpoints.map((breakpoint) => breakpoint.line));
    if (lines.has(line)) lines.delete(line);
    else lines.add(line);
    void setBreakpoints(
      tabId,
      workspaceRoot,
      filePath,
      [...lines].sort((left, right) => left - right),
    )
      .then(applyBreakpointSet)
      .catch((error) => dependencies.onError?.(error));
  });

  void getBreakpoints(tabId, workspaceRoot, filePath)
    .then((set) => {
      if (set.tabId !== tabId || !ownsExpectedModel()) return;
      authoritativeFilePath = set.filePath;
      renderBreakpoints(set.breakpoints);
    })
    .catch((error) => {
      if (ownsExpectedModel()) dependencies.onError?.(error);
    });

  void getSessionForTab(tabId)
    .then((existing: DapSessionInfo | null) => {
      if (!ownsExpectedModel() || !existing) return;
      activeSessionId = existing.sessionId;
      if (existing.status === "paused") {
        void refreshStoppedFrame(existing.sessionId, null);
      }
    })
    .catch((error) => {
      if (ownsExpectedModel()) dependencies.onError?.(error);
    });

  void listenEvent<DapBreakpointSet>(
    DAP_BREAKPOINTS_CHANGED_EVENT,
    applyBreakpointSet,
  )
    .then((unlisten) => {
      if (disposed) unlisten();
      else unlisteners.push(unlisten);
    })
    .catch((error) => {
      if (ownsExpectedModel()) dependencies.onError?.(error);
    });

  void listenEvent<DapEventEnvelope>(DAP_EVENT, (envelope) => {
    if (envelope.tabId !== tabId || !ownsExpectedModel()) return;
    if (
      activeSessionId &&
      envelope.sessionId !== activeSessionId &&
      envelope.event !== "initialized"
    ) {
      return;
    }
    switch (envelope.event) {
      case "initialized":
      case "process":
        activeSessionId = envelope.sessionId;
        break;
      case "stopped": {
        activeSessionId = envelope.sessionId;
        const threadId =
          typeof envelope.body?.threadId === "number"
            ? envelope.body.threadId
            : null;
        void refreshStoppedFrame(envelope.sessionId, threadId);
        break;
      }
      case "continued":
        generation += 1;
        stoppedDecorations.clear();
        break;
      case "exited":
      case "terminated":
      case "adapterError":
        generation += 1;
        activeSessionId = null;
        stoppedDecorations.clear();
        break;
      default:
        break;
    }
  })
    .then((unlisten) => {
      if (disposed) unlisten();
      else unlisteners.push(unlisten);
    })
    .catch((error) => {
      if (ownsExpectedModel()) dependencies.onError?.(error);
    });

  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      generation += 1;
      mouseDisposable.dispose();
      unlisteners.splice(0).forEach((unlisten) => unlisten());
      breakpointDecorations.clear();
      stoppedDecorations.clear();
    },
  };
}

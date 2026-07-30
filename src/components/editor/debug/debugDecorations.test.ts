import { describe, expect, it, vi } from "vitest";
import type * as Monaco from "monaco-editor";
import {
  DAP_BREAKPOINTS_CHANGED_EVENT,
  DAP_EVENT,
  type DapBreakpointSet,
  type DapEventEnvelope,
} from "../../../lib/tauri";
import {
  buildBreakpointDecorations,
  buildStoppedLineDecoration,
  installDebugDecorations,
} from "./debugDecorations";

class FakeRange {
  constructor(
    public startLineNumber: number,
    public startColumn: number,
    public endLineNumber: number,
    public endColumn: number,
  ) {}
}

const monaco = {
  Range: FakeRange,
  editor: {
    MouseTargetType: { GUTTER_GLYPH_MARGIN: 2 },
    TrackedRangeStickiness: { NeverGrowsWhenTypingAtEdges: 1 },
  },
} as unknown as typeof Monaco;

describe("Python debug decoration mapping", () => {
  it("distinguishes requested, verified, and rejected breakpoints", () => {
    const decorations = buildBreakpointDecorations(
      monaco,
      [
        { id: null, line: 2, verified: false, message: null },
        { id: 1, line: 4, verified: true, message: null },
        { id: 2, line: 99, verified: false, message: "No executable code" },
      ],
      8,
    );

    expect(decorations[0].options.glyphMarginClassName).toContain("requested");
    expect(decorations[1].options.glyphMarginClassName).toContain("verified");
    expect(decorations[2].options.glyphMarginClassName).toContain("rejected");
    expect(decorations[2].range).toMatchObject({ startLineNumber: 8 });
    expect(decorations[2].options.glyphMarginHoverMessage).toEqual({
      value: "No executable code",
    });
  });

  it("builds a whole-line current-frame marker", () => {
    const decoration = buildStoppedLineDecoration(monaco, 7, 20);
    expect(decoration.range).toMatchObject({ startLineNumber: 7 });
    expect(decoration.options.isWholeLine).toBe(true);
    expect(decoration.options.className).toBe("zed-debug-current-line");
  });
});

function makeHarness() {
  const model = { getLineCount: () => 20 };
  const breakpointCollection = { set: vi.fn(), clear: vi.fn() };
  const stoppedCollection = { set: vi.fn(), clear: vi.fn() };
  let collection = 0;
  let mouseHandler: ((event: any) => void) | null = null;
  const editor = {
    getModel: () => model,
    createDecorationsCollection: () =>
      collection++ === 0 ? breakpointCollection : stoppedCollection,
    onMouseDown: (handler: (event: any) => void) => {
      mouseHandler = handler;
      return { dispose: vi.fn() };
    },
    revealLineInCenterIfOutsideViewport: vi.fn(),
  } as unknown as Monaco.editor.IStandaloneCodeEditor;
  return {
    editor,
    breakpointCollection,
    stoppedCollection,
    click(event: any) {
      mouseHandler?.(event);
    },
  };
}

describe("Python debug decoration lifecycle", () => {
  it("toggles complete line sets and synchronizes breakpoint/stopped events", async () => {
    const harness = makeHarness();
    const handlers = new Map<string, (payload: any) => void>();
    const unlisten = vi.fn();
    const setBreakpoints = vi.fn().mockImplementation(
      async (
        tabId: string,
        _root: string,
        filePath: string,
        lines: number[],
      ): Promise<DapBreakpointSet> => ({
        tabId,
        filePath,
        breakpoints: lines.map((line) => ({
          id: line,
          line,
          verified: true,
          message: null,
        })),
      }),
    );
    const getStackTrace = vi.fn().mockResolvedValue({
      stackFrames: [
        {
          id: 10,
          name: "main",
          source: { path: "/repo/main.py" },
          line: 8,
          column: 1,
        },
      ],
    });

    const installed = installDebugDecorations({
      editor: harness.editor,
      monaco,
      tabId: "tab-1",
      workspaceRoot: "/repo",
      filePath: "/repo/main.py",
      dependencies: {
        getBreakpoints: vi.fn().mockResolvedValue({
          tabId: "tab-1",
          filePath: "/repo/main.py",
          breakpoints: [
            { id: null, line: 3, verified: false, message: null },
          ],
        }),
        setBreakpoints,
        getSessionForTab: vi.fn().mockResolvedValue(null),
        getThreads: vi.fn(),
        getStackTrace,
        listenEvent: async (name, handler) => {
          handlers.set(name, handler);
          return unlisten;
        },
      },
    });

    await vi.waitFor(() =>
      expect(harness.breakpointCollection.set).toHaveBeenCalled(),
    );
    harness.click({
      event: { leftButton: true },
      target: {
        type: 2,
        position: { lineNumber: 5 },
      },
    });
    await vi.waitFor(() =>
      expect(setBreakpoints).toHaveBeenCalledWith(
        "tab-1",
        "/repo",
        "/repo/main.py",
        [3, 5],
      ),
    );

    handlers.get(DAP_BREAKPOINTS_CHANGED_EVENT)?.({
      tabId: "tab-1",
      filePath: "/repo/main.py",
      breakpoints: [{ id: 9, line: 9, verified: true, message: null }],
    } satisfies DapBreakpointSet);
    expect(harness.breakpointCollection.set).toHaveBeenLastCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          range: expect.objectContaining({ startLineNumber: 9 }),
        }),
      ]),
    );

    handlers.get(DAP_EVENT)?.({
      sessionId: "session-1",
      tabId: "tab-1",
      event: "stopped",
      body: { threadId: 7 },
    } satisfies DapEventEnvelope);
    await vi.waitFor(() =>
      expect(harness.stoppedCollection.set).toHaveBeenCalledWith([
        expect.objectContaining({
          range: expect.objectContaining({ startLineNumber: 8 }),
        }),
      ]),
    );
    expect(getStackTrace).toHaveBeenCalledWith("session-1", 7);

    handlers.get(DAP_EVENT)?.({
      sessionId: "session-1",
      tabId: "tab-1",
      event: "continued",
      body: {},
    } satisfies DapEventEnvelope);
    expect(harness.stoppedCollection.clear).toHaveBeenCalled();

    installed.dispose();
    expect(unlisten).toHaveBeenCalledTimes(2);
    expect(harness.breakpointCollection.clear).toHaveBeenCalled();
  });
});

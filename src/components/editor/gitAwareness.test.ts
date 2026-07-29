import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as Monaco from "monaco-editor";
import type {
  GitFileChanges,
  GitLineBlame,
  GitLineChange,
} from "../../lib/tauri";
import {
  GIT_BLAME_DEBOUNCE_MS,
  GIT_DIFF_DEBOUNCE_MS,
  buildGitBlameDecoration,
  buildGitDiffDecorations,
  formatGitBlame,
  installGitAwareness,
} from "./gitAwareness";

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
    OverviewRulerLane: { Left: 1 },
    TrackedRangeStickiness: { NeverGrowsWhenTypingAtEdges: 1 },
    InjectedTextCursorStops: { None: 3 },
  },
} as unknown as typeof Monaco;

const committedBlame: GitLineBlame = {
  lineNumber: 3,
  commit: "abcdef0123456789",
  author: "Alice",
  authorEmail: "alice@example.com",
  timestamp: 1_700_000_000,
  summary: "Explain the line",
  uncommitted: false,
};

describe("Git decoration mapping", () => {
  it("maps line kinds to clamped gutter and overview-ruler decorations", () => {
    const changes: GitLineChange[] = [
      { lineNumber: 2, kind: "added", deletedLines: 0 },
      { lineNumber: 4, kind: "modified", deletedLines: 0 },
      { lineNumber: 99, kind: "deleted", deletedLines: 3 },
    ];

    const decorations = buildGitDiffDecorations(monaco, changes, 7);

    expect(decorations).toHaveLength(3);
    expect(decorations[0].range).toMatchObject({ startLineNumber: 2 });
    expect(decorations[0].options.glyphMarginClassName).toContain("added");
    expect(decorations[1].options.glyphMarginClassName).toContain("modified");
    expect(decorations[2].range).toMatchObject({ startLineNumber: 7 });
    expect(decorations[2].options.glyphMarginHoverMessage).toEqual({
      value: "3 deleted lines",
    });
  });

  it("formats committed and uncommitted blame compactly", () => {
    const now = (1_700_000_000 + 2 * 86_400) * 1000;
    expect(formatGitBlame(committedBlame, now)).toBe(
      "Alice, 2d ago • Explain the line • abcdef0",
    );
    expect(
      formatGitBlame({
        ...committedBlame,
        commit: null,
        timestamp: null,
        summary: null,
        author: "You",
        uncommitted: true,
      }),
    ).toBe("You, uncommitted changes");
  });

  it("injects blame after the current line without changing model text", () => {
    const decoration = buildGitBlameDecoration(
      monaco,
      committedBlame,
      24,
      (1_700_000_000 + 60) * 1000,
    );

    expect(decoration.range).toMatchObject({
      startLineNumber: 3,
      startColumn: 24,
      endLineNumber: 3,
      endColumn: 24,
    });
    expect(decoration.options.after?.content).toContain(
      "Alice, 1m ago • Explain the line • abcdef0",
    );
    expect(decoration.options.showIfCollapsed).toBe(true);
    expect(decoration.options.after?.inlineClassName).toBe("git-blame-inline");
  });
});

type FakeEditorHarness = ReturnType<typeof makeEditor>;

function makeEditor() {
  let value = "one\ntwo\n";
  let line = 1;
  const contentListeners = new Set<() => void>();
  const cursorListeners = new Set<(event: { position: { lineNumber: number } }) => void>();
  const collections = [
    { set: vi.fn(), clear: vi.fn() },
    { set: vi.fn(), clear: vi.fn() },
  ];
  let collectionIndex = 0;
  const model = {
    getValue: () => value,
    getLineCount: () => value.split("\n").length,
    getLineMaxColumn: (lineNumber: number) =>
      (value.split("\n")[lineNumber - 1]?.length ?? 0) + 1,
  };
  const editor = {
    getModel: () => model,
    getPosition: () => ({ lineNumber: line, column: 1 }),
    createDecorationsCollection: () => collections[collectionIndex++],
    onDidChangeModelContent: (listener: () => void) => {
      contentListeners.add(listener);
      return { dispose: () => contentListeners.delete(listener) };
    },
    onDidChangeCursorPosition: (
      listener: (event: { position: { lineNumber: number } }) => void,
    ) => {
      cursorListeners.add(listener);
      return { dispose: () => cursorListeners.delete(listener) };
    },
  } as unknown as Monaco.editor.IStandaloneCodeEditor;

  return {
    editor,
    collections,
    setValue(next: string) {
      value = next;
      contentListeners.forEach((listener) => listener());
    },
    moveCursor(nextLine: number) {
      line = nextLine;
      cursorListeners.forEach((listener) =>
        listener({ position: { lineNumber: nextLine } }),
      );
    },
    listenerCounts() {
      return {
        content: contentListeners.size,
        cursor: cursorListeners.size,
      };
    },
  };
}

function fileChanges(changes: GitLineChange[]): GitFileChanges {
  return {
    repoRoot: "/repo",
    relativePath: "file.txt",
    binary: false,
    changes,
  };
}

describe("Git awareness lifecycle", () => {
  let harness: FakeEditorHarness;

  beforeEach(() => {
    vi.useFakeTimers();
    harness = makeEditor();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("debounces edits and cursor blame independently", async () => {
    const getFileChanges = vi
      .fn()
      .mockResolvedValue(fileChanges([{ lineNumber: 1, kind: "added", deletedLines: 0 }]));
    const getLineBlame = vi.fn().mockResolvedValue(committedBlame);
    const awareness = installGitAwareness({
      editor: harness.editor,
      monaco,
      filePath: "/repo/file.txt",
      dependencies: { getFileChanges, getLineBlame },
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(getFileChanges).toHaveBeenCalledTimes(1);
    expect(getLineBlame).not.toHaveBeenCalled();

    harness.setValue("ONE\ntwo\n");
    harness.setValue("ONE\nTWO\n");
    await vi.advanceTimersByTimeAsync(GIT_DIFF_DEBOUNCE_MS - 1);
    expect(getFileChanges).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(getFileChanges).toHaveBeenCalledTimes(2);
    expect(getFileChanges).toHaveBeenLastCalledWith(
      "/repo/file.txt",
      "ONE\nTWO\n",
    );

    harness.moveCursor(2);
    await vi.advanceTimersByTimeAsync(GIT_BLAME_DEBOUNCE_MS);
    expect(getLineBlame).toHaveBeenLastCalledWith(
      "/repo/file.txt",
      "ONE\nTWO\n",
      2,
    );
    awareness.dispose();
  });

  it("invalidates an in-flight diff as soon as a newer edit is scheduled", async () => {
    let resolveFirst: ((value: GitFileChanges | null) => void) | null = null;
    const first = new Promise<GitFileChanges | null>((resolve) => {
      resolveFirst = resolve;
    });
    const getFileChanges = vi
      .fn()
      .mockReturnValueOnce(first)
      .mockResolvedValueOnce(fileChanges([]));
    const awareness = installGitAwareness({
      editor: harness.editor,
      monaco,
      filePath: "/repo/file.txt",
      dependencies: {
        getFileChanges,
        getLineBlame: vi.fn().mockResolvedValue(null),
      },
    });

    await vi.advanceTimersByTimeAsync(0);
    harness.setValue("new\n");
    resolveFirst?.(
      fileChanges([{ lineNumber: 1, kind: "added", deletedLines: 0 }]),
    );
    await Promise.resolve();
    expect(harness.collections[0].set).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(GIT_DIFF_DEBOUNCE_MS);
    expect(harness.collections[0].set).toHaveBeenCalledWith([]);
    awareness.dispose();
  });

  it("cancels timers, listeners, and decorations on disposal", async () => {
    const getFileChanges = vi.fn().mockResolvedValue(fileChanges([]));
    const getLineBlame = vi.fn().mockResolvedValue(committedBlame);
    const awareness = installGitAwareness({
      editor: harness.editor,
      monaco,
      filePath: "/repo/file.txt",
      dependencies: { getFileChanges, getLineBlame },
    });

    awareness.dispose();
    await vi.runAllTimersAsync();

    expect(getFileChanges).not.toHaveBeenCalled();
    expect(getLineBlame).not.toHaveBeenCalled();
    expect(harness.listenerCounts()).toEqual({ content: 0, cursor: 0 });
    expect(harness.collections[0].clear).toHaveBeenCalled();
    expect(harness.collections[1].clear).toHaveBeenCalled();
  });
});

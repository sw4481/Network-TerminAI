import type * as Monaco from "monaco-editor";
import { describe, expect, it, vi } from "vitest";

import { createBookmarkController } from "./bookmarkController";

class TestRange {
  constructor(
    readonly startLineNumber: number,
    readonly startColumn: number,
    readonly endLineNumber: number,
    readonly endColumn: number,
  ) {}
}

const monaco = { Range: TestRange } as unknown as typeof Monaco;

function editorAtLine(initialLine: number, initialLineCount = 10) {
  let currentLine = initialLine;
  let currentLineCount = initialLineCount;
  let nextDecorationId = 1;
  const actionDisposables: Array<ReturnType<typeof vi.fn>> = [];
  const model = { getLineCount: vi.fn(() => currentLineCount) };
  const getModel = vi.fn<() => typeof model | null>(() => model);
  const getPosition = vi.fn<() => Monaco.IPosition | null>(() => ({
    lineNumber: currentLine,
    column: 1,
  }));
  const editor = {
    addAction: vi.fn((descriptor: Monaco.editor.IActionDescriptor) => {
      const dispose = vi.fn();
      actionDisposables.push(dispose);
      return { descriptor, dispose };
    }),
    deltaDecorations: vi.fn(
      (_oldDecorations: string[], newDecorations: Monaco.editor.IModelDeltaDecoration[]) =>
        newDecorations.map(() => `bookmark-${nextDecorationId++}`),
    ),
    getModel,
    getPosition,
    revealLineInCenter: vi.fn(),
    setPosition: vi.fn((position: Monaco.IPosition) => {
      currentLine = position.lineNumber;
    }),
  };

  return {
    actionDisposables,
    editor: editor as unknown as Monaco.editor.IStandaloneCodeEditor,
    rawEditor: editor,
    setCurrentLine: (lineNumber: number) => {
      currentLine = lineNumber;
    },
    setLineCount: (lineCount: number) => {
      currentLineCount = lineCount;
    },
  };
}

describe("bookmark controller", () => {
  it("toggles the current one-based line and renders one glyph decoration", () => {
    const { editor, rawEditor } = editorAtLine(4);
    const controller = createBookmarkController(
      editor,
      monaco,
      "file:/repo/a.ts",
    );

    controller.toggleCurrentLine();

    expect(controller.getLines()).toEqual([4]);
    expect(rawEditor.deltaDecorations).toHaveBeenCalledWith([], [
      expect.objectContaining({
        range: expect.objectContaining({
          startLineNumber: 4,
          endLineNumber: 4,
        }),
        options: expect.objectContaining({
          glyphMarginClassName: "ccie-editor-bookmark-glyph",
        }),
      }),
    ]);
  });

  it("keeps bookmark lines local to each buffer and restores their glyphs", () => {
    const { editor, rawEditor, setCurrentLine } = editorAtLine(2);
    const controller = createBookmarkController(editor, monaco, "buffer-a");
    controller.toggleCurrentLine();

    controller.setBuffer("buffer-b");
    setCurrentLine(5);
    controller.toggleCurrentLine();
    expect(controller.getLines()).toEqual([5]);

    controller.setBuffer("buffer-a");

    expect(controller.getLines()).toEqual([2]);
    expect(rawEditor.deltaDecorations).toHaveBeenLastCalledWith([], [
      expect.objectContaining({
        range: expect.objectContaining({ startLineNumber: 2 }),
      }),
    ]);
  });

  it("registers the exact bookmark context-menu actions", () => {
    const { editor, rawEditor } = editorAtLine(4);
    createBookmarkController(editor, monaco, "buffer-a");

    expect(rawEditor.addAction.mock.calls.map(([action]) => ({
      id: action.id,
      label: action.label,
      group: action.contextMenuGroupId,
      keybindings: action.keybindings,
    }))).toEqual([
      {
        id: "ccie.editor.bookmark.toggle",
        label: "Toggle Bookmark",
        group: "2_powerEditing",
        keybindings: undefined,
      },
      {
        id: "ccie.editor.bookmark.next",
        label: "Next Bookmark",
        group: "2_powerEditing",
        keybindings: undefined,
      },
      {
        id: "ccie.editor.bookmark.previous",
        label: "Previous Bookmark",
        group: "2_powerEditing",
        keybindings: undefined,
      },
      {
        id: "ccie.editor.bookmark.clear",
        label: "Clear All Bookmarks",
        group: "2_powerEditing",
        keybindings: undefined,
      },
    ]);
  });

  it("executes each bookmark action with its distinct behavior", () => {
    const { editor, rawEditor, setCurrentLine } = editorAtLine(2);
    const controller = createBookmarkController(editor, monaco, "buffer-a");
    const actions = Object.fromEntries(
      rawEditor.addAction.mock.calls.map(([action]) => [action.id, action]),
    );

    actions["ccie.editor.bookmark.toggle"].run(editor);
    expect(controller.getLines()).toEqual([2]);

    setCurrentLine(5);
    actions["ccie.editor.bookmark.toggle"].run(editor);
    actions["ccie.editor.bookmark.next"].run(editor);
    expect(rawEditor.setPosition).toHaveBeenLastCalledWith({
      lineNumber: 2,
      column: 1,
    });
    expect(rawEditor.revealLineInCenter).toHaveBeenLastCalledWith(2);

    setCurrentLine(2);
    actions["ccie.editor.bookmark.previous"].run(editor);
    expect(rawEditor.setPosition).toHaveBeenLastCalledWith({
      lineNumber: 5,
      column: 1,
    });
    expect(rawEditor.revealLineInCenter).toHaveBeenLastCalledWith(5);

    actions["ccie.editor.bookmark.clear"].run(editor);
    expect(controller.getLines()).toEqual([]);
    expect(rawEditor.deltaDecorations).toHaveBeenLastCalledWith(
      expect.any(Array),
      [],
    );
  });

  it("does nothing when the model or position is unavailable", () => {
    const { editor, rawEditor } = editorAtLine(4);
    const controller = createBookmarkController(editor, monaco, "buffer-a");
    const actions = Object.fromEntries(
      rawEditor.addAction.mock.calls.map(([action]) => [action.id, action]),
    );

    rawEditor.getModel.mockReturnValueOnce(null);
    actions["ccie.editor.bookmark.toggle"].run(editor);
    rawEditor.getPosition.mockReturnValueOnce(null);
    actions["ccie.editor.bookmark.toggle"].run(editor);
    rawEditor.getPosition.mockReturnValueOnce(null);
    actions["ccie.editor.bookmark.next"].run(editor);
    rawEditor.getPosition.mockReturnValueOnce(null);
    actions["ccie.editor.bookmark.previous"].run(editor);
    rawEditor.getModel.mockReturnValueOnce(null);
    actions["ccie.editor.bookmark.clear"].run(editor);

    expect(controller.getLines()).toEqual([]);
    expect(rawEditor.deltaDecorations).not.toHaveBeenCalled();
    expect(rawEditor.setPosition).not.toHaveBeenCalled();
    expect(rawEditor.revealLineInCenter).not.toHaveBeenCalled();
  });

  it("normalizes and redraws bookmarks before navigation", () => {
    const { editor, rawEditor, setCurrentLine, setLineCount } = editorAtLine(2);
    const controller = createBookmarkController(editor, monaco, "buffer-a");
    controller.toggleCurrentLine();
    setCurrentLine(9);
    controller.toggleCurrentLine();

    setLineCount(5);
    setCurrentLine(2);
    controller.next();

    expect(controller.getLines()).toEqual([2]);
    expect(rawEditor.deltaDecorations).toHaveBeenLastCalledWith(
      expect.any(Array),
      [
        expect.objectContaining({
          range: expect.objectContaining({ startLineNumber: 2 }),
        }),
      ],
    );
  });

  it("wraps navigation and disposes the current decorations and actions", () => {
    const { actionDisposables, editor, rawEditor, setCurrentLine } =
      editorAtLine(2);
    const controller = createBookmarkController(editor, monaco, "buffer-a");
    controller.toggleCurrentLine();
    setCurrentLine(5);
    controller.toggleCurrentLine();

    controller.next();

    expect(rawEditor.setPosition).toHaveBeenCalledWith({
      lineNumber: 2,
      column: 1,
    });
    expect(rawEditor.revealLineInCenter).toHaveBeenCalledWith(2);

    const decorationCallsBeforeDispose = rawEditor.deltaDecorations.mock.calls.length;
    controller.dispose();
    controller.dispose();

    expect(rawEditor.deltaDecorations).toHaveBeenLastCalledWith(
      expect.any(Array),
      [],
    );
    expect(rawEditor.deltaDecorations).toHaveBeenCalledTimes(
      decorationCallsBeforeDispose + 1,
    );
    actionDisposables.forEach((dispose) => {
      expect(dispose).toHaveBeenCalledOnce();
    });
  });
});

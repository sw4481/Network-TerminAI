import type * as Monaco from "monaco-editor";

import {
  nextBookmarkLine,
  normalizeBookmarkLines,
  previousBookmarkLine,
  toggleBookmarkLine,
} from "./bookmarks";

export type BookmarkController = {
  setBuffer: (bufferId: string) => void;
  dispose: () => void;
  getLines: () => readonly number[];
  toggleCurrentLine: () => void;
  next: () => void;
  previous: () => void;
  clear: () => void;
};

export function createBookmarkController(
  editor: Monaco.editor.IStandaloneCodeEditor,
  monaco: typeof Monaco,
  bufferId: string,
): BookmarkController {
  const linesByBuffer = new Map<string, number[]>();
  let activeBufferId = bufferId;
  let decorationIds: string[] = [];
  let disposed = false;

  const getLines = (): readonly number[] => [
    ...(linesByBuffer.get(activeBufferId) ?? []),
  ];

  const render = (lines: readonly number[]) => {
    decorationIds = editor.deltaDecorations(
      decorationIds,
      lines.map((line) => ({
        range: new monaco.Range(line, 1, line, 1),
        options: { glyphMarginClassName: "ccie-editor-bookmark-glyph" },
      })),
    );
  };

  const currentLines = () => {
    const model = editor.getModel();
    if (!model) return null;
    const lines = normalizeBookmarkLines(
      linesByBuffer.get(activeBufferId) ?? [],
      model.getLineCount(),
    );
    linesByBuffer.set(activeBufferId, lines);
    return lines;
  };

  const toggleCurrentLine = () => {
    if (disposed) return;
    const model = editor.getModel();
    const position = editor.getPosition();
    if (!model || !position) return;
    const lines = toggleBookmarkLine(
      linesByBuffer.get(activeBufferId) ?? [],
      position.lineNumber,
      model.getLineCount(),
    );
    linesByBuffer.set(activeBufferId, lines);
    render(lines);
  };

  const navigate = (
    findLine: (lines: readonly number[], currentLine: number) => number | null,
  ) => {
    if (disposed) return;
    const position = editor.getPosition();
    if (!position) return;
    const lines = currentLines();
    if (!lines) return;
    render(lines);
    const line = findLine(lines, position.lineNumber);
    if (line === null) return;
    editor.setPosition({ lineNumber: line, column: 1 });
    editor.revealLineInCenter(line);
  };

  const controller: BookmarkController = {
    setBuffer: (nextBufferId) => {
      if (disposed) return;
      if (decorationIds.length > 0) {
        decorationIds = editor.deltaDecorations(decorationIds, []);
      }
      activeBufferId = nextBufferId;
      const lines = currentLines();
      if (lines) render(lines);
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      if (decorationIds.length > 0) {
        decorationIds = editor.deltaDecorations(decorationIds, []);
      }
      actionDisposables.forEach((disposable) => disposable.dispose());
    },
    getLines,
    toggleCurrentLine,
    next: () => navigate(nextBookmarkLine),
    previous: () => navigate(previousBookmarkLine),
    clear: () => {
      if (disposed) return;
      const model = editor.getModel();
      if (!model) return;
      const lines = normalizeBookmarkLines([], model.getLineCount());
      linesByBuffer.set(activeBufferId, lines);
      render(lines);
    },
  };

  const actionDisposables = [
    editor.addAction({
      id: "ccie.editor.bookmark.toggle",
      label: "Toggle Bookmark",
      contextMenuGroupId: "2_powerEditing",
      run: () => controller.toggleCurrentLine(),
    }),
    editor.addAction({
      id: "ccie.editor.bookmark.next",
      label: "Next Bookmark",
      contextMenuGroupId: "2_powerEditing",
      run: () => controller.next(),
    }),
    editor.addAction({
      id: "ccie.editor.bookmark.previous",
      label: "Previous Bookmark",
      contextMenuGroupId: "2_powerEditing",
      run: () => controller.previous(),
    }),
    editor.addAction({
      id: "ccie.editor.bookmark.clear",
      label: "Clear All Bookmarks",
      contextMenuGroupId: "2_powerEditing",
      run: () => controller.clear(),
    }),
  ];

  return controller;
}

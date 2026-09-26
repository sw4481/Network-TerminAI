import type * as Monaco from "monaco-editor";
import { describe, expect, it, vi } from "vitest";

import {
  createEditorMacroController,
  type EditorMacroController,
  type MacroEdit,
} from "./editorMacro";

function createEditor(
  executeEdits = vi.fn(),
) {
  const actionDisposables: Array<ReturnType<typeof vi.fn>> = [];
  const editor = {
    addAction: vi.fn((descriptor: Monaco.editor.IActionDescriptor) => {
      const dispose = vi.fn();
      actionDisposables.push(dispose);
      return { descriptor, dispose };
    }),
    executeEdits,
  };

  return {
    actionDisposables,
    editor: editor as unknown as Monaco.editor.IStandaloneCodeEditor,
    rawEditor: editor,
  };
}

describe("editor macro controller", () => {
  it("records ordered model changes and replays them", () => {
    const { editor, rawEditor } = createEditor();
    const controller = createEditorMacroController(editor);
    const firstChange: MacroEdit = {
      range: {
        startLineNumber: 1,
        startColumn: 2,
        endLineNumber: 1,
        endColumn: 2,
      },
      text: "first",
    };
    const secondChange: MacroEdit = {
      range: {
        startLineNumber: 3,
        startColumn: 4,
        endLineNumber: 3,
        endColumn: 7,
      },
      text: "second",
      forceMoveMarkers: true,
    };

    controller.start();
    controller.recordChanges([firstChange]);
    controller.recordChanges([secondChange]);
    controller.stop();
    firstChange.range.startColumn = 99;
    secondChange.text = "mutated";

    controller.replay();

    expect(rawEditor.executeEdits).toHaveBeenCalledOnce();
    expect(rawEditor.executeEdits).toHaveBeenCalledWith("editor-macro", [
      {
        range: {
          startLineNumber: 1,
          startColumn: 2,
          endLineNumber: 1,
          endColumn: 2,
        },
        text: "first",
      },
      {
        range: {
          startLineNumber: 3,
          startColumn: 4,
          endLineNumber: 3,
          endColumn: 7,
        },
        text: "second",
        forceMoveMarkers: true,
      },
    ]);
  });

  it("does not append replayed changes and clear removes the macro", () => {
    let controller: EditorMacroController;
    const executeEdits = vi.fn(
      (_source: string, edits: readonly MacroEdit[]) => {
        controller.recordChanges(edits);
      },
    );
    const { editor } = createEditor(executeEdits);
    controller = createEditorMacroController(editor);
    const change: MacroEdit = {
      range: {
        startLineNumber: 2,
        startColumn: 1,
        endLineNumber: 2,
        endColumn: 1,
      },
      text: "only",
    };

    controller.start();
    controller.recordChanges([change]);
    controller.stop();
    controller.replay();
    controller.replay();

    expect(executeEdits).toHaveBeenCalledTimes(2);
    expect(executeEdits.mock.calls[1]?.[1]).toEqual([change]);

    controller.clear();
    expect(controller.hasMacro()).toBe(false);
    controller.replay();
    expect(executeEdits).toHaveBeenCalledTimes(2);
  });

  it("disposes every macro action exactly once", () => {
    const { actionDisposables, editor } = createEditor();
    const controller = createEditorMacroController(editor);

    controller.dispose();
    controller.dispose();

    expect(actionDisposables).toHaveLength(4);
    actionDisposables.forEach((dispose) => {
      expect(dispose).toHaveBeenCalledOnce();
    });
  });
});

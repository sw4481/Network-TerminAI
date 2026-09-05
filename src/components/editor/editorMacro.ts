import type * as Monaco from "monaco-editor";

export type MacroPosition = {
  lineNumber: number;
  column: number;
};

export type MacroEdit = {
  range: {
    startLineNumber: number;
    startColumn: number;
    endLineNumber: number;
    endColumn: number;
  };
  text: string;
  forceMoveMarkers?: boolean;
};

export type EditorMacroController = {
  start: () => void;
  stop: () => void;
  clear: () => void;
  recordChanges: (changes: readonly MacroEdit[]) => void;
  replay: () => void;
  isRecording: () => boolean;
  hasMacro: () => boolean;
  dispose: () => void;
};

export function createEditorMacroController(
  editor: Monaco.editor.IStandaloneCodeEditor,
): EditorMacroController {
  let recording = false;
  let replaying = false;
  let disposed = false;
  let pendingEdits: MacroEdit[] = [];
  let completedEdits: MacroEdit[] = [];

  const controller: EditorMacroController = {
    start: () => {
      if (disposed) return;
      pendingEdits = [];
      recording = true;
    },
    stop: () => {
      if (disposed || !recording) return;
      recording = false;
      completedEdits = pendingEdits;
      pendingEdits = [];
    },
    clear: () => {
      if (disposed) return;
      pendingEdits = [];
      completedEdits = [];
    },
    recordChanges: (changes) => {
      if (disposed || !recording || replaying) return;
      for (const change of changes) {
        const edit: MacroEdit = {
          range: {
            startLineNumber: change.range.startLineNumber,
            startColumn: change.range.startColumn,
            endLineNumber: change.range.endLineNumber,
            endColumn: change.range.endColumn,
          },
          text: change.text,
        };
        if (change.forceMoveMarkers !== undefined) {
          edit.forceMoveMarkers = change.forceMoveMarkers;
        }
        pendingEdits.push(edit);
      }
    },
    replay: () => {
      if (
        disposed ||
        recording ||
        replaying ||
        completedEdits.length === 0
      ) {
        return;
      }
      replaying = true;
      try {
        editor.executeEdits("editor-macro", completedEdits);
      } finally {
        replaying = false;
      }
    },
    isRecording: () => recording,
    hasMacro: () => completedEdits.length > 0,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      recording = false;
      pendingEdits = [];
      completedEdits = [];
      actionDisposables.forEach((disposable) => disposable.dispose());
    },
  };

  const actionDisposables = [
    editor.addAction({
      id: "ccie.editor.macro.start",
      label: "Start Macro Recording",
      contextMenuGroupId: "2_powerEditing",
      contextMenuOrder: 60,
      run: () => controller.start(),
    }),
    editor.addAction({
      id: "ccie.editor.macro.stop",
      label: "Stop Macro Recording",
      contextMenuGroupId: "2_powerEditing",
      contextMenuOrder: 61,
      run: () => controller.stop(),
    }),
    editor.addAction({
      id: "ccie.editor.macro.replay",
      label: "Replay Last Macro",
      contextMenuGroupId: "2_powerEditing",
      contextMenuOrder: 62,
      run: () => controller.replay(),
    }),
    editor.addAction({
      id: "ccie.editor.macro.clear",
      label: "Clear Macro",
      contextMenuGroupId: "2_powerEditing",
      contextMenuOrder: 63,
      run: () => controller.clear(),
    }),
  ];

  return controller;
}

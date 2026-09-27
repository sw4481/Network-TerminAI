import type * as Monaco from "monaco-editor";

export type EditorDisposalOwnership = {
  editor: Monaco.editor.IStandaloneCodeEditor;
  claimFinalOwner: () => void;
  disposeIfUnclaimed: () => void;
  disposeRegistrations: () => void;
  disposeEditor: () => void;
};

export function createEditorDisposalOwnership(
  editor: Monaco.editor.IStandaloneCodeEditor,
  cleanupRegistrations: () => void,
  clearEditor: () => void,
): EditorDisposalOwnership {
  let finalOwnerClaimed = false;
  let registrationsDisposed = false;
  let editorDisposed = false;

  const disposeRegistrations = () => {
    if (registrationsDisposed) return;
    registrationsDisposed = true;
    cleanupRegistrations();
  };

  const disposeEditor = () => {
    if (editorDisposed) return;
    editorDisposed = true;
    try {
      editor.dispose();
    } finally {
      clearEditor();
    }
  };

  return {
    editor,
    claimFinalOwner: () => {
      finalOwnerClaimed = true;
    },
    disposeIfUnclaimed: () => {
      if (finalOwnerClaimed) return;
      try {
        disposeRegistrations();
      } finally {
        disposeEditor();
      }
    },
    disposeRegistrations,
    disposeEditor,
  };
}

import { emit } from "@tauri-apps/api/event";
import type * as Monaco from "monaco-editor";
import { EDITOR_WORKSPACE_SYMBOL_SEARCH_EVENT } from "./lsp/locationRouting";

function runEditorAction(
  editor: Monaco.editor.IStandaloneCodeEditor,
  actionId: string,
): Promise<void> {
  const action = editor.getAction(actionId);
  return action ? action.run() : Promise.resolve();
}

function isOwnedZedChord(event: KeyboardEvent): boolean {
  const isMac = navigator.platform.toUpperCase().includes("MAC");
  const primary = isMac ? event.metaKey : event.ctrlKey;
  const secondary = isMac ? event.ctrlKey : event.metaKey;
  const keyP = event.code === "KeyP" || event.key.toLowerCase() === "p";
  const keyD = event.code === "KeyD" || event.key.toLowerCase() === "d";
  const keyT = event.code === "KeyT" || event.key.toLowerCase() === "t";
  const upArrow = event.code === "ArrowUp" || event.key === "ArrowUp";
  const downArrow = event.code === "ArrowDown" || event.key === "ArrowDown";
  const verticalArrow = upArrow || downArrow;

  if (secondary) return false;

  return (
    (primary && event.shiftKey && !event.altKey && keyP) ||
    (primary && !event.shiftKey && !event.altKey && keyD) ||
    (primary && !event.shiftKey && !event.altKey && keyT) ||
    (primary && event.altKey && !event.shiftKey && verticalArrow) ||
    (!primary && event.altKey && verticalArrow)
  );
}

export function installZedKeybindings(
  editor: Monaco.editor.IStandaloneCodeEditor,
  monaco: typeof Monaco,
): Monaco.IDisposable {
  const actions: Monaco.IDisposable[] = [
    editor.addAction({
      id: "ccie.zed.commandPalette",
      label: "Zed: Command Palette",
      keybindings: [
        monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyP,
      ],
      run: () => emit("menu:open_palette"),
    }),
    editor.addAction({
      id: "ccie.zed.workspaceSymbols",
      label: "Zed: Go to Symbol in Project",
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyT],
      run: () => {
        window.dispatchEvent(
          new CustomEvent(EDITOR_WORKSPACE_SYMBOL_SEARCH_EVENT, {
            detail: { source: editor.getContainerDomNode() },
          }),
        );
      },
    }),
    editor.addAction({
      id: "ccie.zed.addSelectionNext",
      label: "Zed: Add Selection to Next Match",
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyD],
      run: () =>
        runEditorAction(editor, "editor.action.addSelectionToNextFindMatch"),
    }),
    editor.addAction({
      id: "ccie.zed.cursorAbove",
      label: "Zed: Add Cursor Above",
      keybindings: [
        monaco.KeyMod.CtrlCmd | monaco.KeyMod.Alt | monaco.KeyCode.UpArrow,
      ],
      run: () => runEditorAction(editor, "editor.action.insertCursorAbove"),
    }),
    editor.addAction({
      id: "ccie.zed.cursorBelow",
      label: "Zed: Add Cursor Below",
      keybindings: [
        monaco.KeyMod.CtrlCmd | monaco.KeyMod.Alt | monaco.KeyCode.DownArrow,
      ],
      run: () => runEditorAction(editor, "editor.action.insertCursorBelow"),
    }),
    editor.addAction({
      id: "ccie.zed.moveLineUp",
      label: "Zed: Move Line Up",
      keybindings: [monaco.KeyMod.Alt | monaco.KeyCode.UpArrow],
      run: () => runEditorAction(editor, "editor.action.moveLinesUpAction"),
    }),
    editor.addAction({
      id: "ccie.zed.moveLineDown",
      label: "Zed: Move Line Down",
      keybindings: [monaco.KeyMod.Alt | monaco.KeyCode.DownArrow],
      run: () => runEditorAction(editor, "editor.action.moveLinesDownAction"),
    }),
    editor.addAction({
      id: "ccie.zed.duplicateLineUp",
      label: "Zed: Duplicate Line Up",
      keybindings: [
        monaco.KeyMod.Alt | monaco.KeyMod.Shift | monaco.KeyCode.UpArrow,
      ],
      run: () => runEditorAction(editor, "editor.action.copyLinesUpAction"),
    }),
    editor.addAction({
      id: "ccie.zed.duplicateLineDown",
      label: "Zed: Duplicate Line Down",
      keybindings: [
        monaco.KeyMod.Alt | monaco.KeyMod.Shift | monaco.KeyCode.DownArrow,
      ],
      run: () => runEditorAction(editor, "editor.action.copyLinesDownAction"),
    }),
  ];

  const container = editor.getContainerDomNode();
  const keyListener = (event: KeyboardEvent) => {
    if (!isOwnedZedChord(event)) return;
    event.preventDefault();
    event.stopPropagation();
  };
  container.addEventListener("keydown", keyListener);

  return {
    dispose() {
      container.removeEventListener("keydown", keyListener);
      actions.forEach((action) => action.dispose());
    },
  };
}

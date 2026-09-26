import type * as Monaco from "monaco-editor";

export type PowerEditingAction = {
  id: string;
  label: string;
  commandId: string;
  order: number;
};

export const POWER_EDITING_ACTIONS: readonly PowerEditingAction[] = [
  { id: "multicursor-lines", label: "Add Cursors to Selected Lines", commandId: "editor.action.insertCursorAtEndOfEachLineSelected", order: 1 },
  { id: "multicursor-top", label: "Add Cursor Above", commandId: "editor.action.addCursorsToTop", order: 2 },
  { id: "multicursor-bottom", label: "Add Cursor Below", commandId: "editor.action.addCursorsToBottom", order: 3 },
  { id: "copy-lines-up", label: "Copy Lines Up", commandId: "editor.action.copyLinesUpAction", order: 10 },
  { id: "copy-lines-down", label: "Copy Lines Down", commandId: "editor.action.copyLinesDownAction", order: 11 },
  { id: "move-lines-up", label: "Move Lines Up", commandId: "editor.action.moveLinesUpAction", order: 12 },
  { id: "move-lines-down", label: "Move Lines Down", commandId: "editor.action.moveLinesDownAction", order: 13 },
  { id: "delete-lines", label: "Delete Lines", commandId: "editor.action.deleteLines", order: 14 },
  { id: "duplicate-selection", label: "Duplicate Selection", commandId: "editor.action.duplicateSelection", order: 15 },
  { id: "join-lines", label: "Join Lines", commandId: "editor.action.joinLines", order: 16 },
  { id: "indent-lines", label: "Indent Lines", commandId: "editor.action.indentLines", order: 20 },
  { id: "outdent-lines", label: "Outdent Lines", commandId: "editor.action.outdentLines", order: 21 },
  { id: "reindent-selection", label: "Reindent Selected Lines", commandId: "editor.action.reindentselectedlines", order: 22 },
  { id: "sort-ascending", label: "Sort Lines Ascending", commandId: "editor.action.sortLinesAscending", order: 30 },
  { id: "sort-descending", label: "Sort Lines Descending", commandId: "editor.action.sortLinesDescending", order: 31 },
  { id: "remove-duplicates", label: "Remove Duplicate Lines", commandId: "editor.action.removeDuplicateLines", order: 32 },
  { id: "trim-whitespace", label: "Trim Trailing Whitespace", commandId: "editor.action.trimTrailingWhitespace", order: 33 },
  { id: "uppercase", label: "Transform to Uppercase", commandId: "editor.action.transformToUppercase", order: 40 },
  { id: "lowercase", label: "Transform to Lowercase", commandId: "editor.action.transformToLowercase", order: 41 },
  { id: "fold", label: "Fold", commandId: "editor.fold", order: 50 },
  { id: "unfold", label: "Unfold", commandId: "editor.unfold", order: 51 },
  { id: "fold-all", label: "Fold All", commandId: "editor.foldAll", order: 52 },
  { id: "unfold-all", label: "Unfold All", commandId: "editor.unfoldAll", order: 53 },
];

export function registerPowerEditingActions(
  editor: Monaco.editor.IStandaloneCodeEditor,
): Monaco.IDisposable {
  const registrations = POWER_EDITING_ACTIONS.map((action) =>
    editor.addAction({
      id: `ccie.editor.powerEditing.${action.id}`,
      label: action.label,
      contextMenuGroupId: "2_powerEditing",
      contextMenuOrder: action.order,
      run: (target) => target.trigger("power-editing", action.commandId, undefined),
    }),
  );
  return { dispose: () => registrations.forEach((registration) => registration.dispose()) };
}

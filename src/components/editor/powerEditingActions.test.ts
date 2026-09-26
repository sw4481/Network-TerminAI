import { describe, expect, it, vi } from "vitest";
import type * as Monaco from "monaco-editor";

import {
  POWER_EDITING_ACTIONS,
  registerPowerEditingActions,
} from "./powerEditingActions";

describe("power editing actions", () => {
  it("contains only verified Monaco command ids", () => {
    expect(POWER_EDITING_ACTIONS.map((action) => action.commandId)).toEqual([
      "editor.action.insertCursorAtEndOfEachLineSelected",
      "editor.action.addCursorsToTop",
      "editor.action.addCursorsToBottom",
      "editor.action.copyLinesUpAction",
      "editor.action.copyLinesDownAction",
      "editor.action.moveLinesUpAction",
      "editor.action.moveLinesDownAction",
      "editor.action.deleteLines",
      "editor.action.duplicateSelection",
      "editor.action.joinLines",
      "editor.action.indentLines",
      "editor.action.outdentLines",
      "editor.action.reindentselectedlines",
      "editor.action.sortLinesAscending",
      "editor.action.sortLinesDescending",
      "editor.action.removeDuplicateLines",
      "editor.action.trimTrailingWhitespace",
      "editor.action.transformToUppercase",
      "editor.action.transformToLowercase",
      "editor.fold",
      "editor.unfold",
      "editor.foldAll",
      "editor.unfoldAll",
    ]);
  });

  it("registers labeled actions that delegate to Monaco", () => {
    const addAction = vi.fn((descriptor) => ({ dispose: vi.fn(), descriptor }));
    const trigger = vi.fn();
    const editor = { addAction, trigger } as unknown as Monaco.editor.IStandaloneCodeEditor;

    const registration = registerPowerEditingActions(editor);
    const descriptor = addAction.mock.calls[0][0] as any;
    descriptor.run(editor);

    expect(descriptor.contextMenuGroupId).toBe("2_powerEditing");
    expect(trigger).toHaveBeenCalledWith(
      "power-editing",
      POWER_EDITING_ACTIONS[0].commandId,
      undefined,
    );
    registration.dispose();
    expect(addAction.mock.results[0].value.dispose).toHaveBeenCalledOnce();
  });
});

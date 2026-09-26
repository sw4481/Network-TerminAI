import { describe, expect, it, vi } from "vitest";
import type * as Monaco from "monaco-editor";
import { createEditorDisposalOwnership } from "./monacoEditorOwnership";

function mockEditor(dispose: () => void) {
  return { dispose } as unknown as Monaco.editor.IStandaloneCodeEditor;
}

describe("Monaco editor disposal ownership", () => {
  it("disposes registrations and the editor when teardown wins the state race", () => {
    const events: string[] = [];
    const disposeRegistrations = vi.fn(() => events.push("registrations"));
    const disposeEditor = vi.fn(() => events.push("editor"));
    const clearEditor = vi.fn(() => events.push("clear"));
    const ownership = createEditorDisposalOwnership(
      mockEditor(disposeEditor),
      disposeRegistrations,
      clearEditor,
    );

    ownership.disposeIfUnclaimed();
    ownership.disposeIfUnclaimed();
    ownership.disposeRegistrations();
    ownership.disposeEditor();

    expect(disposeRegistrations).toHaveBeenCalledOnce();
    expect(disposeEditor).toHaveBeenCalledOnce();
    expect(clearEditor).toHaveBeenCalledOnce();
    expect(events).toEqual(["registrations", "editor", "clear"]);
  });

  it("leaves a claimed editor intact until ordered effect cleanup disposes it", () => {
    const disposeRegistrations = vi.fn();
    const disposeEditor = vi.fn();
    const clearEditor = vi.fn();
    const ownership = createEditorDisposalOwnership(
      mockEditor(disposeEditor),
      disposeRegistrations,
      clearEditor,
    );

    ownership.claimFinalOwner();
    ownership.disposeIfUnclaimed();

    expect(disposeRegistrations).not.toHaveBeenCalled();
    expect(disposeEditor).not.toHaveBeenCalled();

    ownership.disposeRegistrations();
    ownership.disposeEditor();
    ownership.disposeIfUnclaimed();

    expect(disposeRegistrations).toHaveBeenCalledOnce();
    expect(disposeEditor).toHaveBeenCalledOnce();
    expect(clearEditor).toHaveBeenCalledOnce();
  });

  it("releases model ownership only after registrations and editor disposal", () => {
    const events: string[] = [];
    const ownership = createEditorDisposalOwnership(
      mockEditor(() => events.push("editor")),
      () => events.push("registrations"),
      () => events.push("model"),
    );

    ownership.claimFinalOwner();
    ownership.disposeRegistrations();
    ownership.disposeEditor();

    expect(events).toEqual(["registrations", "editor", "model"]);
  });
});

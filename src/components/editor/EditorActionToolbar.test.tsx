import type { ComponentProps } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { EditorActionToolbar } from "./EditorActionToolbar";

type ToolbarEditor = NonNullable<ComponentProps<typeof EditorActionToolbar>["editor"]>;

function editorStub() {
  return {
    focus: vi.fn(),
    trigger: vi.fn(),
    getAction: vi.fn((id: string) => ({
      id,
      label: id,
      alias: id,
      metadata: null,
      isSupported: () => true,
      run: vi.fn().mockResolvedValue(id),
    })),
  } as unknown as ToolbarEditor & {
    focus: ReturnType<typeof vi.fn>;
    trigger: ReturnType<typeof vi.fn>;
    getAction: ReturnType<typeof vi.fn>;
  };
}

describe("EditorActionToolbar", () => {
  it("renders dense Notepad-style action groups", () => {
    render(
      <EditorActionToolbar
        editor={null}
        canSave={false}
        onSave={vi.fn()}
        onOpenWorkspace={vi.fn()}
      />,
    );

    expect(screen.getByRole("toolbar", { name: "Editor actions" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "File actions" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Edit actions" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Search actions" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Code actions" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Undo" })).toBeDisabled();
  });

  it("routes Monaco-backed buttons through the focused editor", () => {
    const editor = editorStub();
    render(
      <EditorActionToolbar
        editor={editor}
        canSave
        onSave={vi.fn()}
        onOpenWorkspace={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Find" }));
    fireEvent.click(screen.getByRole("button", { name: "Format document" }));
    fireEvent.click(screen.getByRole("button", { name: "Fold all" }));

    expect(editor.trigger).toHaveBeenCalledWith("toolbar", "actions.find", null);
    expect(editor.getAction).toHaveBeenCalledWith("editor.action.formatDocument");
    expect(editor.getAction).toHaveBeenCalledWith("editor.foldAll");
    expect(editor.focus).toHaveBeenCalled();
  });

  it("runs supplied app callbacks beside editor commands", () => {
    const onSave = vi.fn();
    const onWorkspaceFind = vi.fn();
    const onToggleExplorer = vi.fn();
    render(
      <EditorActionToolbar
        editor={editorStub()}
        canSave
        onSave={onSave}
        onOpenWorkspace={vi.fn()}
        onWorkspaceFind={onWorkspaceFind}
        onToggleExplorer={onToggleExplorer}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    fireEvent.click(screen.getByRole("button", { name: "Workspace search" }));
    fireEvent.click(screen.getByRole("button", { name: "Toggle explorer" }));

    expect(onSave).toHaveBeenCalledOnce();
    expect(onWorkspaceFind).toHaveBeenCalledOnce();
    expect(onToggleExplorer).toHaveBeenCalledOnce();
  });
});

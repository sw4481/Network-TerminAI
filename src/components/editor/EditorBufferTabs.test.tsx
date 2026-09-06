import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { EditorBufferState } from "../../state/editorStore";
import { confirmEditorBufferClose, EditorBufferTabs } from "./EditorBufferTabs";

function buffer(
  id: string,
  filePath: string,
  dirty = false,
): EditorBufferState {
  return {
    id,
    file_path: filePath,
    content: "",
    language: "python",
    cisco_platform: null,
    is_dirty: dirty,
    revision: 0,
    sync_status: "synced",
    error: null,
  };
}

describe("EditorBufferTabs", () => {
  it("keeps every open file available and activates the selected file", () => {
    const onSelect = vi.fn();
    render(
      <EditorBufferTabs
        buffers={[
          buffer("file:/repo/main.py", "/repo/main.py"),
          buffer("file:/repo/helper.py", "/repo/helper.py", true),
        ]}
        activeBufferId="file:/repo/main.py"
        onSelect={onSelect}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getAllByRole("tab")).toHaveLength(2);
    expect(screen.getByRole("tab", { name: "main.py" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    fireEvent.click(screen.getByRole("tab", { name: /helper.py/ }));
    expect(onSelect).toHaveBeenCalledWith("file:/repo/helper.py");
  });

  it("renders a close button for each tab without activating that tab", () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    render(
      <EditorBufferTabs
        buffers={[
          buffer("file:/repo/main.py", "/repo/main.py"),
          buffer("file:/repo/helper.py", "/repo/helper.py", true),
        ]}
        activeBufferId="file:/repo/main.py"
        onSelect={onSelect}
        onClose={onClose}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Close helper.py" }));

    expect(onClose).toHaveBeenCalledWith("file:/repo/helper.py");
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("asks before discarding a dirty tab but closes a clean tab directly", () => {
    const confirmDiscard = vi.fn(() => false);
    const dirty = buffer("file:/repo/helper.py", "/repo/helper.py", true);
    const clean = buffer("file:/repo/main.py", "/repo/main.py");

    expect(confirmEditorBufferClose(dirty, confirmDiscard)).toBe(false);
    expect(confirmDiscard).toHaveBeenCalledWith(
      'Close "helper.py" without saving your changes?',
    );
    confirmDiscard.mockClear();
    expect(confirmEditorBufferClose(clean, confirmDiscard)).toBe(true);
    expect(confirmDiscard).not.toHaveBeenCalled();
  });
});

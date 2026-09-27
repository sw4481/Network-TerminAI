import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { GitDiffPayload } from "../../lib/tauri";
import { GitDiffReview } from "./GitDiffReview";

vi.mock("@monaco-editor/react", () => ({
  DiffEditor: ({
    original,
    modified,
    options,
  }: {
    original: string;
    modified: string;
    options: { renderSideBySide?: boolean };
  }) => (
    <div
      data-testid="mock-diff-editor"
      data-side-by-side={String(options.renderSideBySide)}
    >
      {original}→{modified}
    </div>
  ),
}));

function payload(overrides: Partial<GitDiffPayload> = {}): GitDiffPayload {
  return {
    originalLabel: "HEAD: file.ts",
    modifiedLabel: "Index: file.ts",
    original: "old",
    modified: "new",
    language: "typescript",
    binary: false,
    oversized: false,
    originalSize: 3,
    modifiedSize: 3,
    ...overrides,
  };
}

describe("GitDiffReview", () => {
  it("renders Monaco split and unified review without touching editor layout", () => {
    const onStyleChange = vi.fn();
    const onClose = vi.fn();
    const { rerender } = render(
      <GitDiffReview
        path="file.ts"
        payload={payload()}
        style="split"
        onStyleChange={onStyleChange}
        onClose={onClose}
      />,
    );

    expect(screen.getByTestId("mock-diff-editor")).toHaveAttribute(
      "data-side-by-side",
      "true",
    );
    fireEvent.click(screen.getByRole("button", { name: "Unified" }));
    expect(onStyleChange).toHaveBeenCalledWith("unified");

    rerender(
      <GitDiffReview
        path="file.ts"
        payload={payload()}
        style="unified"
        onStyleChange={onStyleChange}
        onClose={onClose}
      />,
    );
    expect(screen.getByTestId("mock-diff-editor")).toHaveAttribute(
      "data-side-by-side",
      "false",
    );
    fireEvent.click(screen.getByRole("button", { name: "Close Git diff" }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("shows an explanatory non-text state for binary and oversized files", () => {
    const { rerender } = render(
      <GitDiffReview
        path="image.bin"
        payload={payload({ binary: true, original: null, modified: null })}
        style="split"
        onStyleChange={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("Binary file");
    expect(screen.queryByTestId("mock-diff-editor")).not.toBeInTheDocument();

    rerender(
      <GitDiffReview
        path="large.txt"
        payload={payload({
          oversized: true,
          original: null,
          modified: null,
          originalSize: 3_145_728,
        })}
        style="unified"
        onStyleChange={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "File is too large for text diff",
    );
  });
});

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { GitRepositorySummary } from "../../lib/tauri";
import { GitStatusIndicator } from "./GitStatusIndicator";

function summary(
  overrides: Partial<GitRepositorySummary> = {},
): GitRepositorySummary {
  return {
    repoRoot: "/repo",
    branch: "main",
    headOid: "abcdef0123456789",
    dirty: false,
    changedFiles: 0,
    stagedFiles: 0,
    unstagedFiles: 0,
    untrackedFiles: 0,
    ...overrides,
  };
}

describe("GitStatusIndicator", () => {
  it("renders a clean branch", () => {
    render(<GitStatusIndicator summary={summary()} />);

    expect(screen.getByTestId("editor-git-status")).toHaveTextContent(
      "⎇mainClean",
    );
    expect(screen.getByTestId("editor-git-status")).toHaveAttribute(
      "data-dirty",
      "false",
    );
  });

  it("includes unsaved editor state in the dirty indicator", () => {
    render(<GitStatusIndicator summary={summary()} bufferDirty />);

    expect(screen.getByTestId("editor-git-status")).toHaveTextContent(
      "1 changed",
    );
    expect(screen.getByTestId("editor-git-status")).toHaveAttribute(
      "data-dirty",
      "true",
    );
  });

  it("falls back to a short oid for detached HEAD", () => {
    render(
      <GitStatusIndicator
        summary={summary({ branch: null, dirty: true, changedFiles: 2 })}
      />,
    );

    expect(screen.getByTestId("editor-git-status")).toHaveTextContent(
      "abcdef0",
    );
    expect(screen.getByTestId("editor-git-status")).toHaveAttribute(
      "title",
      expect.stringContaining("Detached HEAD"),
    );
  });

  it("shows an unborn repository honestly", () => {
    render(
      <GitStatusIndicator
        summary={summary({ branch: "main", headOid: null })}
      />,
    );

    expect(screen.getByTestId("editor-git-status")).toHaveTextContent(
      "No commits",
    );
  });

  it("renders nothing outside a repository", () => {
    const { container } = render(<GitStatusIndicator summary={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("remains clickable without a repository so setup stays reachable", () => {
    const onToggle = vi.fn();
    render(
      <GitStatusIndicator
        summary={null}
        onToggle={onToggle}
        panelOpen
      />,
    );

    const button = screen.getByRole("button", {
      name: "Git panel, No repository",
    });
    expect(button).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(button);
    expect(onToggle).toHaveBeenCalledOnce();
  });
});

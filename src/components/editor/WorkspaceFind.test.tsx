import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const editorFindInFiles = vi.hoisted(() => vi.fn());

vi.mock("../../lib/tauri", () => ({ editorFindInFiles }));

import { WorkspaceFind } from "./WorkspaceFind";

describe("WorkspaceFind", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("requires a workspace before searching", () => {
    render(
      <WorkspaceFind rootPath={null} onClose={vi.fn()} onOpenResult={vi.fn()} />,
    );

    expect(screen.getByRole("button", { name: "Search" })).toBeDisabled();
    expect(
      screen.getByText("Select a workspace folder before searching."),
    ).toBeInTheDocument();
  });

  it("submits options and renders clickable results", async () => {
    const user = userEvent.setup();
    const onOpenResult = vi.fn();
    editorFindInFiles.mockResolvedValue([
      {
        file_path: "/repo/configs/router.cfg",
        line: 12,
        column: 7,
        preview: " description uplink",
      },
    ]);
    render(
      <WorkspaceFind
        rootPath="/repo"
        onClose={vi.fn()}
        onOpenResult={onOpenResult}
      />,
    );

    await user.type(screen.getByLabelText("Search query"), "interface");
    await user.type(
      screen.getByLabelText("File pattern"),
      "*.txt,router.cfg",
    );
    await user.click(screen.getByLabelText("Match case"));
    await user.click(screen.getByLabelText("Regular expression"));

    expect(screen.getByLabelText("Whole word")).toBeDisabled();
    expect(
      screen.getByText("Whole word is unavailable with regular expressions."),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Search" }));

    await waitFor(() =>
      expect(editorFindInFiles).toHaveBeenCalledWith({
        workspaceRoot: "/repo",
        query: "interface",
        regex: true,
        matchCase: true,
        wholeWord: false,
        filePattern: "*.txt,router.cfg",
        maxResults: 5000,
      }),
    );

    const result = await screen.findByRole("button", {
      name: /router\.cfg.*12:7.*description uplink/i,
    });
    await user.click(result);

    expect(onOpenResult).toHaveBeenCalledWith(
      "/repo/configs/router.cfg",
      { line: 12, column: 7 },
    );
  });

  it("clears stale results when the search fails", async () => {
    const user = userEvent.setup();
    editorFindInFiles.mockResolvedValueOnce([
      {
        file_path: "/repo/stale.txt",
        line: 2,
        column: 3,
        preview: "stale result",
      },
    ]);
    render(
      <WorkspaceFind
        rootPath="/repo"
        onClose={vi.fn()}
        onOpenResult={vi.fn()}
      />,
    );

    const query = screen.getByLabelText("Search query");
    await user.type(query, "first");
    await user.click(screen.getByRole("button", { name: "Search" }));
    expect(await screen.findByText("stale result")).toBeInTheDocument();

    editorFindInFiles.mockRejectedValueOnce(new Error("Search failed"));
    await user.clear(query);
    await user.type(query, "second");
    await user.click(screen.getByRole("button", { name: "Search" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Search failed");
    expect(screen.queryByText("stale result")).not.toBeInTheDocument();
  });
});

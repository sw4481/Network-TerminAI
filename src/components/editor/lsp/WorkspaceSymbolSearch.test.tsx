import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const sendRequest = vi.hoisted(() => vi.fn());

vi.mock("../../../hooks/useLspClient", () => ({
  normalizeLspLanguage: (language: string) =>
    language === "python" ? "python" : null,
  useLspClient: () => ({
    clientId: "symbols",
    ready: true,
    serverName: "Pyright",
    error: null,
    sendRequest,
    openDocument: vi.fn(),
    changeDocument: vi.fn(),
    closeDocument: vi.fn(),
  }),
}));

import {
  normalizeWorkspaceSymbols,
  WorkspaceSymbolSearch,
} from "./WorkspaceSymbolSearch";

const symbols = [
  {
    name: "Router",
    kind: 5,
    containerName: "network",
    location: {
      uri: "file:///repo/network/router.py",
      range: {
        start: { line: 4, character: 0 },
        end: { line: 8, character: 1 },
      },
    },
  },
];

describe("WorkspaceSymbolSearch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sendRequest.mockResolvedValue(symbols);
  });

  it("normalizes only symbols inside the workspace", () => {
    expect(
      normalizeWorkspaceSymbols(
        [
          ...symbols,
          {
            ...symbols[0],
            name: "Outside",
            location: {
              ...symbols[0].location,
              uri: "file:///other/outside.py",
            },
          },
        ],
        "/repo",
      ),
    ).toEqual([
      expect.objectContaining({
        name: "Router",
        kindLabel: "Class",
        filePath: "/repo/network/router.py",
        displayPath: "network/router.py",
      }),
    ]);
  });

  it("searches and selects a project symbol with Enter", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const onClose = vi.fn();
    render(
      <WorkspaceSymbolSearch
        open
        language="python"
        workspaceRoot="/repo"
        onClose={onClose}
        onSelect={onSelect}
      />,
    );

    await user.type(screen.getByLabelText("Project symbol query"), "Rou");
    await waitFor(() =>
      expect(sendRequest).toHaveBeenLastCalledWith("workspace/symbol", {
        query: "Rou",
      }),
    );
    expect(await screen.findByText("Router")).toBeInTheDocument();
    fireEvent.keyDown(screen.getByLabelText("Project symbol query"), {
      key: "Enter",
    });
    await waitFor(() =>
      expect(onSelect).toHaveBeenCalledWith(
        expect.objectContaining({ name: "Router" }),
      ),
    );
    expect(onClose).toHaveBeenCalled();
  });
});

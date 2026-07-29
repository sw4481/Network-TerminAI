import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  mode: "monaco" as "monaco" | "zed",
  vimEnabled: false,
  setMode: vi.fn(),
  setVimEnabled: vi.fn(),
}));

vi.mock("../editor/ZedModeProvider", () => ({
  useZedMode: () => state,
}));

import EditorSettingsTab from "./EditorSettingsTab";

describe("EditorSettingsTab", () => {
  beforeEach(() => {
    state.mode = "monaco";
    state.vimEnabled = false;
    state.setMode.mockReset().mockResolvedValue(undefined);
    state.setVimEnabled.mockReset().mockResolvedValue(undefined);
  });

  it("selects Zed Mode through the provider", async () => {
    render(<EditorSettingsTab />);
    fireEvent.click(screen.getByRole("button", { name: "Zed Mode" }));
    await waitFor(() => expect(state.setMode).toHaveBeenCalledWith("zed"));
  });

  it("disables Vim in classic mode and writes it in Zed Mode", async () => {
    const classic = render(<EditorSettingsTab />);
    expect(screen.getByRole("checkbox", { name: "Vim mode" })).toBeDisabled();
    classic.unmount();

    state.mode = "zed";
    render(<EditorSettingsTab />);
    fireEvent.click(screen.getByRole("checkbox", { name: "Vim mode" }));
    await waitFor(() => expect(state.setVimEnabled).toHaveBeenCalledWith(true));
  });

  it("shows a persistence error without claiming the new mode", async () => {
    state.setMode.mockRejectedValueOnce(new Error("database locked"));
    render(<EditorSettingsTab />);
    fireEvent.click(screen.getByRole("button", { name: "Zed Mode" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("database locked");
    expect(screen.getByRole("button", { name: "Monaco (classic)" }))
      .toHaveAttribute("aria-pressed", "true");
  });
});

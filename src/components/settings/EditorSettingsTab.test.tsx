import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  mode: "monaco" as "monaco" | "zed",
  vimEnabled: false,
  setMode: vi.fn(),
  setVimEnabled: vi.fn(),
  settings: {
    schemaVersion: 1 as const,
    appTheme: "terminai-dark" as const,
    editorTheme: "follow-app" as const,
    terminal: {},
    effects: {},
  },
  appearanceSaving: false,
  appearanceError: null as string | null,
  previewSettings: vi.fn(),
  saveSettingsPatch: vi.fn(),
  setSettings: vi.fn(),
}));

vi.mock("../editor/ZedModeProvider", () => ({
  useZedMode: () => state,
}));

vi.mock("../../theme/AppearanceProvider", () => ({
  useAppearance: () => ({
    settings: state.settings,
    error: state.appearanceError,
    isSaving: state.appearanceSaving,
    previewSettings: state.previewSettings,
    saveSettingsPatch: state.saveSettingsPatch,
    setSettings: state.setSettings,
  }),
}));

import EditorSettingsTab from "./EditorSettingsTab";

describe("EditorSettingsTab", () => {
  beforeEach(() => {
    state.mode = "monaco";
    state.vimEnabled = false;
    state.setMode.mockReset().mockResolvedValue(undefined);
    state.setVimEnabled.mockReset().mockResolvedValue(undefined);
    state.settings.appTheme = "terminai-dark";
    state.settings.editorTheme = "follow-app";
    state.appearanceSaving = false;
    state.appearanceError = null;
    state.previewSettings.mockReset();
    state.saveSettingsPatch.mockReset().mockResolvedValue(undefined);
    state.setSettings.mockReset().mockResolvedValue(undefined);
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

  it("previews and saves an accessible explicit editor theme without changing Zed or Vim settings", async () => {
    state.mode = "zed";
    state.vimEnabled = true;
    render(<EditorSettingsTab />);

    expect(screen.getByRole("radio", { name: "Follow application theme" }))
      .toBeChecked();
    fireEvent.click(screen.getByRole("radio", { name: "Matrix" }));
    expect(state.previewSettings).toHaveBeenCalledWith(
      expect.objectContaining({ editorTheme: "matrix", appTheme: "terminai-dark" }),
    );
    expect(state.setMode).not.toHaveBeenCalled();
    expect(state.setVimEnabled).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Save editor appearance" }));
    await waitFor(() => expect(state.saveSettingsPatch).toHaveBeenCalledWith({
      editorTheme: "matrix",
    }));
    expect(state.setSettings).not.toHaveBeenCalled();
  });

  it("displays an appearance save failure returned by the provider", async () => {
    state.saveSettingsPatch.mockRejectedValueOnce(new Error("write failed"));
    render(<EditorSettingsTab />);
    fireEvent.click(screen.getByRole("button", { name: "Save editor appearance" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("write failed");
  });

  it("reports a saved-but-not-broadcast editor appearance as a sync warning", async () => {
    const warning =
      "Appearance saved, but other windows could not be notified: event bus unavailable";
    const view = render(<EditorSettingsTab />);

    fireEvent.click(screen.getByRole("button", { name: "Save editor appearance" }));
    await waitFor(() => expect(state.saveSettingsPatch).toHaveBeenCalledOnce());
    state.appearanceError = warning;
    view.rerender(<EditorSettingsTab />);

    expect(screen.getByRole("alert")).toHaveTextContent(warning);
    expect(screen.queryByText("Appearance was not saved.")).not.toBeInTheDocument();
  });

  it("saves only the editor patch when the application has an unsaved Matrix preview", async () => {
    state.settings.appTheme = "matrix";
    state.settings.editorTheme = "classic-dark";
    render(<EditorSettingsTab />);

    fireEvent.click(screen.getByRole("radio", { name: "Zed One Dark" }));
    fireEvent.click(screen.getByRole("button", { name: "Save editor appearance" }));

    await waitFor(() => expect(state.saveSettingsPatch).toHaveBeenCalledWith({
      editorTheme: "zed-one-dark",
    }));
    expect(state.saveSettingsPatch).not.toHaveBeenCalledWith(
      expect.objectContaining({ appTheme: "matrix" }),
    );
  });

  it("locks every editor appearance control while another appearance save is active", () => {
    state.appearanceSaving = true;
    render(<EditorSettingsTab />);

    for (const radio of screen.getAllByRole("radio")) expect(radio).toBeDisabled();
    expect(screen.getByRole("button", { name: "Save editor appearance" })).toBeDisabled();
  });
});

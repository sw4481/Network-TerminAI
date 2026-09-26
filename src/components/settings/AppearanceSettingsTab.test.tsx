import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDefaultAppearanceSettings } from "../../theme/defaults";
import type { AppearanceSettingsV1 } from "../../theme/types";

const appearance = vi.hoisted(() => ({
  settings: null as unknown as AppearanceSettingsV1,
  error: null as string | null,
  isSaving: false,
  previewSettings: vi.fn(),
  saveSettingsPatch: vi.fn(),
  setSettings: vi.fn(),
}));

vi.mock("../../theme/AppearanceProvider", () => ({
  useAppearance: () => appearance,
}));

import { AppearanceSettingsTab } from "./AppearanceSettingsTab";

describe("AppearanceSettingsTab", () => {
  beforeEach(() => {
    appearance.settings = createDefaultAppearanceSettings();
    appearance.error = null;
    appearance.isSaving = false;
    appearance.previewSettings.mockReset();
    appearance.saveSettingsPatch.mockReset().mockResolvedValue(undefined);
    appearance.setSettings.mockReset().mockResolvedValue(undefined);
  });

  it("previews all three accessible presets immediately without persisting", async () => {
    const user = userEvent.setup();
    render(<AppearanceSettingsTab />);

    const matrix = screen.getByRole("radio", { name: /Matrix/i });
    await user.click(matrix);
    expect(matrix).toBeChecked();
    expect(appearance.previewSettings).toHaveBeenCalledWith(expect.objectContaining({ appTheme: "matrix" }));
    expect(appearance.setSettings).not.toHaveBeenCalled();
    expect(screen.getByText(/Black surfaces with restrained phosphor-green accents/i)).toBeVisible();
  });

  it("saves the preview, resets to the safe default, and exposes save errors", async () => {
    const user = userEvent.setup();
    render(<AppearanceSettingsTab />);
    await user.click(screen.getByRole("radio", { name: /Slate Grey/i }));
    await user.click(screen.getByRole("button", { name: "Save appearance" }));
    expect(appearance.saveSettingsPatch).toHaveBeenCalledWith({
      appTheme: "slate-grey",
      effects: createDefaultAppearanceSettings().effects,
    });
    expect(appearance.setSettings).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Reset appearance" }));
    expect(appearance.previewSettings).toHaveBeenLastCalledWith(expect.objectContaining({ appTheme: "terminai-dark" }));

    appearance.error = "write failed";
    render(<AppearanceSettingsTab />);
    expect(screen.getByRole("alert")).toHaveTextContent("write failed");
  });

  it("keeps radios keyboard-operable and labels Matrix effect switches", async () => {
    const user = userEvent.setup();
    render(<AppearanceSettingsTab />);
    await user.tab();
    expect(screen.getByRole("radio", { name: /TerminAI Dark/i })).toHaveFocus();
    await user.keyboard("[ArrowRight]");
    expect(screen.getByRole("radio", { name: /Slate Grey/i })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: /Enable Matrix scanlines/i })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: /Enable Matrix glow/i })).toBeInTheDocument();
  });

  it("disables Matrix-only effects until Matrix is selected and explains why", async () => {
    const user = userEvent.setup();
    render(<AppearanceSettingsTab />);

    const scanlines = screen.getByRole("checkbox", { name: /Enable Matrix scanlines/i });
    const glow = screen.getByRole("checkbox", { name: /Enable Matrix glow/i });
    const motion = screen.getByRole("combobox", { name: /Matrix motion preference/i });
    expect(scanlines).toBeDisabled();
    expect(glow).toBeDisabled();
    expect(motion).toBeDisabled();
    expect(scanlines).toHaveAccessibleDescription(/Select Matrix/i);

    await user.click(screen.getByRole("radio", { name: /Matrix/i }));
    expect(scanlines).toBeEnabled();
    expect(glow).toBeEnabled();
    expect(motion).toBeEnabled();
  });

  it("disables duplicate saves and announces progress and success in text", async () => {
    let finishSave: (() => void) | undefined;
    appearance.saveSettingsPatch.mockImplementation(
      () => new Promise<void>((resolve) => {
        finishSave = resolve;
      }),
    );
    const user = userEvent.setup();
    render(<AppearanceSettingsTab />);

    const save = screen.getByRole("button", { name: "Save appearance" });
    await user.click(save);
    expect(save).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent("Saving appearance");

    finishSave?.();
    await screen.findByText("Appearance saved.");
    expect(save).toBeEnabled();
    expect(screen.getByRole("status")).toHaveTextContent("Appearance saved.");
  });

  it("locks every editable control and keeps the saving status truthful until persistence settles", async () => {
    let finishSave: (() => void) | undefined;
    appearance.saveSettingsPatch.mockImplementation(
      () => new Promise<void>((resolve) => {
        finishSave = resolve;
      }),
    );
    const user = userEvent.setup();
    render(<AppearanceSettingsTab />);

    await user.click(screen.getByRole("radio", { name: /Matrix/i }));
    const previewsBeforeSave = appearance.previewSettings.mock.calls.length;
    await user.click(screen.getByRole("button", { name: "Save appearance" }));

    const slate = screen.getByRole("radio", { name: /Slate Grey/i });
    for (const control of screen.getAllByRole("radio")) expect(control).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: /Enable Matrix scanlines/i })).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: /Enable Matrix glow/i })).toBeDisabled();
    expect(screen.getByRole("combobox", { name: /Matrix motion preference/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Reset appearance" })).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent("Saving appearance");

    await user.click(slate);
    await user.click(screen.getByRole("button", { name: "Reset appearance" }));
    expect(screen.getByRole("radio", { name: /Matrix/i })).toBeChecked();
    expect(appearance.previewSettings).toHaveBeenCalledTimes(previewsBeforeSave);
    expect(appearance.saveSettingsPatch).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("status")).toHaveTextContent("Saving appearance");

    finishSave?.();
    await screen.findByText("Appearance saved.");
  });

  it("keeps every appearance control keyboard reachable when Matrix is active", async () => {
    const user = userEvent.setup();
    render(<AppearanceSettingsTab />);
    await user.click(screen.getByRole("radio", { name: /Matrix/i }));

    const controls = [
      screen.getByRole("radio", { name: /TerminAI Dark/i }),
      screen.getByRole("checkbox", { name: /Enable Matrix scanlines/i }),
      screen.getByRole("checkbox", { name: /Enable Matrix glow/i }),
      screen.getByRole("combobox", { name: /Matrix motion preference/i }),
      screen.getByRole("button", { name: "Save appearance" }),
      screen.getByRole("button", { name: "Reset appearance" }),
    ];

    controls[0].focus();
    for (const expected of controls.slice(1)) {
      await user.tab();
      expect(expected).toHaveFocus();
    }
  });

  it("locks every appearance control while another settings tab is saving", () => {
    appearance.isSaving = true;
    render(<AppearanceSettingsTab />);

    for (const control of screen.getAllByRole("radio")) expect(control).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: /Enable Matrix scanlines/i })).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: /Enable Matrix glow/i })).toBeDisabled();
    expect(screen.getByRole("combobox", { name: /Matrix motion preference/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Save appearance" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Reset appearance" })).toBeDisabled();
  });
});

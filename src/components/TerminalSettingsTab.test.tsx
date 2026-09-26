import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { act, render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import TerminalSettingsTab from "./TerminalSettingsTab";
import * as paneActivityLib from "../lib/paneActivity";
import * as tauri from "../lib/tauri";
import { createDefaultAppearanceSettings } from "../theme/defaults";
import type { AppearanceSettingsV1 } from "../theme/types";

const appearance = vi.hoisted(() => ({
  settings: null as unknown as AppearanceSettingsV1,
  error: null as string | null,
  isSaving: false,
  hydrated: true,
  authoritativeState: "ready" as "pending" | "ready" | "failed",
  previewSettings: vi.fn(),
  saveSettingsPatch: vi.fn(),
  setSettings: vi.fn(),
  retryAuthoritativeSettings: vi.fn(),
}));

vi.mock("../theme/AppearanceProvider", () => ({
  useAppearance: () => appearance,
}));

const logLocations: tauri.LogLocations = {
  directory: "$HOME/Library/Application Support/ccie-terminal/logs",
  files: [
    {
      id: "application",
      label: "Application log",
      description: "Rust application and scheduler events",
      path: "$HOME/Library/Application Support/ccie-terminal/logs/ccie-terminal.2026-07-30.log",
      exists: true,
    },
    {
      id: "sandbox_incidents",
      label: "Sandbox incidents",
      description: "Sandbox timeout and automatic recovery details",
      path: "$HOME/Library/Application Support/ccie-terminal/logs/sandbox_incidents.jsonl",
      exists: false,
    },
  ],
};

const preferences = {
  minDurationSecs: 30,
  notifyOnNonzeroExit: true,
  notifyOnAgentOutput: true,
  keywordTriggers: ["error", "failed", "timeout"],
  ignoreCommands: ["tail", "watch", "top", "htop"],
  enableSound: false,
};

describe("TerminalSettingsTab", () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.spyOn(window, "alert").mockImplementation(() => {});
    vi.spyOn(paneActivityLib, "getNotificationPreferences").mockResolvedValue(
      preferences,
    );
    vi.spyOn(tauri, "getLogLocations").mockResolvedValue(logLocations);
    vi.spyOn(tauri, "openLogLocation").mockResolvedValue();
    vi.spyOn(tauri, "revealLogLocation").mockResolvedValue();
    appearance.settings = createDefaultAppearanceSettings();
    appearance.error = null;
    appearance.isSaving = false;
    appearance.hydrated = true;
    appearance.authoritativeState = "ready";
    appearance.previewSettings.mockReset();
    appearance.saveSettingsPatch.mockReset().mockResolvedValue(undefined);
    appearance.setSettings.mockReset().mockResolvedValue(undefined);
    appearance.retryAuthoritativeSettings.mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    window.localStorage.clear();
  });

  it("loads and displays current preferences", async () => {
    render(<TerminalSettingsTab />);

    await waitFor(() => {
      expect(screen.getByLabelText(/Minimum duration/i)).toHaveValue(30);
    });
  });

  it("defaults both AI suggestion controls on and persists each toggle locally", () => {
    const firstRender = render(<TerminalSettingsTab />);
    const requireFiveCharacters = screen.getByRole("checkbox", {
      name: "Require 5 characters for AI suggestions",
    });
    const waitForInactivity = screen.getByRole("checkbox", {
      name: "Wait for 2 seconds of inactivity",
    });

    expect(requireFiveCharacters).toBeChecked();
    expect(waitForInactivity).toBeChecked();

    fireEvent.click(requireFiveCharacters);
    expect(requireFiveCharacters).not.toBeChecked();
    expect(JSON.parse(
      window.localStorage.getItem("ccie.commandSuggestionPreferences") ?? "{}",
    )).toEqual({
      requireFiveCharactersForAi: false,
      waitForTwoSecondsOfInactivity: true,
    });

    firstRender.unmount();
    render(<TerminalSettingsTab />);
    expect(screen.getByRole("checkbox", {
      name: "Require 5 characters for AI suggestions",
    })).not.toBeChecked();
    expect(screen.getByRole("checkbox", {
      name: "Wait for 2 seconds of inactivity",
    })).toBeChecked();

    fireEvent.click(screen.getByRole("checkbox", {
      name: "Wait for 2 seconds of inactivity",
    }));
    expect(JSON.parse(
      window.localStorage.getItem("ccie.commandSuggestionPreferences") ?? "{}",
    )).toEqual({
      requireFiveCharactersForAi: false,
      waitForTwoSecondsOfInactivity: false,
    });
  });

  it("saves notification preferences through the Terminal-tab save action", async () => {
    const saveSpy = vi
      .spyOn(paneActivityLib, "updateNotificationPreferences")
      .mockResolvedValue();

    render(<TerminalSettingsTab />);

    await waitFor(() => screen.getByLabelText(/Minimum duration/i));

    const input = screen.getByLabelText(/Minimum duration/i);
    fireEvent.change(input, { target: { value: "60" } });

    const saveBtn = screen.getAllByRole("button", {
      name: "Save terminal settings",
      exact: true,
    })[1];
    fireEvent.click(saveBtn);

    await waitFor(() => {
      expect(saveSpy).toHaveBeenCalledWith(
        expect.objectContaining({ minDurationSecs: 60 }),
      );
    });
  });

  it("persists a terminal font edit through the Terminal-tab save action", async () => {
    vi.spyOn(paneActivityLib, "updateNotificationPreferences").mockResolvedValue();
    render(<TerminalSettingsTab />);

    await screen.findByLabelText(/Minimum duration/i);
    fireEvent.change(screen.getByLabelText("Font size"), {
      target: { value: "18" },
    });
    fireEvent.click(
      screen.getAllByRole("button", { name: "Save terminal settings", exact: true })[1],
    );

    await waitFor(() => {
      expect(appearance.saveSettingsPatch).toHaveBeenCalledWith({
        terminal: expect.objectContaining({ fontSize: 18 }),
      });
    });
  });

  it("does not report whole-tab success when terminal appearance persistence fails", async () => {
    appearance.saveSettingsPatch.mockRejectedValueOnce(new Error("appearance database locked"));
    const notificationSave = vi
      .spyOn(paneActivityLib, "updateNotificationPreferences")
      .mockResolvedValue();
    render(<TerminalSettingsTab />);

    await screen.findByLabelText(/Minimum duration/i);
    fireEvent.click(
      screen.getAllByRole("button", { name: "Save terminal settings", exact: true })[1],
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Terminal appearance and notification settings were not saved: appearance database locked",
    );
    expect(notificationSave).not.toHaveBeenCalled();
    expect(window.alert).not.toHaveBeenCalled();
  });

  it("does not report whole-tab success when notification persistence fails", async () => {
    vi.spyOn(paneActivityLib, "updateNotificationPreferences").mockRejectedValueOnce(
      new Error("notification database locked"),
    );
    render(<TerminalSettingsTab />);

    await screen.findByLabelText(/Minimum duration/i);
    fireEvent.click(
      screen.getAllByRole("button", { name: "Save terminal settings", exact: true })[1],
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Terminal appearance saved, but notification settings failed: notification database locked",
    );
    expect(appearance.saveSettingsPatch).toHaveBeenCalledWith({
      terminal: expect.any(Object),
    });
    expect(window.alert).not.toHaveBeenCalled();
  });

  it("keeps Terminal settings persistence unavailable after authoritative appearance hydration fails", async () => {
    appearance.hydrated = true;
    appearance.authoritativeState = "failed";
    appearance.error = "appearance database unavailable";
    render(<TerminalSettingsTab />);

    await screen.findByLabelText(/Minimum duration/i);

    expect(screen.getByRole("alert")).toHaveTextContent("appearance database unavailable");
    for (const saveButton of screen.getAllByRole("button", {
      name: "Save terminal settings",
      exact: true,
    })) {
      expect(saveButton).toBeDisabled();
    }
    expect(screen.getByRole("button", { name: "Retry loading appearance settings" })).toBeVisible();
  });

  it("locks notification inputs while the captured Terminal-tab save is pending", async () => {
    let resolveNotificationSave!: () => void;
    vi.spyOn(paneActivityLib, "updateNotificationPreferences").mockImplementationOnce(
      () => new Promise<void>((resolve) => { resolveNotificationSave = resolve; }),
    );
    render(<TerminalSettingsTab />);

    const durationInput = await screen.findByLabelText(/Minimum duration/i);
    fireEvent.click(
      screen.getAllByRole("button", { name: "Save terminal settings", exact: true })[1],
    );

    await waitFor(() => expect(paneActivityLib.updateNotificationPreferences).toHaveBeenCalled());
    expect(durationInput).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: "Enable notification sound" })).toBeDisabled();

    await act(async () => resolveNotificationSave());
  });

  it("displays authoritative log paths and availability", async () => {
    render(<TerminalSettingsTab />);

    expect(
      await screen.findByRole("heading", { name: "Diagnostic logs" }),
    ).toBeInTheDocument();
    expect(
      await screen.findByText(logLocations.directory),
    ).toBeInTheDocument();
    expect(
      await screen.findByText(logLocations.files[0].path),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Created when the first incident occurs"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Open Sandbox incidents" }),
    ).toBeDisabled();
  });

  it("opens and reveals a selected log through validated backend commands", async () => {
    render(<TerminalSettingsTab />);

    fireEvent.click(
      await screen.findByRole("button", { name: "Open Application log" }),
    );
    await waitFor(() => {
      expect(tauri.openLogLocation).toHaveBeenCalledWith("application");
    });

    fireEvent.click(
      screen.getByRole("button", { name: "Show Application log in folder" }),
    );
    await waitFor(() => {
      expect(tauri.revealLogLocation).toHaveBeenCalledWith("application");
    });
  });

  it("previews saved terminal presets and exposes labelled native appearance controls", async () => {
    render(<TerminalSettingsTab />);

    expect(await screen.findByRole("heading", { name: "Terminal appearance" })).toBeVisible();
    expect(screen.getByRole("radio", { name: /Follow application theme/i })).toBeChecked();
    expect(screen.getByRole("radio", { name: "TerminAI Dark" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Slate Grey" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: "Matrix" }));
    expect(appearance.previewSettings).toHaveBeenLastCalledWith(
      expect.objectContaining({ terminal: expect.objectContaining({ preset: "matrix" }) }),
    );
    expect(screen.getByLabelText("Foreground color")).toHaveAttribute("type", "color");
    expect(screen.getByLabelText("ANSI bright white")).toHaveAttribute("type", "color");
    expect(screen.getByLabelText("Font family")).toHaveValue('Menlo, "SF Mono", Monaco, monospace');
    expect(screen.getByLabelText("Cursor style")).toHaveValue("block");
    expect(screen.getByRole("checkbox", { name: "Blinking cursor" })).toBeChecked();
    expect(screen.getByText("ANSI preview")).toBeVisible();
  });

  it("gives every native color picker a unique screen-reader name and keyboard focus", async () => {
    const user = userEvent.setup();
    const { container } = render(<TerminalSettingsTab />);
    await screen.findByLabelText(/Minimum duration/i);

    const colorPickers = Array.from(
      container.querySelectorAll<HTMLInputElement>('.terminal-appearance input[type="color"]'),
    );
    expect(colorPickers).toHaveLength(21);
    const accessibleNames = colorPickers.map((picker) => picker.getAttribute("aria-label"));
    expect(new Set(accessibleNames).size).toBe(colorPickers.length);
    for (const picker of colorPickers) expect(picker).toHaveAccessibleName();

    colorPickers[0].focus();
    for (const expected of colorPickers.slice(1, 5)) {
      await user.tab();
      expect(expected).toHaveFocus();
    }
  });

  it("uses contrasted control boundaries and button text in terminal settings", () => {
    const css = readFileSync(resolve("src/components/TerminalSettingsTab.css"), "utf8");

    expect(css).toMatch(
      /\.terminal-appearance input\[type="color"\][\s\S]*?border:\s*1px solid var\(--focus-control\)/,
    );
    expect(css).toMatch(
      /\.save-btn\s*\{[^}]*background-color:\s*var\(--accent-color,[^}]*color:\s*var\(--text-on-strong-accent\)/,
    );
  });

  it("normalizes terminal editing through the provider, persists it, and resets each section", async () => {
    render(<TerminalSettingsTab />);
    await screen.findByLabelText(/Minimum duration/i);

    fireEvent.change(screen.getByLabelText("Font size"), { target: { value: "999" } });
    expect(appearance.previewSettings).toHaveBeenLastCalledWith(
      expect.objectContaining({ terminal: expect.objectContaining({ fontSize: 32 }) }),
    );
    fireEvent.change(screen.getByLabelText("Foreground color"), { target: { value: "#abcdef" } });
    expect(appearance.previewSettings).toHaveBeenLastCalledWith(
      expect.objectContaining({ terminal: expect.objectContaining({ preset: "custom", foreground: "#ABCDEF" }) }),
    );
    fireEvent.click(
      screen.getAllByRole("button", { name: "Save terminal settings", exact: true })[0],
    );
    await waitFor(() => expect(appearance.saveSettingsPatch).toHaveBeenCalledWith({
      terminal: expect.objectContaining({ preset: "custom", foreground: "#ABCDEF" }),
    }));
    expect(appearance.setSettings).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Reset typography" }));
    expect(appearance.previewSettings).toHaveBeenLastCalledWith(
      expect.objectContaining({ terminal: expect.objectContaining({ fontSize: 13 }) }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Reset colors" }));
    fireEvent.click(screen.getByRole("button", { name: "Reset cursor" }));
    expect(appearance.previewSettings.mock.calls.length).toBeGreaterThanOrEqual(5);
  });

  it("resets only ANSI colors to the resolved preset and preserves selection alpha", async () => {
    appearance.settings = {
      ...createDefaultAppearanceSettings(),
      appTheme: "matrix",
      editorTheme: "zed-one-dark",
      effects: { matrixScanlines: true, matrixGlow: true, motion: "reduced" },
      terminal: {
        ...createDefaultAppearanceSettings().terminal,
        preset: "custom",
        background: "#123456",
        fontSize: 17,
        cursorStyle: "bar",
        selectionBackground: "#FFFFFF4D",
        ansi: { ...createDefaultAppearanceSettings().terminal.ansi, brightGreen: "#111111" },
      },
    };
    render(<TerminalSettingsTab />);

    expect(screen.getByLabelText("Selection opacity")).toHaveValue(0.3);
    fireEvent.change(screen.getByLabelText("Selection color"), { target: { value: "#abcdef" } });
    expect(appearance.previewSettings).toHaveBeenLastCalledWith(
      expect.objectContaining({ terminal: expect.objectContaining({ selectionBackground: "#ABCDEF4D" }) }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Reset ANSI palette" }));
    expect(appearance.previewSettings).toHaveBeenLastCalledWith(
      expect.objectContaining({
        terminal: expect.objectContaining({
          preset: "custom",
          background: "#123456",
          fontSize: 17,
          cursorStyle: "bar",
          ansi: expect.objectContaining({ brightGreen: "#8DFF9A" }),
        }),
        editorTheme: "zed-one-dark",
        effects: { matrixScanlines: true, matrixGlow: true, motion: "reduced" },
      }),
    );
  });

  it("renders Matrix follow-app colors in the native controls and ANSI preview", () => {
    appearance.settings = {
      ...createDefaultAppearanceSettings(),
      appTheme: "matrix",
    };
    render(<TerminalSettingsTab />);

    expect(screen.getByRole("radio", { name: /Follow application theme/i })).toBeChecked();
    expect(screen.getByLabelText("Foreground color")).toHaveValue("#8dff9a");
    expect(screen.getByLabelText("Background color")).toHaveValue("#030703");
    expect(screen.getByLabelText("Cursor color")).toHaveValue("#b8ffb8");
    expect(screen.getByLabelText("ANSI red")).toHaveValue("#ff6b6b");
    expect(screen.getByLabelText("ANSI bright cyan")).toHaveValue("#a2fff7");
    expect(screen.getByText("red")).toHaveStyle({ color: "rgb(255, 107, 107)" });
    expect(screen.getByText("cyan")).toHaveStyle({ color: "rgb(162, 255, 247)" });
  });

  it("materializes the complete Matrix palette before a follow-app color edit and resets colors back to Matrix", () => {
    appearance.settings = {
      ...createDefaultAppearanceSettings(),
      appTheme: "matrix",
    };
    render(<TerminalSettingsTab />);

    fireEvent.change(screen.getByLabelText("Foreground color"), {
      target: { value: "#123456" },
    });
    expect(appearance.previewSettings).toHaveBeenLastCalledWith(
      expect.objectContaining({
        terminal: expect.objectContaining({
          preset: "custom",
          foreground: "#123456",
          background: "#030703",
          cursor: "#B8FFB8",
          selectionBackground: "#1B5E20",
          ansi: expect.objectContaining({
            red: "#FF6B6B",
            green: "#39FF6A",
            brightCyan: "#A2FFF7",
          }),
        }),
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Reset colors" }));
    expect(appearance.previewSettings).toHaveBeenLastCalledWith(
      expect.objectContaining({
        terminal: expect.objectContaining({
          preset: "custom",
          foreground: "#8DFF9A",
          background: "#030703",
          cursor: "#B8FFB8",
          cursorAccent: "#030703",
          selectionBackground: "#1B5E20",
          ansi: expect.objectContaining({
            red: "#FF6B6B",
            green: "#39FF6A",
          }),
        }),
      }),
    );
  });

  it("locks every terminal appearance control while any appearance save is active", async () => {
    appearance.isSaving = true;
    render(<TerminalSettingsTab />);
    await screen.findByLabelText(/Minimum duration/i);

    expect(
      screen.getAllByRole("button", { name: "Saving terminal settings...", exact: true })[0],
    ).toBeDisabled();
    for (const radio of screen.getAllByRole("radio")) expect(radio).toBeDisabled();
    expect(screen.getByLabelText("Foreground color")).toBeDisabled();
    expect(screen.getByLabelText("ANSI red")).toBeDisabled();
    expect(screen.getByLabelText("Font family")).toBeDisabled();
    expect(screen.getByLabelText("Cursor style")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Reset colors" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Reset ANSI palette" })).toBeDisabled();
  });

  it("surfaces terminal appearance persistence failures without affecting notification saves", async () => {
    appearance.saveSettingsPatch.mockRejectedValueOnce(new Error("appearance database locked"));
    render(<TerminalSettingsTab />);
    await screen.findByLabelText(/Minimum duration/i);

    fireEvent.click(
      screen.getAllByRole("button", { name: "Save terminal settings", exact: true })[0],
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Terminal appearance and notification settings were not saved: appearance database locked",
    );
  });
});

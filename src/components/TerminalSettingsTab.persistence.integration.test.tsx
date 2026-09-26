import { act, render, screen, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import TerminalSettingsTab from "./TerminalSettingsTab";
import { AppearanceProvider } from "../theme/AppearanceProvider";
import { createDefaultAppearanceSettings } from "../theme/defaults";
import type { AppearanceSettingsV1 } from "../theme/types";

const mocks = vi.hoisted(() => ({
  appearanceSettingsGet: vi.fn(),
  appearanceSettingsPatch: vi.fn(),
  appearanceSettingsSet: vi.fn(),
  getLogLocations: vi.fn(),
  openLogLocation: vi.fn(),
  revealLogLocation: vi.fn(),
  getNotificationPreferences: vi.fn(),
  updateNotificationPreferences: vi.fn(),
  listen: vi.fn(),
  emit: vi.fn(),
  applyAppearanceSettings: vi.fn(),
}));

vi.mock("../lib/tauri", () => ({
  appearanceSettingsGet: mocks.appearanceSettingsGet,
  appearanceSettingsPatch: mocks.appearanceSettingsPatch,
  appearanceSettingsSet: mocks.appearanceSettingsSet,
  getLogLocations: mocks.getLogLocations,
  openLogLocation: mocks.openLogLocation,
  revealLogLocation: mocks.revealLogLocation,
}));

vi.mock("../lib/paneActivity", () => ({
  getNotificationPreferences: mocks.getNotificationPreferences,
  updateNotificationPreferences: mocks.updateNotificationPreferences,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: mocks.listen,
  emit: mocks.emit,
}));

vi.mock("../lib/terminalRegistry", () => ({
  applyAppearanceSettings: mocks.applyAppearanceSettings,
}));

const notificationPreferences = {
  minDurationSecs: 30,
  notifyOnNonzeroExit: true,
  notifyOnAgentOutput: true,
  keywordTriggers: ["error"],
  ignoreCommands: ["tail"],
  enableSound: true,
};

let authoritative: AppearanceSettingsV1 & { revision: number };

function renderTerminalSettings() {
  return render(
    <AppearanceProvider>
      <TerminalSettingsTab />
    </AppearanceProvider>,
  );
}

describe("TerminalSettingsTab persistence integration", () => {
  beforeEach(() => {
    authoritative = { ...createDefaultAppearanceSettings(), revision: 1 };
    vi.spyOn(window, "alert").mockImplementation(() => {});
    mocks.appearanceSettingsGet.mockReset().mockImplementation(async () => authoritative);
    mocks.appearanceSettingsPatch.mockReset().mockImplementation(async (patch) => {
      if (patch.scope !== "terminal") throw new Error("expected terminal patch");
      authoritative = {
        ...authoritative,
        terminal: patch.terminal,
        revision: authoritative.revision + 1,
      };
      return authoritative;
    });
    mocks.appearanceSettingsSet.mockReset();
    mocks.getNotificationPreferences.mockReset().mockResolvedValue(notificationPreferences);
    mocks.updateNotificationPreferences.mockReset().mockResolvedValue(undefined);
    mocks.getLogLocations.mockReset().mockResolvedValue({ directory: "/logs", files: [] });
    mocks.openLogLocation.mockReset().mockResolvedValue(undefined);
    mocks.revealLogLocation.mockReset().mockResolvedValue(undefined);
    mocks.listen.mockReset().mockResolvedValue(vi.fn());
    mocks.emit.mockReset().mockResolvedValue(undefined);
    mocks.applyAppearanceSettings.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("restores a terminal font saved through the Terminal-tab action after relaunch", async () => {
    const firstLaunch = renderTerminalSettings();
    await waitFor(() => expect(screen.getByLabelText("Font size")).toHaveValue(13));

    fireEvent.change(screen.getByLabelText("Font size"), { target: { value: "18" } });
    fireEvent.click(
      screen.getAllByRole("button", { name: "Save terminal settings", exact: true })[1],
    );

    await waitFor(() => {
      expect(mocks.appearanceSettingsPatch).toHaveBeenCalledWith({
        scope: "terminal",
        terminal: expect.objectContaining({ fontSize: 18 }),
      });
      expect(mocks.updateNotificationPreferences).toHaveBeenCalledWith(notificationPreferences);
      expect(window.alert).toHaveBeenCalledWith("Terminal settings saved successfully");
    });

    firstLaunch.unmount();
    renderTerminalSettings();

    await waitFor(() => {
      expect(mocks.appearanceSettingsGet).toHaveBeenCalledTimes(2);
      expect(screen.getByLabelText("Font size")).toHaveValue(18);
    });
  });

  it("waits for authoritative terminal hydration before enabling either save action", async () => {
    let resolveAppearance!: (settings: AppearanceSettingsV1 & { revision: number }) => void;
    const hydratedTerminal = {
      ...createDefaultAppearanceSettings(),
      revision: 2,
      terminal: {
        ...createDefaultAppearanceSettings().terminal,
        preset: "custom" as const,
        fontSize: 18,
      },
    };
    mocks.appearanceSettingsGet.mockReset().mockImplementationOnce(
      () => new Promise((resolve) => { resolveAppearance = resolve; }),
    );

    renderTerminalSettings();
    await screen.findByLabelText(/Minimum duration/i);

    for (const saveButton of screen.getAllByRole("button", {
      name: "Save terminal settings",
      exact: true,
    })) {
      expect(saveButton).toBeDisabled();
    }
    fireEvent.click(
      screen.getAllByRole("button", { name: "Save terminal settings", exact: true })[1],
    );
    expect(mocks.appearanceSettingsPatch).not.toHaveBeenCalled();

    await act(async () => resolveAppearance(hydratedTerminal));

    await waitFor(() => {
      expect(screen.getByLabelText("Font size")).toHaveValue(18);
      for (const saveButton of screen.getAllByRole("button", {
        name: "Save terminal settings",
        exact: true,
      })) {
        expect(saveButton).toBeEnabled();
      }
    });
  });

  it("retries failed appearance hydration before enabling Terminal-tab persistence", async () => {
    let resolveRetry!: (settings: AppearanceSettingsV1 & { revision: number }) => void;
    const retriedTerminal = {
      ...createDefaultAppearanceSettings(),
      revision: 2,
      terminal: {
        ...createDefaultAppearanceSettings().terminal,
        preset: "custom" as const,
        fontSize: 19,
      },
    };
    mocks.appearanceSettingsGet.mockReset()
      .mockRejectedValueOnce(new Error("appearance database unavailable"))
      .mockImplementationOnce(
        () => new Promise<AppearanceSettingsV1 & { revision: number }>((resolve) => {
          resolveRetry = resolve;
        }),
      );

    renderTerminalSettings();
    await screen.findByLabelText(/Minimum duration/i);
    expect(await screen.findByRole("alert")).toHaveTextContent("appearance database unavailable");
    for (const saveButton of screen.getAllByRole("button", {
      name: "Save terminal settings",
      exact: true,
    })) {
      expect(saveButton).toBeDisabled();
    }

    fireEvent.click(screen.getByRole("button", { name: "Retry loading appearance settings" }));

    await waitFor(() => expect(mocks.appearanceSettingsGet).toHaveBeenCalledTimes(2));
    for (const saveButton of screen.getAllByRole("button", {
      name: "Save terminal settings",
      exact: true,
    })) {
      expect(saveButton).toBeDisabled();
    }
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    await act(async () => resolveRetry(retriedTerminal));

    await waitFor(() => {
      expect(screen.getByLabelText("Font size")).toHaveValue(19);
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      for (const saveButton of screen.getAllByRole("button", {
        name: "Save terminal settings",
        exact: true,
      })) {
        expect(saveButton).toBeEnabled();
      }
    });
  });
});

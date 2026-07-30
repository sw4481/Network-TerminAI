import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import TerminalSettingsTab from "./TerminalSettingsTab";
import * as paneActivityLib from "../lib/paneActivity";
import * as tauri from "../lib/tauri";

const logLocations: tauri.LogLocations = {
  directory: "/Users/test/Library/Application Support/ccie-terminal/logs",
  files: [
    {
      id: "application",
      label: "Application log",
      description: "Rust application and scheduler events",
      path: "/Users/test/Library/Application Support/ccie-terminal/logs/ccie-terminal.2026-07-30.log",
      exists: true,
    },
    {
      id: "sandbox_incidents",
      label: "Sandbox incidents",
      description: "Sandbox timeout and automatic recovery details",
      path: "/Users/test/Library/Application Support/ccie-terminal/logs/sandbox_incidents.jsonl",
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
    vi.spyOn(window, "alert").mockImplementation(() => {});
    vi.spyOn(paneActivityLib, "getNotificationPreferences").mockResolvedValue(
      preferences,
    );
    vi.spyOn(tauri, "getLogLocations").mockResolvedValue(logLocations);
    vi.spyOn(tauri, "openLogLocation").mockResolvedValue();
    vi.spyOn(tauri, "revealLogLocation").mockResolvedValue();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("loads and displays current preferences", async () => {
    render(<TerminalSettingsTab />);

    await waitFor(() => {
      expect(screen.getByLabelText(/Minimum duration/i)).toHaveValue(30);
    });
  });

  it("saves preferences on submit", async () => {
    const saveSpy = vi
      .spyOn(paneActivityLib, "updateNotificationPreferences")
      .mockResolvedValue();

    render(<TerminalSettingsTab />);

    await waitFor(() => screen.getByLabelText(/Minimum duration/i));

    const input = screen.getByLabelText(/Minimum duration/i);
    fireEvent.change(input, { target: { value: "60" } });

    const saveBtn = screen.getByText(/Save/i);
    fireEvent.click(saveBtn);

    await waitFor(() => {
      expect(saveSpy).toHaveBeenCalledWith(
        expect.objectContaining({ minDurationSecs: 60 }),
      );
    });
  });

  it("displays authoritative log paths and availability", async () => {
    render(<TerminalSettingsTab />);

    expect(
      await screen.findByRole("heading", { name: "Diagnostic logs" }),
    ).toBeInTheDocument();
    expect(screen.getByText(logLocations.directory)).toBeInTheDocument();
    expect(screen.getByText(logLocations.files[0].path)).toBeInTheDocument();
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
});

import { act, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppearanceSettingsV1 } from "./types";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  set: vi.fn(),
  emit: vi.fn(),
  listen: vi.fn(),
  unlisten: vi.fn(),
}));

vi.mock("../lib/tauri", () => ({
  appearanceSettingsGet: mocks.get,
  appearanceSettingsSet: mocks.set,
}));

vi.mock("@tauri-apps/api/event", () => ({
  emit: mocks.emit,
  listen: mocks.listen,
}));

import {
  APPEARANCE_SETTINGS_CHANGED_EVENT,
  APPEARANCE_THEME_MIRROR_KEY,
  AppearanceProvider,
  applyMirroredThemeBeforeRender,
  useAppearance,
} from "./AppearanceProvider";
import { DEFAULT_APPEARANCE_SETTINGS } from "./defaults";

let deliverEvent:
  | ((event: { payload: AppearanceSettingsV1 }) => void)
  | undefined;

function Probe() {
  const { settings, hydrated, error, setSettings } = useAppearance();
  return (
    <>
      <output data-testid="theme">{settings.appTheme}</output>
      <output data-testid="hydrated">{String(hydrated)}</output>
      <output data-testid="error">{error ?? ""}</output>
      <button
        onClick={() =>
          void setSettings({
            ...settings,
            appTheme: "matrix",
          })
        }
      >
        matrix
      </button>
    </>
  );
}

describe("AppearanceProvider", () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute("data-theme");
    deliverEvent = undefined;
    mocks.get.mockReset().mockResolvedValue(DEFAULT_APPEARANCE_SETTINGS);
    mocks.set.mockReset().mockImplementation(async (value) => value);
    mocks.emit.mockReset().mockResolvedValue(undefined);
    mocks.unlisten.mockReset();
    mocks.listen.mockReset().mockImplementation(
      async (_name: string, handler: (event: { payload: AppearanceSettingsV1 }) => void) => {
        deliverEvent = handler;
        return mocks.unlisten;
      },
    );
  });

  it("hydrates the stored settings, applies the document theme, and mirrors it", async () => {
    mocks.get.mockResolvedValueOnce({
      ...DEFAULT_APPEARANCE_SETTINGS,
      appTheme: "slate-grey",
    });
    render(<AppearanceProvider><Probe /></AppearanceProvider>);

    await waitFor(() => {
      expect(screen.getByTestId("theme")).toHaveTextContent("slate-grey");
      expect(document.documentElement).toHaveAttribute("data-theme", "slate-grey");
    });
    expect(localStorage.getItem(APPEARANCE_THEME_MIRROR_KEY)).toBe("slate-grey");
  });

  it("uses the local mirror before rendering and safely ignores invalid mirrors", () => {
    localStorage.setItem(APPEARANCE_THEME_MIRROR_KEY, "matrix");
    applyMirroredThemeBeforeRender();
    expect(document.documentElement).toHaveAttribute("data-theme", "matrix");

    localStorage.setItem(APPEARANCE_THEME_MIRROR_KEY, "not-a-theme");
    applyMirroredThemeBeforeRender();
    expect(document.documentElement).toHaveAttribute("data-theme", "terminai-dark");
  });

  it("uses Dark and surfaces a non-fatal error when hydration fails", async () => {
    mocks.get.mockRejectedValueOnce(new Error("database unavailable"));
    render(<AppearanceProvider><Probe /></AppearanceProvider>);

    await waitFor(() => {
      expect(screen.getByTestId("hydrated")).toHaveTextContent("true");
      expect(screen.getByTestId("theme")).toHaveTextContent("terminai-dark");
      expect(screen.getByTestId("error")).toHaveTextContent("database unavailable");
    });
  });

  it("does not let delayed hydration overwrite a live cross-window snapshot", async () => {
    let resolveHydration: ((settings: AppearanceSettingsV1) => void) | undefined;
    mocks.get.mockReturnValueOnce(new Promise<AppearanceSettingsV1>((resolve) => {
      resolveHydration = resolve;
    }));
    render(<AppearanceProvider><Probe /></AppearanceProvider>);
    await waitFor(() => expect(deliverEvent).toBeDefined());

    act(() => deliverEvent?.({
      payload: { ...DEFAULT_APPEARANCE_SETTINGS, appTheme: "matrix" },
    }));
    await act(async () => resolveHydration?.(DEFAULT_APPEARANCE_SETTINGS));

    expect(screen.getByTestId("theme")).toHaveTextContent("matrix");
  });

  it("persists before broadcasting the validated snapshot", async () => {
    render(<AppearanceProvider><Probe /></AppearanceProvider>);
    await waitFor(() => expect(mocks.get).toHaveBeenCalled());
    screen.getByRole("button", { name: "matrix" }).click();

    await waitFor(() => expect(mocks.set).toHaveBeenCalled());
    expect(mocks.emit).toHaveBeenCalledWith(
      APPEARANCE_SETTINGS_CHANGED_EVENT,
      expect.objectContaining({ appTheme: "matrix" }),
    );
    expect(mocks.set.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.emit.mock.invocationCallOrder[0],
    );
  });

  it("falls back to Dark and reports a non-fatal error when saving fails", async () => {
    mocks.set.mockRejectedValueOnce(new Error("write failed"));
    render(<AppearanceProvider><Probe /></AppearanceProvider>);
    await waitFor(() => expect(mocks.get).toHaveBeenCalled());

    screen.getByRole("button", { name: "matrix" }).click();
    await waitFor(() => {
      expect(screen.getByTestId("theme")).toHaveTextContent("terminai-dark");
      expect(screen.getByTestId("error")).toHaveTextContent("write failed");
    });
  });
});

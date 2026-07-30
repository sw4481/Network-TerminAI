import { useEffect } from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppearanceSettingsV1 } from "./types";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  set: vi.fn(),
  emit: vi.fn(),
  listen: vi.fn(),
  unlisten: vi.fn(),
  applyAppearanceSettings: vi.fn(),
}));

vi.mock("../lib/tauri", () => ({
  appearanceSettingsGet: mocks.get,
  appearanceSettingsSet: mocks.set,
}));

vi.mock("@tauri-apps/api/event", () => ({
  emit: mocks.emit,
  listen: mocks.listen,
}));

vi.mock("../lib/terminalRegistry", () => ({
  applyAppearanceSettings: mocks.applyAppearanceSettings,
}));

import {
  APPEARANCE_SETTINGS_CHANGED_EVENT,
  APPEARANCE_THEME_MIRROR_KEY,
  AppearanceProvider,
  applyAppearanceToDocument,
  applyMirroredThemeBeforeRender,
  useAppearance,
} from "./AppearanceProvider";
import { DEFAULT_APPEARANCE_SETTINGS } from "./defaults";

let deliverEvent:
  | ((event: { payload: AppearanceSettingsV1 }) => void)
  | undefined;

function Probe() {
  const { settings, hydrated, authoritativeState, error, setSettings, previewSettings, retryAuthoritativeSettings } = useAppearance();
  return (
    <>
      <output data-testid="theme">{settings.appTheme}</output>
      <output data-testid="hydrated">{String(hydrated)}</output>
      <output data-testid="authoritative-state">{authoritativeState}</output>
      <output data-testid="error">{error ?? ""}</output>
      <button
        onClick={() =>
          void setSettings({
            ...settings,
            appTheme: "matrix",
          }).catch(() => {})
        }
      >
        matrix
      </button>
      <button
        onClick={() => previewSettings({ ...settings, appTheme: "slate-grey" })}
      >
        preview grey
      </button>
      <button onClick={() => void retryAuthoritativeSettings().catch(() => {})}>retry appearance</button>
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
    mocks.applyAppearanceSettings.mockReset();
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

  it.each(["terminai-dark", "slate-grey", "matrix"] as const)(
    "applies %s and its effect guards to the document",
    (appTheme) => {
      applyAppearanceToDocument({
        ...DEFAULT_APPEARANCE_SETTINGS,
        appTheme,
        effects: { matrixScanlines: true, matrixGlow: true, motion: "reduced" },
      });
      expect(document.documentElement).toHaveAttribute("data-theme", appTheme);
      expect(document.documentElement).toHaveAttribute("data-matrix-scanlines", "true");
      expect(document.documentElement).toHaveAttribute("data-matrix-glow", "true");
      expect(document.documentElement).toHaveAttribute("data-matrix-motion", "reduced");
    },
  );

  it("uses Dark and surfaces a non-fatal error when hydration fails", async () => {
    mocks.get.mockRejectedValueOnce(new Error("database unavailable"));
    render(<AppearanceProvider><Probe /></AppearanceProvider>);

    await waitFor(() => {
      expect(screen.getByTestId("hydrated")).toHaveTextContent("true");
      expect(screen.getByTestId("theme")).toHaveTextContent("terminai-dark");
      expect(screen.getByTestId("error")).toHaveTextContent("database unavailable");
      expect(screen.getByTestId("authoritative-state")).toHaveTextContent("failed");
    });
  });

  it("does not treat fallback Dark as authoritative and retries into the stored theme", async () => {
    mocks.get
      .mockRejectedValueOnce(new Error("database unavailable"))
      .mockResolvedValueOnce({ ...DEFAULT_APPEARANCE_SETTINGS, appTheme: "matrix" });
    render(<AppearanceProvider><Probe /></AppearanceProvider>);
    await waitFor(() => expect(screen.getByTestId("authoritative-state")).toHaveTextContent("failed"));

    screen.getByRole("button", { name: "retry appearance" }).click();
    await waitFor(() => {
      expect(screen.getByTestId("authoritative-state")).toHaveTextContent("ready");
      expect(screen.getByTestId("theme")).toHaveTextContent("matrix");
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
    expect(localStorage.getItem(APPEARANCE_THEME_MIRROR_KEY)).toBe("matrix");
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

  it("changes the document theme in place for a preview without remounting children", async () => {
    const mount = vi.fn();
    function StableProbe() {
      useEffect(() => { mount(); }, []);
      return <Probe />;
    }
    render(<AppearanceProvider><StableProbe /></AppearanceProvider>);
    await waitFor(() => expect(mocks.get).toHaveBeenCalled());

    localStorage.setItem(APPEARANCE_THEME_MIRROR_KEY, "terminai-dark");

    screen.getByRole("button", { name: "preview grey" }).click();
    expect(document.documentElement).toHaveAttribute("data-theme", "slate-grey");
    expect(localStorage.getItem(APPEARANCE_THEME_MIRROR_KEY)).toBe("terminai-dark");
    expect(mount).toHaveBeenCalledTimes(1);
    expect(mocks.set).not.toHaveBeenCalled();
  });

  it("sends a pre-save preview to the live registry seam before persistence", async () => {
    render(<AppearanceProvider><Probe /></AppearanceProvider>);
    await waitFor(() => expect(mocks.get).toHaveBeenCalled());
    mocks.applyAppearanceSettings.mockClear();

    screen.getByRole("button", { name: "preview grey" }).click();

    expect(mocks.applyAppearanceSettings).toHaveBeenCalledWith(
      expect.objectContaining({ appTheme: "slate-grey" }),
    );
    expect(mocks.set).not.toHaveBeenCalled();
  });
});

import { useEffect } from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppearanceSettingsV1 } from "./types";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  set: vi.fn(),
  patch: vi.fn(),
  emit: vi.fn(),
  listen: vi.fn(),
  unlisten: vi.fn(),
  applyAppearanceSettings: vi.fn(),
}));

vi.mock("../lib/tauri", () => ({
  appearanceSettingsGet: mocks.get,
  appearanceSettingsSet: mocks.set,
  appearanceSettingsPatch: mocks.patch,
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

type RevisionedAppearancePayload = AppearanceSettingsV1 & {
  revision?: number;
  sourceId?: string;
};

let deliverEvent:
  | ((event: { payload: RevisionedAppearancePayload }) => void)
  | undefined;

function Probe() {
  const {
    settings,
    hydrated,
    authoritativeState,
    error,
    isSaving,
    saveSettingsPatch,
    setSettings,
    previewSettings,
    retryAuthoritativeSettings,
  } = useAppearance();
  return (
    <>
      <output data-testid="theme">{settings.appTheme}</output>
      <output data-testid="editor-theme">{settings.editorTheme}</output>
      <output data-testid="terminal-foreground">{settings.terminal.foreground}</output>
      <output data-testid="hydrated">{String(hydrated)}</output>
      <output data-testid="authoritative-state">{authoritativeState}</output>
      <output data-testid="appearance-saving">{String(isSaving)}</output>
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
      <button
        onClick={() => previewSettings({ ...settings, appTheme: "matrix" })}
      >
        preview matrix
      </button>
      <button
        onClick={() =>
          void saveSettingsPatch({ editorTheme: "zed-one-dark" }).catch(() => {})
        }
      >
        save editor patch
      </button>
      <button
        onClick={() =>
          previewSettings({
            ...settings,
            terminal: {
              ...settings.terminal,
              preset: "custom",
              foreground: "#111111",
            },
          })
        }
      >
        preview older terminal
      </button>
      <button
        onClick={() =>
          void saveSettingsPatch({ terminal: settings.terminal }).catch(() => {})
        }
      >
        save terminal patch
      </button>
      <button
        onClick={() =>
          previewSettings({
            ...settings,
            terminal: {
              ...settings.terminal,
              preset: "custom",
              foreground: "#222222",
            },
          })
        }
      >
        preview newer terminal
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
    mocks.patch.mockReset().mockImplementation(async (patch) => {
      if (patch.scope === "application") {
        return {
          ...DEFAULT_APPEARANCE_SETTINGS,
          appTheme: patch.appTheme,
          effects: patch.effects,
        };
      }
      if (patch.scope === "editor") {
        return { ...DEFAULT_APPEARANCE_SETTINGS, editorTheme: patch.editorTheme };
      }
      return { ...DEFAULT_APPEARANCE_SETTINGS, terminal: patch.terminal };
    });
    mocks.emit.mockReset().mockResolvedValue(undefined);
    mocks.unlisten.mockReset();
    mocks.applyAppearanceSettings.mockReset();
    mocks.listen.mockReset().mockImplementation(
      async (_name: string, handler: (event: { payload: RevisionedAppearancePayload }) => void) => {
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

  it("ignores an older retry that resolves after a newer retry", async () => {
    render(<AppearanceProvider><Probe /></AppearanceProvider>);
    await waitFor(() => expect(screen.getByTestId("authoritative-state")).toHaveTextContent("ready"));
    let first!: (value: AppearanceSettingsV1) => void;
    let second!: (value: AppearanceSettingsV1) => void;
    mocks.get.mockReset()
      .mockImplementationOnce(() => new Promise<AppearanceSettingsV1>((resolve) => { first = resolve; }))
      .mockImplementationOnce(() => new Promise<AppearanceSettingsV1>((resolve) => { second = resolve; }));
    screen.getByRole("button", { name: "retry appearance" }).click();
    screen.getByRole("button", { name: "retry appearance" }).click();
    await act(async () => second({ ...DEFAULT_APPEARANCE_SETTINGS, appTheme: "matrix" }));
    await act(async () => first({ ...DEFAULT_APPEARANCE_SETTINGS, appTheme: "slate-grey" }));
    expect(screen.getByTestId("theme")).toHaveTextContent("matrix");
  });

  it("does not let a retry overwrite a newer live appearance event", async () => {
    render(<AppearanceProvider><Probe /></AppearanceProvider>);
    await waitFor(() => expect(deliverEvent).toBeDefined());
    let resolveRetry!: (value: AppearanceSettingsV1) => void;
    mocks.get.mockReset().mockImplementationOnce(() => new Promise<AppearanceSettingsV1>((resolve) => { resolveRetry = resolve; }));
    screen.getByRole("button", { name: "retry appearance" }).click();
    act(() => deliverEvent?.({ payload: { ...DEFAULT_APPEARANCE_SETTINGS, appTheme: "matrix" } }));
    await act(async () => resolveRetry({ ...DEFAULT_APPEARANCE_SETTINGS, appTheme: "slate-grey" }));
    expect(screen.getByTestId("theme")).toHaveTextContent("matrix");
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

  it("keeps a successfully persisted theme authoritative when broadcasting fails", async () => {
    mocks.emit.mockRejectedValueOnce(new Error("event bus unavailable"));
    render(<AppearanceProvider><Probe /></AppearanceProvider>);
    await waitFor(() => expect(screen.getByTestId("authoritative-state")).toHaveTextContent("ready"));

    screen.getByRole("button", { name: "matrix" }).click();

    await waitFor(() => {
      expect(screen.getByTestId("theme")).toHaveTextContent("matrix");
      expect(screen.getByTestId("authoritative-state")).toHaveTextContent("ready");
      expect(screen.getByTestId("error")).toHaveTextContent(
        "Appearance saved, but other windows could not be notified: event bus unavailable",
      );
    });
    expect(localStorage.getItem(APPEARANCE_THEME_MIRROR_KEY)).toBe("matrix");
    expect(document.documentElement).toHaveAttribute("data-theme", "matrix");
  });

  it("merges an editor-only save into the authoritative snapshot without persisting an application preview", async () => {
    mocks.patch.mockResolvedValueOnce({
      ...DEFAULT_APPEARANCE_SETTINGS,
      appTheme: "slate-grey",
      editorTheme: "zed-one-dark",
    });
    render(<AppearanceProvider><Probe /></AppearanceProvider>);
    await waitFor(() => expect(screen.getByTestId("authoritative-state")).toHaveTextContent("ready"));

    screen.getByRole("button", { name: "preview matrix" }).click();
    await waitFor(() => expect(screen.getByTestId("theme")).toHaveTextContent("matrix"));
    mocks.patch.mockClear();

    screen.getByRole("button", { name: "save editor patch" }).click();

    await waitFor(() => expect(mocks.patch).toHaveBeenCalledOnce());
    expect(mocks.patch).toHaveBeenCalledWith({
      scope: "editor",
      editorTheme: "zed-one-dark",
    });
    expect(mocks.set).not.toHaveBeenCalled();
    expect(screen.getByTestId("theme")).toHaveTextContent("matrix");
    expect(localStorage.getItem(APPEARANCE_THEME_MIRROR_KEY)).toBe("slate-grey");
  });

  it("rebases a scoped save onto newer authoritative fields returned by the backend", async () => {
    mocks.patch.mockResolvedValueOnce({
      ...DEFAULT_APPEARANCE_SETTINGS,
      appTheme: "matrix",
      editorTheme: "zed-one-dark",
    });
    render(<AppearanceProvider><Probe /></AppearanceProvider>);
    await waitFor(() => expect(screen.getByTestId("authoritative-state")).toHaveTextContent("ready"));

    screen.getByRole("button", { name: "save editor patch" }).click();

    await waitFor(() => {
      expect(screen.getByTestId("theme")).toHaveTextContent("matrix");
      expect(localStorage.getItem(APPEARANCE_THEME_MIRROR_KEY)).toBe("matrix");
    });
  });

  it("applies and broadcasts a newer save response after an older live event arrives", async () => {
    mocks.get.mockResolvedValueOnce({
      ...DEFAULT_APPEARANCE_SETTINGS,
      revision: 1,
    });
    let resolveSave!: (value: RevisionedAppearancePayload) => void;
    mocks.patch.mockImplementationOnce(
      () => new Promise<RevisionedAppearancePayload>((resolve) => {
        resolveSave = resolve;
      }),
    );
    render(<AppearanceProvider><Probe /></AppearanceProvider>);
    await waitFor(() => expect(screen.getByTestId("authoritative-state")).toHaveTextContent("ready"));

    screen.getByRole("button", { name: "save editor patch" }).click();
    await waitFor(() => expect(mocks.patch).toHaveBeenCalledOnce());
    act(() => deliverEvent?.({
      payload: {
        ...DEFAULT_APPEARANCE_SETTINGS,
        appTheme: "matrix",
        revision: 2,
        sourceId: "window-b",
      },
    }));
    expect(screen.getByTestId("theme")).toHaveTextContent("matrix");
    expect(screen.getByTestId("editor-theme")).toHaveTextContent("follow-app");

    await act(async () => resolveSave({
      ...DEFAULT_APPEARANCE_SETTINGS,
      appTheme: "matrix",
      editorTheme: "zed-one-dark",
      revision: 3,
    }));

    await waitFor(() => {
      expect(screen.getByTestId("editor-theme")).toHaveTextContent("zed-one-dark");
      expect(mocks.emit).toHaveBeenCalledWith(
        APPEARANCE_SETTINGS_CHANGED_EVENT,
        expect.objectContaining({
          appTheme: "matrix",
          editorTheme: "zed-one-dark",
          revision: 3,
        }),
      );
    });
  });

  it("keeps a newer live authority and an unrelated preview when an older save response resolves", async () => {
    mocks.get.mockResolvedValueOnce({
      ...DEFAULT_APPEARANCE_SETTINGS,
      revision: 1,
    });
    let resolveSave!: (value: RevisionedAppearancePayload) => void;
    mocks.patch.mockImplementationOnce(
      () => new Promise<RevisionedAppearancePayload>((resolve) => {
        resolveSave = resolve;
      }),
    );
    render(<AppearanceProvider><Probe /></AppearanceProvider>);
    await waitFor(() => expect(screen.getByTestId("authoritative-state")).toHaveTextContent("ready"));

    screen.getByRole("button", { name: "save editor patch" }).click();
    await waitFor(() => expect(mocks.patch).toHaveBeenCalledOnce());
    act(() => screen.getByRole("button", { name: "preview newer terminal" }).click());
    act(() => deliverEvent?.({
      payload: {
        ...DEFAULT_APPEARANCE_SETTINGS,
        appTheme: "slate-grey",
        editorTheme: "classic-dark",
        revision: 3,
        sourceId: "window-b",
      },
    }));
    await act(async () => resolveSave({
      ...DEFAULT_APPEARANCE_SETTINGS,
      appTheme: "matrix",
      editorTheme: "zed-one-dark",
      revision: 2,
    }));

    expect(screen.getByTestId("theme")).toHaveTextContent("slate-grey");
    expect(screen.getByTestId("editor-theme")).toHaveTextContent("classic-dark");
    expect(screen.getByTestId("terminal-foreground")).toHaveTextContent("#222222");
    expect(mocks.emit).not.toHaveBeenCalled();
  });

  it("keeps the global save lock active and does not overwrite a newer terminal preview with an older response", async () => {
    let resolveSave!: (value: AppearanceSettingsV1) => void;
    mocks.patch.mockImplementationOnce(
      (patch: { terminal: AppearanceSettingsV1["terminal"] }) =>
        new Promise<AppearanceSettingsV1>((resolve) => {
          resolveSave = () => resolve({
            ...DEFAULT_APPEARANCE_SETTINGS,
            terminal: patch.terminal,
          });
        }),
    );
    render(<AppearanceProvider><Probe /></AppearanceProvider>);
    await waitFor(() => expect(screen.getByTestId("authoritative-state")).toHaveTextContent("ready"));

    act(() => screen.getByRole("button", { name: "preview older terminal" }).click());
    await waitFor(() => expect(screen.getByTestId("terminal-foreground")).toHaveTextContent("#111111"));
    act(() => screen.getByRole("button", { name: "save terminal patch" }).click());
    await waitFor(() => {
      expect(screen.getByTestId("appearance-saving")).toHaveTextContent("true");
      expect(mocks.patch).toHaveBeenCalledWith({
        scope: "terminal",
        terminal: expect.objectContaining({ foreground: "#111111" }),
      });
    });

    act(() => screen.getByRole("button", { name: "preview newer terminal" }).click());
    await waitFor(() => expect(screen.getByTestId("terminal-foreground")).toHaveTextContent("#222222"));

    await act(async () => resolveSave());

    await waitFor(() => expect(screen.getByTestId("appearance-saving")).toHaveTextContent("false"));
    expect(screen.getByTestId("terminal-foreground")).toHaveTextContent("#222222");
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

  it("does not let an older failed save overwrite a newer live appearance event", async () => {
    let rejectOlderSave!: (error: Error) => void;
    mocks.set.mockImplementationOnce(
      () => new Promise<AppearanceSettingsV1>((_resolve, reject) => {
        rejectOlderSave = reject;
      }),
    );
    render(<AppearanceProvider><Probe /></AppearanceProvider>);
    await waitFor(() => expect(deliverEvent).toBeDefined());

    screen.getByRole("button", { name: "matrix" }).click();
    await waitFor(() => expect(mocks.set).toHaveBeenCalledOnce());
    act(() => deliverEvent?.({
      payload: { ...DEFAULT_APPEARANCE_SETTINGS, appTheme: "slate-grey" },
    }));
    await act(async () => rejectOlderSave(new Error("write failed")));

    expect(screen.getByTestId("theme")).toHaveTextContent("slate-grey");
    expect(screen.getByTestId("error")).toHaveTextContent("");
    expect(screen.getByTestId("authoritative-state")).toHaveTextContent("ready");
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

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDefaultAppearanceSettings } from "../../theme/defaults";

const mocks = vi.hoisted(() => ({
  getCurrent: vi.fn(),
  saveFile: vi.fn(),
  close: vi.fn(),
  focusSource: vi.fn(),
  gitSummary: vi.fn(),
  start: vi.fn(),
  queueLocal: vi.fn(),
  flushNow: vi.fn(),
  markSaved: vi.fn(),
  dispose: vi.fn(),
  onCloseRequested: vi.fn(),
  listen: vi.fn(),
  dapSessionForTab: vi.fn(),
  unlistenClose: vi.fn(),
  registerShutdownTask: vi.fn(),
  installShutdownResponder: vi.fn(),
  shutdownTask: undefined as (() => Promise<void>) | undefined,
  closeRequestHandler: undefined as
    | ((event: { preventDefault: () => void }) => Promise<void>)
    | undefined,
  syncOptions: undefined as
    | {
        onSnapshot: (snapshot: unknown) => void;
        onRevision: (snapshot: unknown) => void;
        onStatus: (status: string, error?: string) => void;
      }
    | undefined,
  mode: "zed" as "zed" | "monaco",
  hydrated: true,
  appearanceState: "ready" as "pending" | "ready" | "failed",
  appearanceError: null as string | null,
  retryAppearance: vi.fn(),
  lint: vi.fn(),
  paneProps: null as Record<string, unknown> | null,
  appearanceSettings: { appTheme: "terminai-dark", editorTheme: "follow-app" } as any,
}));

vi.mock("../../lib/tauri", () => ({
  editorDetachedWindowGetCurrent: mocks.getCurrent,
  editorSaveFile: mocks.saveFile,
  editorDetachedWindowClose: mocks.close,
  editorSourceWindowFocus: mocks.focusSource,
  gitGetRepositorySummary: mocks.gitSummary,
  DAP_EVENT: "dap://event",
  dapSessionForTab: mocks.dapSessionForTab,
}));

vi.mock("./editorBufferSync", () => ({
  EditorBufferSyncClient: class {
    constructor(options: typeof mocks.syncOptions) {
      mocks.syncOptions = options;
    }
    start = mocks.start;
    queueLocal = mocks.queueLocal;
    flushNow = mocks.flushNow;
    markSaved = mocks.markSaved;
    dispose = mocks.dispose;
  },
}));

vi.mock("./ZedModeProvider", () => ({
  useZedMode: () => ({
    mode: mocks.mode,
    hydrated: mocks.hydrated,
    vimEnabled: false,
    setMode: vi.fn(),
    setVimEnabled: vi.fn(),
  }),
}));

vi.mock("../../theme/AppearanceProvider", () => ({
  useAppearance: () => ({
    authoritativeState: mocks.appearanceState,
    error: mocks.appearanceError,
    retryAuthoritativeSettings: mocks.retryAppearance,
    settings: mocks.appearanceSettings,
  }),
}));

vi.mock("../../hooks/useCiscoLint", () => ({
  useCiscoLint: mocks.lint,
}));

vi.mock("./EditorPane", () => ({
  EditorPane: (props: {
    buffer: { content: string };
    onChange: (content: string) => void;
  } & Record<string, unknown>) => {
    mocks.paneProps = props;
    return (
      <div data-testid="detached-editor-pane">
        <span data-testid="detached-content">{props.buffer.content}</span>
        <button onClick={() => props.onChange("changed locally")}>type</button>
      </div>
    );
  },
}));

vi.mock("../../hooks/useEditorSettings", () => ({
  useEditorSettings: () => ({
    settings: {
      fontSize: 14,
      tabSize: 2,
      wordWrap: "on",
      minimap: true,
      lineNumbers: true,
      renderWhitespace: false,
    },
  }),
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    close: mocks.close,
    onCloseRequested: mocks.onCloseRequested,
  }),
}));

vi.mock("@tauri-apps/api/event", () => ({
  emit: vi.fn().mockResolvedValue(undefined),
  listen: mocks.listen,
}));

vi.mock("../../lib/appShutdown", () => ({
  registerAppShutdownTask: mocks.registerShutdownTask,
  installAppShutdownResponder: mocks.installShutdownResponder,
}));

import { DetachedEditorWindow } from "./DetachedEditorWindow";

const metadata = {
  windowId: "editor-window-1",
  tabId: "editor-tab-1",
  paneId: "pane-1",
  bufferId: "file:/repo/a.ts",
  title: "a.ts",
  workspaceRoot: "/repo",
};

const authoritative = {
  bufferId: metadata.bufferId,
  filePath: "/repo/a.ts",
  content: "authoritative",
  language: "typescript",
  ciscoPlatform: "iosxe",
  dirty: true,
  revision: 4,
  sourceId: "main",
};

describe("DetachedEditorWindow", () => {
  beforeEach(() => {
    mocks.getCurrent.mockReset().mockResolvedValue(metadata);
    mocks.saveFile.mockReset().mockResolvedValue(undefined);
    mocks.close.mockReset().mockResolvedValue(undefined);
    mocks.focusSource.mockReset().mockResolvedValue(undefined);
    mocks.gitSummary.mockReset().mockResolvedValue(null);
    mocks.dapSessionForTab.mockReset().mockResolvedValue(null);
    mocks.listen.mockReset().mockResolvedValue(vi.fn());
    mocks.start.mockReset().mockImplementation(async () => {
      mocks.syncOptions?.onSnapshot(authoritative);
    });
    mocks.queueLocal.mockReset();
    mocks.flushNow.mockReset().mockResolvedValue(authoritative);
    mocks.markSaved.mockReset().mockImplementation(async () => {
      const saved = { ...authoritative, dirty: false, revision: 5 };
      mocks.syncOptions?.onSnapshot(saved);
      return saved;
    });
    mocks.dispose.mockReset();
    mocks.unlistenClose.mockReset();
    mocks.shutdownTask = undefined;
    mocks.registerShutdownTask
      .mockReset()
      .mockImplementation((_id: string, task: () => Promise<void>) => {
        mocks.shutdownTask = task;
        return vi.fn();
      });
    mocks.installShutdownResponder
      .mockReset()
      .mockResolvedValue(vi.fn());
    mocks.closeRequestHandler = undefined;
    mocks.onCloseRequested
      .mockReset()
      .mockImplementation(
        async (
          handler: (event: { preventDefault: () => void }) => Promise<void>,
        ) => {
          mocks.closeRequestHandler = handler;
          return mocks.unlistenClose;
        },
      );
    mocks.syncOptions = undefined;
    mocks.mode = "zed";
    mocks.hydrated = true;
    mocks.appearanceState = "ready";
    mocks.appearanceError = null;
    mocks.retryAppearance.mockReset().mockResolvedValue(undefined);
    mocks.lint.mockReset().mockReturnValue({
      diagnostics: [],
      structuralStatus: "ready",
      guardrails: { state: "ready", reason: null },
    });
    mocks.paneProps = null;
    mocks.appearanceSettings = createDefaultAppearanceSettings();
  });

  it("hydrates metadata and one authoritative editor pane", async () => {
    render(<DetachedEditorWindow />);

    expect(
      await screen.findByTestId("detached-editor-pane"),
    ).toBeInTheDocument();
    expect(screen.getByTestId("detached-content")).toHaveTextContent(
      "authoritative",
    );
    expect(screen.queryByText("Explorer")).not.toBeInTheDocument();
    expect(screen.queryByText("Terminal")).not.toBeInTheDocument();
    expect(mocks.start).toHaveBeenCalledWith({
      bufferId: metadata.bufferId,
      filePath: null,
      content: "",
      language: "plaintext",
      ciscoPlatform: null,
      dirty: false,
      sourceId: expect.stringMatching(/^editor-detached:/),
    });
    await waitFor(() =>
      expect(mocks.gitSummary).toHaveBeenCalledWith("/repo/a.ts"),
    );
  });

  it("publishes local edits and saves the exact synchronized revision", async () => {
    mocks.flushNow.mockResolvedValueOnce({
      ...authoritative,
      content: "changed locally",
      revision: 5,
    });
    render(<DetachedEditorWindow />);
    await screen.findByTestId("detached-editor-pane");

    fireEvent.click(screen.getByRole("button", { name: "type" }));
    expect(mocks.queueLocal).toHaveBeenCalledWith(
      "changed locally",
      "typescript",
      "iosxe",
      true,
    );
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(mocks.saveFile).toHaveBeenCalledWith(
        metadata.tabId,
        "/repo/a.ts",
        "changed locally",
      ),
    );
    expect(mocks.markSaved).toHaveBeenCalledWith(5);
    await waitFor(() =>
      expect(mocks.gitSummary.mock.calls.length).toBeGreaterThan(1),
    );
  });

  it("passes the synchronized Cisco profile and lint result to the detached pane", async () => {
    const diagnostics = [
      {
        line: 3,
        column: 2,
        endColumn: 8,
        severity: "warning" as const,
        message: "Captured prompt",
        source: "cisco-structural" as const,
        code: "cli-prompt",
      },
    ];
    mocks.lint.mockReturnValue({
      diagnostics,
      structuralStatus: "ready",
      guardrails: { state: "unavailable", reason: "classifier unavailable" },
    });
    mocks.start.mockImplementationOnce(async () => {
      mocks.syncOptions?.onSnapshot({
        ...authoritative,
        ciscoPlatform: "nxos",
      });
    });

    render(<DetachedEditorWindow />);
    await screen.findByTestId("detached-editor-pane");

    expect(mocks.lint).toHaveBeenLastCalledWith({
      content: "authoritative",
      platform: "nxos",
    });
    expect(mocks.paneProps).toMatchObject({
      ciscoPlatform: "nxos",
      ciscoDiagnostics: diagnostics,
      ciscoGuardrailStatus: {
        state: "unavailable",
        reason: "classifier unavailable",
      },
    });
  });

  it("writes the exact authoritative snapshot returned by the flush", async () => {
    mocks.flushNow.mockResolvedValueOnce({
      ...authoritative,
      content: "newer synchronized text",
      revision: 6,
    });
    render(<DetachedEditorWindow />);
    await screen.findByTestId("detached-editor-pane");
    fireEvent.click(screen.getByRole("button", { name: "type" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(mocks.saveFile).toHaveBeenCalledWith(
        metadata.tabId,
        "/repo/a.ts",
        "newer synchronized text",
      ),
    );
    expect(mocks.markSaved).toHaveBeenCalledWith(6);
  });

  it("focuses the source and brings the pane back", async () => {
    render(<DetachedEditorWindow />);
    await screen.findByTestId("detached-editor-pane");

    fireEvent.click(screen.getByRole("button", { name: "Focus Source" }));
    fireEvent.click(screen.getByRole("button", { name: "Bring Back" }));

    expect(mocks.focusSource).toHaveBeenCalledOnce();
    await waitFor(() => {
      expect(mocks.flushNow).toHaveBeenCalled();
      expect(mocks.close).toHaveBeenCalledWith(metadata.windowId);
    });
  });

  it("prevents native close until pending edits are flushed", async () => {
    render(<DetachedEditorWindow />);
    await screen.findByTestId("detached-editor-pane");
    fireEvent.click(screen.getByRole("button", { name: "type" }));
    const preventDefault = vi.fn();

    await mocks.closeRequestHandler?.({ preventDefault });

    expect(preventDefault).toHaveBeenCalledOnce();
    expect(mocks.flushNow).toHaveBeenCalled();
    expect(mocks.close).toHaveBeenCalledWith(metadata.windowId);
  });

  it("keeps the native window open when its pending edit cannot flush", async () => {
    mocks.flushNow.mockRejectedValueOnce(new Error("sync unavailable"));
    render(<DetachedEditorWindow />);
    await screen.findByTestId("detached-editor-pane");
    fireEvent.click(screen.getByRole("button", { name: "type" }));
    const preventDefault = vi.fn();

    await mocks.closeRequestHandler?.({ preventDefault });

    expect(preventDefault).toHaveBeenCalledOnce();
    expect(mocks.close).not.toHaveBeenCalled();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "sync unavailable",
    );
  });

  it("acknowledges app shutdown preparation only after its buffer flushes", async () => {
    let finishFlush!: () => void;
    mocks.flushNow.mockImplementationOnce(
      () =>
        new Promise<typeof authoritative>((resolve) => {
          finishFlush = () => resolve(authoritative);
        }),
    );
    render(<DetachedEditorWindow />);
    await screen.findByTestId("detached-editor-pane");

    let prepared = false;
    const pending = mocks.shutdownTask?.().then(() => {
      prepared = true;
    });
    await Promise.resolve();
    expect(prepared).toBe(false);

    finishFlush();
    await pending;
    expect(prepared).toBe(true);
  });

  it("renders a recoverable metadata error", async () => {
    mocks.getCurrent.mockRejectedValueOnce(new Error("metadata missing"));

    render(<DetachedEditorWindow />);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "metadata missing",
    );
    expect(
      screen.getByRole("button", { name: "Close Window" }),
    ).toBeInTheDocument();
  });

  it("closes after hydrated mode switches to classic", async () => {
    const view = render(<DetachedEditorWindow />);
    await screen.findByTestId("detached-editor-pane");
    mocks.mode = "monaco";
    view.rerender(<DetachedEditorWindow />);

    await waitFor(() =>
      expect(mocks.close).toHaveBeenCalledWith(metadata.windowId),
    );
  });

  it("waits for the authoritative appearance snapshot before mounting an interactive pane", async () => {
    mocks.appearanceState = "pending";
    const view = render(<DetachedEditorWindow />);
    expect(await screen.findByText("Loading editor appearance…")).toBeInTheDocument();
    expect(screen.queryByTestId("detached-editor-pane")).not.toBeInTheDocument();

    mocks.appearanceState = "ready";
    mocks.appearanceSettings = { ...createDefaultAppearanceSettings(), appTheme: "matrix" };
    view.rerender(<DetachedEditorWindow />);
    expect(await screen.findByTestId("detached-editor-pane")).toBeInTheDocument();
    expect(screen.getByTestId("detached-editor-window")).toHaveAttribute("data-editor-theme", "ccie-matrix");
  });

  it("waits for persisted Zed mode before creating an interactive Dark editor", async () => {
    mocks.appearanceState = "ready";
    mocks.appearanceSettings = {
      ...createDefaultAppearanceSettings(),
      appTheme: "terminai-dark",
      editorTheme: "follow-app",
    };
    mocks.mode = "monaco";
    mocks.hydrated = false;
    const view = render(<DetachedEditorWindow />);

    expect(await screen.findByText("Loading editor mode…")).toBeInTheDocument();
    expect(screen.queryByTestId("detached-editor-pane")).not.toBeInTheDocument();
    expect(screen.queryByTestId("detached-editor-window")).not.toBeInTheDocument();

    mocks.mode = "zed";
    mocks.hydrated = true;
    view.rerender(<DetachedEditorWindow />);

    expect(await screen.findByTestId("detached-editor-pane")).toBeInTheDocument();
    expect(screen.getByTestId("detached-editor-window")).toHaveAttribute(
      "data-editor-theme",
      "ccie-zed-one-dark",
    );
  });

  it("keeps the pane non-interactive after authoritative appearance failure and retries", async () => {
    mocks.appearanceState = "failed";
    mocks.appearanceError = "database unavailable";
    render(<DetachedEditorWindow />);
    expect(await screen.findByRole("alert")).toHaveTextContent("database unavailable");
    expect(screen.queryByTestId("detached-editor-pane")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry appearance" }));
    expect(mocks.retryAppearance).toHaveBeenCalledOnce();
  });

  it("uses an explicit editor override for the detached Monaco path", async () => {
    mocks.mode = "zed";
    mocks.appearanceSettings = { ...createDefaultAppearanceSettings(), appTheme: "matrix", editorTheme: "classic-dark" };
    render(<DetachedEditorWindow />);
    const window = await screen.findByTestId("detached-editor-window");
    expect(window).toHaveAttribute("data-editor-theme", "vs-dark");
  });
});

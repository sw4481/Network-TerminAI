import { act, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EditorMode } from "../../lib/tauri";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  set: vi.fn(),
  emit: vi.fn(),
  listen: vi.fn(),
  unlisten: vi.fn(),
}));

vi.mock("../../lib/tauri", () => ({
  editorModeGet: mocks.get,
  editorModeSet: mocks.set,
}));

vi.mock("@tauri-apps/api/event", () => ({
  emit: mocks.emit,
  listen: mocks.listen,
}));

import {
  ZED_MODE_CHANGED_EVENT,
  ZED_VIM_STORAGE_KEY,
  ZedModeProvider,
  useZedMode,
} from "./ZedModeProvider";
import type { ZedSnapshotRevision } from "./zedSnapshotRevision";

type Payload = {
  mode: EditorMode;
  vimEnabled: boolean;
  revision: ZedSnapshotRevision;
};
let deliverEvent: ((event: { payload: Payload }) => void) | undefined;
let chainedUpdate: Promise<void> | undefined;

function Probe() {
  const value = useZedMode();
  return (
    <>
      <output data-testid="mode">{value.mode}</output>
      <output data-testid="vim">{String(value.vimEnabled)}</output>
      <button onClick={() => void value.setMode("zed")}>zed</button>
      <button onClick={() => void value.setVimEnabled(true)}>vim</button>
      <button
        onClick={() => {
          chainedUpdate = (async () => {
            await value.setVimEnabled(true);
            await value.setMode("zed");
          })();
        }}
      >
        vim then zed
      </button>
    </>
  );
}

describe("ZedModeProvider", () => {
  beforeEach(() => {
    localStorage.clear();
    document.body.classList.remove("zed-mode");
    deliverEvent = undefined;
    chainedUpdate = undefined;
    mocks.get.mockReset().mockResolvedValue("monaco");
    mocks.set.mockReset().mockResolvedValue(undefined);
    mocks.emit.mockReset().mockResolvedValue(undefined);
    mocks.unlisten.mockReset();
    mocks.listen.mockReset().mockImplementation(
      async (_name: string, handler: (event: { payload: Payload }) => void) => {
        deliverEvent = handler;
        return mocks.unlisten;
      },
    );
  });

  it("hydrates persisted mode and applies the scoped body class", async () => {
    mocks.get.mockResolvedValueOnce("zed");
    render(<ZedModeProvider><Probe /></ZedModeProvider>);
    await waitFor(() => {
      expect(screen.getByTestId("mode")).toHaveTextContent("zed");
      expect(document.body).toHaveClass("zed-mode");
    });
  });

  it("persists and broadcasts a complete mode snapshot", async () => {
    render(<ZedModeProvider><Probe /></ZedModeProvider>);
    await waitFor(() => expect(mocks.get).toHaveBeenCalled());
    screen.getByRole("button", { name: "zed" }).click();
    await waitFor(() => expect(mocks.set).toHaveBeenCalledWith("zed"));
    expect(mocks.emit).toHaveBeenCalledWith(ZED_MODE_CHANGED_EVENT, {
      mode: "zed",
      vimEnabled: false,
      revision: {
        counter: 1,
        sourceId: expect.any(String),
      },
    });
  });

  it("broadcasts authoritative snapshots when setters share a context snapshot", async () => {
    render(<ZedModeProvider><Probe /></ZedModeProvider>);
    await waitFor(() => expect(mocks.get).toHaveBeenCalled());

    await act(async () => {
      screen.getByRole("button", { name: "vim then zed" }).click();
      await chainedUpdate;
    });

    expect(mocks.emit).toHaveBeenCalledTimes(2);
    expect(mocks.emit).toHaveBeenNthCalledWith(1, ZED_MODE_CHANGED_EVENT, {
      mode: "monaco",
      vimEnabled: true,
      revision: {
        counter: 1,
        sourceId: expect.any(String),
      },
    });
    expect(mocks.emit).toHaveBeenNthCalledWith(2, ZED_MODE_CHANGED_EVENT, {
      mode: "zed",
      vimEnabled: true,
      revision: {
        counter: 2,
        sourceId: expect.any(String),
      },
    });
  });

  it("applies cross-window events and persists the Vim preference", async () => {
    render(<ZedModeProvider><Probe /></ZedModeProvider>);
    await waitFor(() => expect(deliverEvent).toBeDefined());
    act(() => deliverEvent?.({
      payload: {
        mode: "zed",
        vimEnabled: true,
        revision: { counter: 4, sourceId: "remote-b" },
      },
    }));
    expect(screen.getByTestId("vim")).toHaveTextContent("true");
    expect(localStorage.getItem(ZED_VIM_STORAGE_KEY)).toBe("true");
  });

  it("does not let delayed hydration overwrite a live event", async () => {
    let resolveHydration: ((mode: EditorMode) => void) | undefined;
    mocks.get.mockReturnValueOnce(
      new Promise<EditorMode>((resolve) => {
        resolveHydration = resolve;
      }),
    );
    render(<ZedModeProvider><Probe /></ZedModeProvider>);
    await waitFor(() => expect(deliverEvent).toBeDefined());

    act(() => deliverEvent?.({
      payload: {
        mode: "zed",
        vimEnabled: true,
        revision: { counter: 3, sourceId: "remote-b" },
      },
    }));
    await act(async () => resolveHydration?.("monaco"));

    expect(screen.getByTestId("mode")).toHaveTextContent("zed");
    expect(screen.getByTestId("vim")).toHaveTextContent("true");
  });

  it("ignores delayed snapshots with an older revision", async () => {
    render(<ZedModeProvider><Probe /></ZedModeProvider>);
    await waitFor(() => expect(deliverEvent).toBeDefined());

    act(() => deliverEvent?.({
      payload: {
        mode: "zed",
        vimEnabled: true,
        revision: { counter: 8, sourceId: "remote-b" },
      },
    }));
    act(() => deliverEvent?.({
      payload: {
        mode: "monaco",
        vimEnabled: false,
        revision: { counter: 7, sourceId: "remote-z" },
      },
    }));

    expect(screen.getByTestId("mode")).toHaveTextContent("zed");
    expect(screen.getByTestId("vim")).toHaveTextContent("true");
  });

  it("converges equal counters with a deterministic source tie-break", async () => {
    render(<ZedModeProvider><Probe /></ZedModeProvider>);
    await waitFor(() => expect(deliverEvent).toBeDefined());

    act(() => deliverEvent?.({
      payload: {
        mode: "zed",
        vimEnabled: true,
        revision: { counter: 5, sourceId: "window-b" },
      },
    }));
    act(() => deliverEvent?.({
      payload: {
        mode: "monaco",
        vimEnabled: false,
        revision: { counter: 5, sourceId: "window-a" },
      },
    }));

    expect(screen.getByTestId("mode")).toHaveTextContent("zed");
    expect(screen.getByTestId("vim")).toHaveTextContent("true");
  });

  it("removes listeners and the body class on unmount", async () => {
    mocks.get.mockResolvedValueOnce("zed");
    const view = render(<ZedModeProvider><Probe /></ZedModeProvider>);
    await waitFor(() => expect(document.body).toHaveClass("zed-mode"));
    view.unmount();
    expect(mocks.unlisten).toHaveBeenCalledOnce();
    expect(document.body).not.toHaveClass("zed-mode");
  });

  it("unlistens when async subscription setup resolves after unmount", async () => {
    let resolveListen: ((unlisten: () => void) => void) | undefined;
    mocks.listen.mockReturnValueOnce(
      new Promise<() => void>((resolve) => {
        resolveListen = resolve;
      }),
    );
    const view = render(<ZedModeProvider><Probe /></ZedModeProvider>);

    view.unmount();
    await act(async () => resolveListen?.(mocks.unlisten));

    expect(mocks.unlisten).toHaveBeenCalledOnce();
  });
});

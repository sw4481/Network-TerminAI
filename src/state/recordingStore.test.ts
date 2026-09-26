import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the recording lib (Tauri invoke wrapper).
const startMock = vi.fn();
const stopMock = vi.fn();
const listMock = vi.fn();
vi.mock("../lib/recording", () => ({
  recording: {
    start: (tabId: string, kind?: string) => startMock(tabId, kind),
    stop: (tabId: string) => stopMock(tabId),
    list: (limit?: number) => listMock(limit),
  },
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

import { useRecordings } from "./recordingStore";

function dto(tabId: string) {
  return {
    id: `rec-${tabId}`,
    tabId, // backend echoes the id it was started with (the PTY id)
    startedAt: 0,
    endedAt: null,
    path: `/tmp/${tabId}.cast`,
    sizeBytes: 0,
    durationMs: 0,
    sessionKind: "local",
  };
}

beforeEach(() => {
  startMock.mockReset();
  stopMock.mockReset();
  listMock.mockReset();
  listMock.mockResolvedValue([]);
  useRecordings.setState({ active: {}, ptyToUiKey: {}, list: [] });
});

describe("recordingStore uiKey / ptyId split", () => {
  it("starts against the PTY id but keys active state by the UI tab id", async () => {
    // Split-pane case: tab id differs from the spawned PTY id.
    startMock.mockResolvedValue(dto("pty-9"));
    await useRecordings.getState().start("tab-1", "pty-9", "local");

    // Backend was called with the PTY id...
    expect(startMock).toHaveBeenCalledWith("pty-9", "local");
    // ...but the red-indicator state is keyed by the tab id.
    expect(useRecordings.getState().active["tab-1"]).toBeTruthy();
    expect(useRecordings.getState().active["pty-9"]).toBeUndefined();
  });

  it("stops using the PTY id recovered from the started dto, keyed by UI id", async () => {
    startMock.mockResolvedValue(dto("pty-9"));
    stopMock.mockResolvedValue({ ...dto("pty-9"), endedAt: 1 });

    await useRecordings.getState().start("tab-1", "pty-9", "local");
    await useRecordings.getState().stop("tab-1");

    // Stop must target the backend PTY id, not the UI tab id.
    expect(stopMock).toHaveBeenCalledWith("pty-9");
    expect(useRecordings.getState().active["tab-1"]).toBeUndefined();
    expect(useRecordings.getState().ptyToUiKey["pty-9"]).toBeUndefined();
  });

  it("toggle starts then stops the same UI key", async () => {
    startMock.mockResolvedValue(dto("pty-9"));
    stopMock.mockResolvedValue({ ...dto("pty-9"), endedAt: 1 });

    await useRecordings.getState().toggle("tab-1", "pty-9", "local");
    expect(startMock).toHaveBeenCalledTimes(1);

    await useRecordings.getState().toggle("tab-1", "pty-9", "local");
    expect(stopMock).toHaveBeenCalledTimes(1);
  });

  it("single-pane tab where uiKey === ptyId still works", async () => {
    startMock.mockResolvedValue(dto("tab-1"));
    await useRecordings.getState().start("tab-1", "tab-1", "local");
    expect(useRecordings.getState().active["tab-1"]).toBeTruthy();
  });
});

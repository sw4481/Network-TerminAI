import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { useFanoutShortcuts } from "./useFanoutShortcuts";
import { useFanoutRunsStore } from "../state/fanoutRunsStore";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => {}),
}));
import { invoke } from "@tauri-apps/api/core";
const mockInvoke = invoke as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockInvoke.mockReset();
  useFanoutRunsStore.setState({
    activeRunsById: {},
    selectedRunId: null,
    selectedTab: "merged",
  });
});

describe("useFanoutShortcuts", () => {
  it("invokes onOpenFanout for ⌘⇧F", () => {
    const onOpen = vi.fn();
    renderHook(() => useFanoutShortcuts({ onOpenFanout: onOpen }));
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "F", metaKey: true, shiftKey: true }),
    );
    expect(onOpen).toHaveBeenCalled();
  });

  it("cancels active run on ⌘.", async () => {
    useFanoutRunsStore.setState({
      activeRunsById: {
        r1: {
          runId: "r1",
          command: "x",
          groupId: null,
          startedAt: 0,
          status: "running",
          totalDevices: 1,
          devices: {},
        },
      },
      selectedRunId: "r1",
      selectedTab: "merged",
    });
    renderHook(() => useFanoutShortcuts({}));
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: ".", metaKey: true }),
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(mockInvoke).toHaveBeenCalledWith("fanout_run_cancel", {
      runId: "r1",
    });
  });

  it("retries every failed device on ⌘R", async () => {
    useFanoutRunsStore.setState({
      activeRunsById: {
        r1: {
          runId: "r1",
          command: "x",
          groupId: null,
          startedAt: 0,
          status: "partial",
          totalDevices: 2,
          devices: {
            "ssh:d1": {
              deviceId: "d1",
              deviceKind: "ssh",
              displayName: "r1",
              status: "failed",
              attempt: 1,
              progressBytes: 0,
            },
            "ssh:d2": {
              deviceId: "d2",
              deviceKind: "ssh",
              displayName: "r2",
              status: "success",
              attempt: 1,
              progressBytes: 0,
            },
          },
        },
      },
      selectedRunId: "r1",
      selectedTab: "merged",
    });
    renderHook(() => useFanoutShortcuts({}));
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "r", metaKey: true }),
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(mockInvoke).toHaveBeenCalledTimes(1);
    expect(mockInvoke).toHaveBeenCalledWith("fanout_device_retry", {
      runId: "r1",
      deviceId: "d1",
      deviceKind: "ssh",
    });
  });

  it("calls onExport on ⌘E", () => {
    useFanoutRunsStore.setState({
      activeRunsById: {
        r1: {
          runId: "r1",
          command: "x",
          groupId: null,
          startedAt: 0,
          status: "success",
          totalDevices: 1,
          devices: {},
        },
      },
      selectedRunId: "r1",
      selectedTab: "merged",
    });
    const onExport = vi.fn();
    renderHook(() => useFanoutShortcuts({ onExport }));
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "e", metaKey: true }),
    );
    expect(onExport).toHaveBeenCalled();
  });
});

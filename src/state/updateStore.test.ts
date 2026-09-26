import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock the Tauri plugins before importing the store.
const checkMock = vi.fn();
const relaunchMock = vi.fn(async () => {});
vi.mock("@tauri-apps/plugin-updater", () => ({
  check: () => checkMock(),
}));
vi.mock("@tauri-apps/plugin-process", () => ({
  relaunch: () => relaunchMock(),
}));

import { useUpdateStore } from "./updateStore";

const resetStore = () =>
  useUpdateStore.setState({
    available: null,
    checking: false,
    downloading: false,
    dismissed: false,
    error: null,
    lastCheckedAt: null,
    _handle: null,
  });

describe("updateStore", () => {
  beforeEach(() => {
    resetStore();
    vi.clearAllMocks();
  });

  it("populates `available` when an update is found", async () => {
    checkMock.mockResolvedValueOnce({
      version: "1.1.0",
      currentVersion: "1.0.0",
      date: "2026-07-22",
      body: "Bug fixes",
      downloadAndInstall: vi.fn(async () => {}),
    });

    await useUpdateStore.getState().checkForUpdate(false);

    const s = useUpdateStore.getState();
    expect(s.available).toEqual({
      version: "1.1.0",
      currentVersion: "1.0.0",
      date: "2026-07-22",
      body: "Bug fixes",
    });
    expect(s.checking).toBe(false);
    expect(s.lastCheckedAt).not.toBeNull();
  });

  it("leaves `available` null when up to date", async () => {
    checkMock.mockResolvedValueOnce(null);

    await useUpdateStore.getState().checkForUpdate(false);

    const s = useUpdateStore.getState();
    expect(s.available).toBeNull();
    expect(s.lastCheckedAt).not.toBeNull();
  });

  it("swallows check errors for automatic checks but surfaces them for manual", async () => {
    checkMock.mockRejectedValueOnce(new Error("network down"));
    await useUpdateStore.getState().checkForUpdate(false);
    expect(useUpdateStore.getState().error).toBeNull();

    checkMock.mockRejectedValueOnce(new Error("network down"));
    await useUpdateStore.getState().checkForUpdate(true);
    expect(useUpdateStore.getState().error).toBe("network down");
  });

  it("downloads, installs, and relaunches using the held handle", async () => {
    const downloadAndInstall = vi.fn(async () => {});
    checkMock.mockResolvedValueOnce({
      version: "1.1.0",
      currentVersion: "1.0.0",
      downloadAndInstall,
    });

    await useUpdateStore.getState().checkForUpdate(false);
    await useUpdateStore.getState().downloadAndInstall();

    expect(downloadAndInstall).toHaveBeenCalledTimes(1);
    expect(relaunchMock).toHaveBeenCalledTimes(1);
    // check() called once (during checkForUpdate); install reused the handle.
    expect(checkMock).toHaveBeenCalledTimes(1);
  });

  it("dismiss() hides the toast without clearing availability", async () => {
    checkMock.mockResolvedValueOnce({
      version: "1.1.0",
      currentVersion: "1.0.0",
      downloadAndInstall: vi.fn(),
    });
    await useUpdateStore.getState().checkForUpdate(false);

    useUpdateStore.getState().dismiss();

    expect(useUpdateStore.getState().dismissed).toBe(true);
    expect(useUpdateStore.getState().available).not.toBeNull();
  });
});
